"""Private ComfyUI lifecycle for reviewed, per-activity illustrative images.

The installed image/runtime files are provisioned and pinned by setup. This
module downloads nothing, does not unload Ollama and never logs activity text.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid


MODEL_FILE = "sd_xl_base_1.0.safetensors"
SIZE = 1024
MAX_STEP_LENGTH = 500
NEGATIVE = "text, letters, numbers, watermark, logo, blurry, unsafe tools, photorealistic children"
STYLE = "Simple clear educational illustration of the described materials and action, plain background."
_benchmark_module = None
_benchmark_lock = threading.Lock()


class EngineError(RuntimeError):
    def __init__(self, code: str, message: str, *, cleanup_failed: bool = False):
        super().__init__(message)
        self.code = code
        self.cleanup_failed = cleanup_failed


def benchmark_helpers():
    """Load the existing validated helpers without relying on embedded sys.path."""
    global _benchmark_module
    with _benchmark_lock:
        if _benchmark_module is None:
            path = Path(__file__).resolve().with_name("run-activity-images.py")
            try:
                spec = importlib.util.spec_from_file_location("skao_image_benchmark_helpers", path)
                if spec is None or spec.loader is None:
                    raise ValueError("missing helper loader")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            except Exception as error:
                raise EngineError("IMAGE_RUNTIME", "The managed image runtime tools are unavailable.") from error
            _benchmark_module = module
        return _benchmark_module


def plain_text(value, limit: int) -> bool:
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= limit
            and not re.search(r"[\x00-\x1f\x7f]|<[^>]*>|https?://|www\.|data:|javascript:|!\[|\]\(", value, re.I))


def validate_activity(name, steps):
    if (not plain_text(name, 100) or not isinstance(steps, list) or not 1 <= len(steps) <= 6
            or any(not plain_text(step, MAX_STEP_LENGTH) for step in steps)):
        raise EngineError("IMAGE_INPUT", "Use an activity name and one to six short, plain-text steps.")
    return name.strip(), [step.strip() for step in steps]


def build_activity_workflow(name: str, step_text: str, prefix: str) -> dict:
    """Use the actual step as scene context; no fixed reference activity is used."""
    validate_activity(name, [step_text])
    if not isinstance(prefix, str) or not re.fullmatch(r"skao_media_[a-z0-9_]{1,80}", prefix):
        raise EngineError("IMAGE_INPUT", "The internal image filename is invalid.")
    positive = step_text.strip() + " Activity: " + name.strip() + ". " + STYLE
    def conditioning(text):
        return {"class_type": "CLIPTextEncodeSDXL", "inputs": {
            "clip": ["4", 1], "width": SIZE, "height": SIZE, "crop_w": 0, "crop_h": 0,
            "target_width": SIZE, "target_height": SIZE, "text_g": text, "text_l": text}}
    return {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": 483031927, "steps": 20, "cfg": 7.0, "sampler_name": "euler", "scheduler": "normal",
            "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": MODEL_FILE}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": SIZE, "height": SIZE, "batch_size": 1}},
        "6": conditioning(positive), "7": conditioning(NEGATIVE),
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": prefix, "images": ["8", 0]}},
    }


def ordinary_path(path: Path, *, directory: bool = False):
    path = Path(path).absolute()
    for entry in reversed((path, *path.parents)):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise OSError("linked or reparse path")
        check = stat.S_ISDIR if entry != path or directory else stat.S_ISREG
        if not check(info.st_mode):
            raise OSError("unexpected path type")


class ProcessJob:
    """An unnamed Windows job whose last handle closes on worker termination."""
    def __init__(self):
        self.handle = None
        self.kernel = None

    def attach(self, process):
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes
        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                          "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel = kernel
        self.handle = kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("Could not create the owned image process job")
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (not kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits))
                or not kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(process._handle)))):
            raise OSError("Could not contain the owned image process")

    def close(self):
        if self.handle is not None:
            handle, self.handle = self.handle, None
            if not self.kernel.CloseHandle(handle):
                raise OSError("Could not close the owned image process job")


class GenericEngine:
    def __init__(self, image_root: Path, startup_timeout: float = 180, image_timeout: float = 900):
        self.image_root = Path(image_root).absolute()
        self.runtime = self.image_root / "runtime" / "ComfyUI_windows_portable"
        self.startup_timeout = startup_timeout
        self.image_timeout = image_timeout

    def available(self) -> bool:
        """Filesystem metadata only; never imports CUDA, launches or writes files."""
        try:
            ordinary_path(self.runtime, directory=True)
            for path in (self.runtime / "python_embeded" / "python.exe", self.runtime / "ComfyUI" / "main.py",
                         self.runtime / "ComfyUI" / "models" / "checkpoints" / MODEL_FILE,
                         Path(__file__).absolute().with_name("run-activity-images.py")):
                ordinary_path(path)
            return True
        except OSError:
            return False

    @staticmethod
    def _cancelled(cancel):
        if cancel.is_set():
            raise EngineError("CANCELLED", "Image generation was cancelled.")

    def _wait_for_image(self, client, prompt_id, deadline, process, cancel):
        if not isinstance(prompt_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,100}", prompt_id):
            raise EngineError("IMAGE_RESPONSE", "The image process returned an invalid job response.")
        while time.monotonic() < deadline:
            self._cancelled(cancel)
            if process.poll() is not None:
                raise EngineError("IMAGE_PROCESS", "The image process stopped before finishing.")
            history = client.request("/history/" + prompt_id, timeout=min(5, max(0.1, deadline - time.monotonic())))
            entry = history.get(prompt_id)
            if entry is not None:
                if not isinstance(entry, dict) or not isinstance(entry.get("status"), dict):
                    raise EngineError("IMAGE_RESPONSE", "The image process returned an invalid status.")
                status = entry["status"]
                if status.get("status_str") in ("error", "interrupted"):
                    raise EngineError("IMAGE_GENERATION", "The image could not be generated.")
                if status.get("completed") is True:
                    if status.get("status_str") != "success":
                        raise EngineError("IMAGE_GENERATION", "The image could not be generated.")
                    outputs = entry.get("outputs", {})
                    images = outputs.get("9", {}).get("images") if isinstance(outputs, dict) else None
                    if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
                        raise EngineError("IMAGE_RESPONSE", "The image process did not produce exactly one frame.")
                    return images[0]
            cancel.wait(min(0.2, max(0, deadline - time.monotonic())))
        raise EngineError("IMAGE_TIMEOUT", "Image generation exceeded its time limit.")

    def generate(self, name: str, steps: list[str], directory: Path, cancel: threading.Event, on_frame=None) -> list[dict]:
        name, steps = validate_activity(name, steps)
        self._cancelled(cancel)
        if not self.available():
            raise EngineError("IMAGE_UNAVAILABLE", "The managed SDXL image runtime is unavailable.")
        directory = Path(directory).absolute()
        try:
            ordinary_path(directory, directory=True)
            if any((directory / f"step-{step}.png").exists() or (directory / f"step-{step}.png").is_symlink() for step in range(1, 7)):
                raise OSError("existing job outputs")
        except OSError as error:
            raise EngineError("IMAGE_DIRECTORY", "The private image job directory is unavailable.") from error
        helpers = benchmark_helpers()
        process, containment = None, ProcessJob()
        frames = []
        try:
            loaded = helpers.LocalJsonClient("http://127.0.0.1:11434").request("/api/ps", timeout=5)
            if not isinstance(loaded.get("models"), list):
                raise EngineError("IMAGE_UNAVAILABLE", "The local text model status is unavailable.")
            if loaded["models"]:
                raise EngineError("AI_BUSY", "A text model is in use. Try the images again shortly.")
            self._cancelled(cancel)
            python = self.runtime / "python_embeded" / "python.exe"
            main = self.runtime / "ComfyUI" / "main.py"
            environment = helpers.offline_environment()
            help_result = subprocess.run([str(python), "-s", str(main), "--help"], cwd=self.runtime,
                                         stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=45, env=environment)
            if help_result.returncode != 0 or any(flag not in help_result.stdout for flag in helpers.REQUIRED_FLAGS):
                raise EngineError("IMAGE_RUNTIME", "The managed image runtime has incompatible launch options.")
            self._cancelled(cancel)
            raw = directory / "raw"
            raw.mkdir()
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            marker = directory / "startup-ready.signal"
            flags = ["--listen", "127.0.0.1", "--port", str(port), "--disable-auto-launch", "--disable-all-custom-nodes",
                     "--offline", "--disable-metadata", "--disable-assets", "--output-directory", str(raw), "--cpu-vae", "--preview-method", "none"]
            command = helpers.build_startup_command(python, main, flags, marker)
            creationflags = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.BELOW_NORMAL_PRIORITY_CLASS | subprocess.CREATE_NO_WINDOW) if os.name == "nt" else 0
            process = subprocess.Popen(command, cwd=self.runtime, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, env=environment, creationflags=creationflags)
            try:
                containment.attach(process)
            except OSError as error:
                raise EngineError("IMAGE_CONTAINMENT", "The image process could not be safely contained.") from error
            client = helpers.LocalJsonClient(f"http://127.0.0.1:{port}")
            deadline = time.monotonic() + self.startup_timeout
            ready = None
            while time.monotonic() < deadline:
                self._cancelled(cancel)
                if process.poll() is not None:
                    raise EngineError("IMAGE_PROCESS", "The image process could not start.")
                try:
                    ready = client.request("/system_stats", timeout=min(3, max(0.1, deadline - time.monotonic())))
                    break
                except helpers.BenchmarkFailure as error:
                    if error.code != "LOCAL_HTTP":
                        raise
                    cancel.wait(0.2)
            if ready is None:
                raise EngineError("IMAGE_STARTUP_TIMEOUT", "The image process did not become ready in time.")
            devices = ready.get("devices")
            if not isinstance(devices, list) or not any(isinstance(device, dict) and device.get("type") == "cuda" for device in devices):
                raise EngineError("IMAGE_CUDA", "The image process could not use its NVIDIA GPU.")
            marker.touch(exist_ok=False)
            token = uuid.uuid4().hex[:16]
            for index, step in enumerate(steps, 1):
                self._cancelled(cancel)
                prefix = f"skao_media_{token}_step{index}"
                queued = client.request("/prompt", {"prompt": build_activity_workflow(name, step, prefix)}, timeout=10)
                if queued.get("node_errors") or "error" in queued:
                    raise EngineError("IMAGE_WORKFLOW", "The image process could not accept these illustrations.")
                image = self._wait_for_image(client, queued.get("prompt_id"), time.monotonic() + self.image_timeout, process, cancel)
                self._cancelled(cancel)
                target = directory / f"step-{index}.png"
                helpers.validate_and_copy_image(raw, image, prefix, target, SIZE)
                (raw / image["filename"]).unlink()
                data = target.read_bytes()
                frame = {"step": index, "sha256": hashlib.sha256(data).hexdigest(), "width": SIZE, "height": SIZE, "byteLength": len(data)}
                frames.append(frame)
                if on_frame is not None:
                    on_frame(dict(frame))
            return frames
        except EngineError:
            raise
        except Exception as error:
            raise EngineError("IMAGE_GENERATION", "The local image job could not complete.") from error
        finally:
            cleanup_ok = True
            try:
                containment.close()
            except OSError:
                cleanup_ok = False
            if process is not None:
                try:
                    if process.poll() is None:
                        try:
                            process.terminate()
                        except OSError:
                            pass
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    cleanup_ok = cleanup_ok and process.poll() is not None
                except (OSError, subprocess.SubprocessError):
                    cleanup_ok = False
            if not cleanup_ok:
                raise EngineError("PROCESS_CLEANUP", "Stopping the owned image process could not be confirmed.", cleanup_failed=True)
