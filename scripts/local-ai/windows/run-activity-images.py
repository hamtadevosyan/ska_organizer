#!/usr/bin/env python3
"""Run a synthetic, local SD1.5 or SDXL Base benchmark using verified ComfyUI.

This is an attended hardware test, not an Organizer background worker. It never
unloads Ollama models, stops existing tasks, or changes firewall/gateway settings.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import uuid
import zlib


MODEL_NAME = "v1-5-pruned-emaonly.safetensors"
SDXL_MODEL_NAME = "sd_xl_base_1.0.safetensors"
CONTROLNET_NAME = "control-lora-canny-rank128.safetensors"
GUIDANCE_NODE_INPUTS = {
    "LoadImage": frozenset(("image",)),
    "VAEEncode": frozenset(("pixels", "vae")),
    "Canny": frozenset(("image", "low_threshold", "high_threshold")),
    "ControlNetLoader": frozenset(("control_net_name",)),
    "ControlNetApplyAdvanced": frozenset(("positive", "negative", "control_net", "image", "strength", "start_percent", "end_percent", "vae")),
}
MODEL_PROFILES = {
    MODEL_NAME: {"label": "SD1.5", "slug": "sd15", "expectedSize": 512},
    SDXL_MODEL_NAME: {"label": "SDXL Base", "slug": "sdxl", "expectedSize": 1024},
}
MAX_JSON_BYTES = 262_144
MAX_IMAGE_BYTES = 8 * 1024 * 1024
REQUIRED_FLAGS = (
    "--listen", "--port", "--disable-auto-launch", "--disable-all-custom-nodes",
    "--offline", "--disable-metadata", "--disable-assets", "--output-directory",
    "--cpu-vae", "--preview-method",
)
CAPTIONS = (
    "Put the large red, blue and yellow blocks on the table.",
    "Sort the blocks into groups of the same color.",
    "Stack three blocks to make one small tower.",
    "Put all six blocks in the storage box.",
)
SCENES = (
    "Six large toy blocks, two red cubes, two blue cubes and two yellow cubes, spread apart on the table.",
    "Six large toy blocks sorted into three clearly separated pairs: two red cubes together, two blue cubes together and two yellow cubes together.",
    "One small tower made of three large toy cubes, a red cube at the bottom, a blue cube in the middle and a yellow cube on top. Three spare cubes lie beside the tower.",
    "All six large toy cubes, two red cubes, two blue cubes and two yellow cubes, inside one open plain storage box on the table. No blocks outside the box and no tower.",
)
STYLE = (
    "Simple clear educational illustration of large colored wooden toy cubes on a plain cream tabletop, "
    "viewed from above at a slight angle, consistent red blue and yellow colors, soft even lighting, "
    "plain background, no people, no hands, no writing, no labels, no numbers. "
)
SIMPLE_SCENES = (
    "Six large wooden toy cubes spread apart on a table: two red, two blue, two yellow.",
    "Six large wooden toy cubes sorted into three separate pairs: two red together, two blue together, two yellow together.",
    "A vertical tower of three wooden cubes: red bottom, blue middle, yellow top. Three spare cubes beside the tower: one red, one blue, one yellow.",
    "Six large wooden toy cubes inside one open storage box: two red, two blue, two yellow.",
)
SIMPLE_STYLE = "Simple educational diagram, plain cream background."
NEGATIVE = "text, letters, numbers, watermark, logo, people, hands, fingers, tiny objects, clutter, photorealistic children, blurry"
STARTUP_TRACE_SECONDS = 60
STARTUP_BOOTSTRAP = r'''
import faulthandler
import os
import sys

main_path = os.path.abspath(sys.argv[1])
ready_path = sys.argv[2]
trace_seconds = float(sys.argv[3])
sys.argv = [main_path] + sys.argv[4:]
sys.path.insert(0, os.path.dirname(main_path))
faulthandler.enable(file=sys.stderr, all_threads=True)
faulthandler.dump_traceback_later(trace_seconds, repeat=True, file=sys.stderr, exit=False)
print("SKAO startup: preloading PyAV before ComfyUI", flush=True)
import av
print("SKAO startup: PyAV " + str(getattr(av, "__version__", "unknown"))[:100] + " loaded", flush=True)

# Import PyAV before creating a Python watcher thread. The native faulthandler
# timer above can still diagnose a blocked preload without terminating it.
import threading
import time
import runpy

def stop_startup_traces_when_ready():
    while True:
        if os.path.isfile(ready_path):
            faulthandler.cancel_dump_traceback_later()
            print("SKAO startup: CUDA readiness confirmed; startup stack timer stopped", flush=True)
            return
        time.sleep(0.05)

threading.Thread(target=stop_startup_traces_when_ready, name="skao-startup-ready", daemon=True).start()
print("SKAO startup: entering ComfyUI", flush=True)
try:
    runpy.run_path(main_path, run_name="__main__")
finally:
    faulthandler.cancel_dump_traceback_later()
'''


class BenchmarkFailure(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def build_startup_command(python, main, flags, ready_path, trace_delay=STARTUP_TRACE_SECONDS):
    """Preload PyAV and arm startup diagnostics without changing ComfyUI files."""
    if not 0 < trace_delay <= 300:
        raise ValueError("The startup trace interval must be positive and at most 300 seconds.")
    return [str(python), "-u", "-s", "-c", STARTUP_BOOTSTRAP, str(main),
            str(ready_path), str(trace_delay), *flags]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BenchmarkFailure("HTTP_REDIRECT", "The local service returned an unexpected redirect.")


class LocalJsonClient:
    """A bounded, proxy-free client that accepts only literal loopback HTTP."""
    def __init__(self, base: str):
        parts = urlsplit(base)
        if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or parts.username
                or parts.password or parts.query or parts.fragment or parts.path not in ("", "/")):
            raise BenchmarkFailure("LOCAL_ADDRESS", "Only literal loopback HTTP is permitted for this test.")
        if not parts.port:
            raise BenchmarkFailure("LOCAL_ADDRESS", "The local service must use an explicit port.")
        self.base = base.rstrip("/")
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, path: str, payload=None, timeout: float = 10):
        if not path.startswith("/") or path.startswith("//") or "\\" in path:
            raise BenchmarkFailure("LOCAL_PATH", "The local request path is invalid.")
        body = None if payload is None else json.dumps(payload, ensure_ascii=True).encode("ascii")
        if body is not None and len(body) > MAX_JSON_BYTES:
            raise BenchmarkFailure("REQUEST_SIZE", "The synthetic request exceeded its size limit.")
        request = Request(self.base + path, data=body, headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=max(0.1, timeout)) as response:
                raw = response.read(MAX_JSON_BYTES + 1)
                if len(raw) > MAX_JSON_BYTES:
                    raise BenchmarkFailure("RESPONSE_SIZE", "The local response exceeded its size limit.")
                value = json.loads(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise BenchmarkFailure("RESPONSE_SHAPE", "The local response was not a JSON object.")
                return value
        except BenchmarkFailure:
            raise
        except (HTTPError, URLError, OSError, ValueError, UnicodeError) as error:
            raise BenchmarkFailure("LOCAL_HTTP", "The local service did not return a usable response.") from error


def positive_prompt(step: int, simple_prompts: bool = False) -> str:
    return SIMPLE_SCENES[step] + " " + SIMPLE_STYLE if simple_prompts else STYLE + SCENES[step]


def build_workflow(model: str, step: int, prefix: str, simple_prompts: bool = False, guided_layout: bool = False) -> dict:
    profile = MODEL_PROFILES.get(model)
    if (profile is None or step not in range(4) or not isinstance(prefix, str)
            or not re.fullmatch("skao_" + profile["slug"] + r"_[a-z0-9_]+", prefix)
            or (guided_layout and model != SDXL_MODEL_NAME)):
        raise BenchmarkFailure("WORKFLOW", "The requested synthetic workflow is invalid.")
    size = profile["expectedSize"]
    def conditioning(text):
        if model == SDXL_MODEL_NAME:
            # Verified against the pinned ComfyUI v0.43.0 core SDXL node schema.
            return {"class_type": "CLIPTextEncodeSDXL", "inputs": {
                "clip": ["4", 1], "width": size, "height": size, "crop_w": 0, "crop_h": 0,
                "target_width": size, "target_height": size, "text_g": text, "text_l": text}}
        return {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["4", 1]}}
    workflow = {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": 482_031_927, "steps": 20, "cfg": 7.0, "sampler_name": "euler",
            "scheduler": "normal", "denoise": 1.0, "model": ["4", 0],
            "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": size, "height": size, "batch_size": 1}},
        "6": conditioning(positive_prompt(step, simple_prompts or guided_layout)),
        "7": conditioning(NEGATIVE),
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": prefix, "images": ["8", 0]}},
    }
    if guided_layout:
        del workflow["5"]
        workflow["3"]["inputs"].update({"denoise": 0.55, "positive": ["14", 0], "negative": ["14", 1], "latent_image": ["11", 0]})
        workflow.update({
            "10": {"class_type": "LoadImage", "inputs": {"image": f"layout-step-{step + 1}.png"}},
            "11": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["4", 2]}},
            "12": {"class_type": "Canny", "inputs": {"image": ["10", 0], "low_threshold": 0.4, "high_threshold": 0.8}},
            "13": {"class_type": "ControlNetLoader", "inputs": {"control_net_name": CONTROLNET_NAME}},
            "14": {"class_type": "ControlNetApplyAdvanced", "inputs": {
                "positive": ["6", 0], "negative": ["7", 0], "control_net": ["13", 0], "image": ["12", 0],
                "strength": 0.8, "start_percent": 0.0, "end_percent": 1.0, "vae": ["4", 2]}},
        })
    return workflow


def assert_guidance_nodes(client):
    """Inspect only the five fixed built-in schemas, retaining the JSON bound."""
    for node, expected_inputs in GUIDANCE_NODE_INPUTS.items():
        try:
            info = client.request("/object_info/" + node, timeout=10).get(node)
            schema = info.get("input") if isinstance(info, dict) else None
            required = schema.get("required", {}) if isinstance(schema, dict) else None
            optional = schema.get("optional", {}) if isinstance(schema, dict) else None
            if (not isinstance(required, dict) or not isinstance(optional, dict)
                    or not expected_inputs.issubset(required.keys() | optional.keys())):
                raise ValueError("incompatible guidance input schema")
        except (BenchmarkFailure, ValueError) as error:
            raise BenchmarkFailure("GUIDANCE_NODES", "Required built-in guidance node " + node + " is unavailable or incompatible. Review the local runtime log.") from error


def wait_for_image(client, prompt_id: str, deadline: float, process) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", prompt_id):
        raise BenchmarkFailure("PROMPT_ID", "The image service returned an invalid job identifier.")
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BenchmarkFailure("PROCESS_EXIT", "The image process stopped before the image was ready.")
        history = client.request("/history/" + quote(prompt_id, safe=""), timeout=min(10, max(0.1, deadline - time.monotonic())))
        entry = history.get(prompt_id)
        if entry is not None:
            if not isinstance(entry, dict):
                raise BenchmarkFailure("HISTORY", "The image history was invalid.")
            status = entry.get("status", {})
            if not isinstance(status, dict):
                raise BenchmarkFailure("HISTORY", "The image status was invalid.")
            if status.get("status_str") in ("error", "interrupted"):
                raise BenchmarkFailure("GENERATION_FAILED", "The image could not be generated. See the local runtime log.")
            if status.get("completed") is True:
                if status.get("status_str") != "success":
                    raise BenchmarkFailure("GENERATION_FAILED", "The image job did not complete successfully.")
                outputs = entry.get("outputs", {})
                images = outputs.get("9", {}).get("images") if isinstance(outputs, dict) else None
                if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
                    raise BenchmarkFailure("IMAGE_COUNT", "The image job did not produce exactly one image.")
                return images[0]
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    raise BenchmarkFailure("GENERATION_TIMEOUT", "The image test reached its time limit.")


def sanitize_png(data: bytes, expected_size: int = 512) -> bytes:
    """Validate a bounded profile-sized RGB(A) PNG and retain pixel chunks.

    The benchmark's fixed SaveImage node produces non-interlaced 8-bit RGB PNGs.
    Rejecting other layouts also bounds decompression without a graphics package.
    """
    if type(expected_size) is not int or expected_size not in (512, 1024):
        raise BenchmarkFailure("IMAGE_FORMAT", "The expected image size was not a supported model profile.")
    signature = b"\x89PNG\r\n\x1a\n"
    if not data.startswith(signature) or len(data) > MAX_IMAGE_BYTES:
        raise BenchmarkFailure("IMAGE_FORMAT", "The generated file was not a bounded PNG image.")
    offset, chunks, image_data = 8, [], bytearray()
    header = None
    ended = False
    for _ in range(10_000):
        if offset + 12 > len(data):
            break
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        end = offset + length + 12
        if end > len(data) or not all(65 <= character <= 90 or 97 <= character <= 122 for character in kind):
            raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG contained an invalid chunk.")
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack(">I", data[offset + 8 + length:end])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != crc:
            raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG failed its integrity check.")
        if header is None and kind != b"IHDR":
            raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG header was missing.")
        if kind == b"IHDR":
            if header is not None or length != 13:
                raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG header was invalid.")
            header = struct.unpack(">IIBBBBB", payload)
            if header[:3] != (expected_size, expected_size, 8) or header[3] not in (2, 6) or header[4:] != (0, 0, 0):
                raise BenchmarkFailure("IMAGE_FORMAT", f"The generated image did not have the expected {expected_size} by {expected_size} RGB format.")
            chunks.append(data[offset:end])
        elif kind == b"IDAT":
            image_data.extend(payload)
            chunks.append(data[offset:end])
        elif kind == b"IEND":
            if length or end != len(data):
                raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG ending was invalid.")
            chunks.append(data[offset:end])
            ended = True
            break
        elif kind in (b"acTL", b"fcTL", b"fdAT") or not kind[0] & 32:
            raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG used an unexpected image layout.")
        # Ancillary chunks, including all prompt/workflow metadata, are omitted.
        offset = end
    if not ended or not image_data or header is None:
        raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG was incomplete.")
    row_bytes = expected_size * (3 if header[3] == 2 else 4) + 1
    expected = row_bytes * expected_size
    try:
        decompressor = zlib.decompressobj()
        pixels = decompressor.decompress(image_data, expected + 1)
        if (len(pixels) != expected or not decompressor.eof or decompressor.unused_data
                or decompressor.unconsumed_tail or any(pixels[row] > 4 for row in range(0, expected, row_bytes))):
            raise ValueError("invalid scanlines")
    except (zlib.error, ValueError) as error:
        raise BenchmarkFailure("IMAGE_FORMAT", "The generated PNG pixel data was invalid.") from error
    return signature + b"".join(chunks)


def create_guidance_layouts(input_directory: Path, count: int) -> list[dict]:
    """Load the verified sibling helper even with embedded Python's fixed path."""
    helper = Path(__file__).resolve().with_name("activity_image_layouts.py")
    module_name = "skao_activity_image_layouts"
    previous_module = sys.modules.get(module_name)
    try:
        if not helper.is_file() or helper.is_symlink():
            raise ValueError("missing layout helper")
        spec = importlib.util.spec_from_file_location(module_name, helper)
        if spec is None or spec.loader is None:
            raise ValueError("unavailable layout helper loader")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        input_directory.mkdir()
        layouts = module.create_layouts(input_directory, count, size=1024)
        if not isinstance(layouts, list) or len(layouts) != count:
            raise ValueError("invalid layout list")
        references = []
        for step, entry in enumerate(layouts, 1):
            filename = f"layout-step-{step}.png"
            if (not isinstance(entry, dict) or type(entry.get("step")) is not int
                    or entry["step"] != step or entry.get("file") != filename):
                raise ValueError("invalid layout entry")
            path = input_directory / filename
            if not path.is_file() or path.is_symlink() or path.resolve().parent != input_directory.resolve():
                raise ValueError("invalid layout file")
            with path.open("rb") as stream:
                data = sanitize_png(stream.read(MAX_IMAGE_BYTES + 1), 1024)
            path.write_bytes(data)
            references.append({"step": step, "file": "input/" + filename, "sha256": hashlib.sha256(data).hexdigest()})
        return references
    except Exception as error:
        raise BenchmarkFailure("GUIDANCE_LAYOUT", "The fixed reference layouts could not be prepared. Use the complete current setup tools.") from error
    finally:
        if previous_module is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = previous_module


def validate_and_copy_image(raw_directory: Path, info: dict, prefix: str, destination: Path, expected_size: int = 512):
    filename = info.get("filename")
    if (info.get("type") != "output" or info.get("subfolder") != "" or not isinstance(filename, str)
            or not re.fullmatch(re.escape(prefix) + r"_[0-9]+_\.png", filename)):
        raise BenchmarkFailure("IMAGE_PATH", "The image service returned an unexpected output path.")
    source = raw_directory / filename
    if source.is_symlink() or source.resolve().parent != raw_directory.resolve() or not source.is_file():
        raise BenchmarkFailure("IMAGE_PATH", "The image output was outside its private test directory.")
    if not (8 < source.stat().st_size <= MAX_IMAGE_BYTES):
        raise BenchmarkFailure("IMAGE_SIZE", "The image file exceeded its size limit or was empty.")
    with source.open("rb") as stream:
        data = stream.read(MAX_IMAGE_BYTES + 1)
    destination.write_bytes(sanitize_png(data, expected_size))


class DeviceMemorySampler:
    """Optional device-wide observations, not process-specific memory accounting."""
    def __init__(self):
        self.executable = shutil.which("nvidia-smi.exe") or shutil.which("nvidia-smi")
        self.stop_event = threading.Event()
        self.peaks = {}
        self.thread = None

    def start(self):
        if self.executable:
            self.thread = threading.Thread(target=self._sample, daemon=True)
            self.thread.start()

    def _sample(self):
        while not self.stop_event.is_set():
            try:
                result = subprocess.run([
                    self.executable, "--query-gpu=index,memory.total,memory.used",
                    "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
                if result.returncode == 0:
                    for line in result.stdout.splitlines():
                        index, total, used = (part.strip() for part in line.split(","))
                        total_mib, used_mib = int(total), int(used)
                        previous = self.peaks.get(index, {}).get("observed_peak_used_mib", 0)
                        self.peaks[index] = {"gpu_index": int(index), "total_mib": total_mib,
                                             "observed_peak_used_mib": max(previous, used_mib)}
            except (OSError, subprocess.SubprocessError, ValueError):
                pass
            self.stop_event.wait(2)

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=4)
        return list(self.peaks.values())


def offline_environment() -> dict:
    env = dict(os.environ)
    for key in list(env):
        if key.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy"):
            del env[key]
    env.update({"NO_PROXY": "127.0.0.1,localhost", "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})
    return env


def write_json(path: Path, value: dict):
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def runtime_log_tail(directory: Path, max_bytes: int = 16_384, max_lines: int = 60) -> str:
    """Read only a bounded tail; missing or unreadable logs do not mask failure."""
    try:
        with (Path(directory) / "runtime.log").open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - max_bytes))
            raw = stream.read(max_bytes)
        text = "\n".join(raw.decode("utf-8", errors="replace").splitlines()[-max_lines:])
        encoded = text.encode("utf-8")
        return encoded[-max_bytes:].decode("utf-8", errors="ignore")
    except (OSError, ValueError):
        return ""


def write_gallery(directory: Path, images: list[dict], model: str = MODEL_NAME, simple_prompts: bool = False,
                  *, guided_layout: bool = False, references: list[dict] | None = None):
    profile = MODEL_PROFILES[model]
    label, size = html.escape(profile["label"]), profile["expectedSize"]
    if guided_layout:
        label += " - Guided layout"
    elif simple_prompts:
        label += " - Simple prompts"
    cards = "\n".join(
        '<figure><img src="' + html.escape(image["file"], quote=True) + f'" width="{size}" height="{size}" alt="Step '
        + str(image["step"]) + '"><figcaption><strong>Step ' + str(image["step"]) + ": </strong>"
        + html.escape(image["caption"]) + "</figcaption></figure>" for image in images)
    reference_section = ""
    extra_style = ""
    if guided_layout:
        cards = "\n".join(
            '<figure><img src="' + html.escape(image["file"], quote=True)
            + f'" width="{size}" height="{size}" alt="Generated illustration for step {image["step"]}">'
            + f'<figcaption><strong>GENERATED - Step {image["step"]}</strong><br>'
            + html.escape(image["caption"]) + '</figcaption></figure>' for image in images)
        if not images:
            cards = '<p>There are no completed illustrations for this run.</p>'
        reference_cards = []
        for reference in references or []:
            step = reference["step"]
            reference_card = ('<figure><img src="' + html.escape(reference["file"], quote=True)
                              + f'" width="{size}" height="{size}" alt="Reference layout for step {step}">'
                              + f'<figcaption><strong>REFERENCE - Step {step} (created by code)</strong><br>'
                              + html.escape(CAPTIONS[step - 1]) + '</figcaption></figure>')
            reference_cards.append(reference_card)
        if reference_cards:
            reference_section = ('<details><summary>Show reference drawings</summary><div class="reference-grid">'
                                 + "\n".join(reference_cards) + '</div></details>')
            extra_style = '.reference-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}details{margin-top:2rem}summary{cursor:pointer;margin-bottom:1rem}'
    document = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
                '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\'; style-src \'unsafe-inline\'">'
                '<title>SKAO ' + label + ' image test</title><style>body{font:18px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;}'
                'main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}figure{margin:0}img{max-width:100%;height:auto}'
                'figcaption{padding:.75rem 0}' + extra_style + '</style><h1>' + label + ' activity image test</h1>'
                '<p>Review whether each picture shows the stated step correctly. Image consistency and instructional accuracy are not guaranteed.</p><main>'
                + cards + '</main>' + reference_section + '</html>')
    (directory / "review.html").write_text(document, encoding="utf-8")


def ordinary_review_path(path: Path, kind: str, *, allow_missing: bool = False) -> bool:
    """Reject symbolic links, Windows reparse points and special files."""
    path = Path(path).absolute()
    for entry in reversed((path, *path.parents)):
        try:
            info = entry.lstat()
        except FileNotFoundError as error:
            if allow_missing and entry == path:
                return False
            raise BenchmarkFailure("REVIEW_PATH", "A required review file or directory is missing.") from error
        except OSError as error:
            raise BenchmarkFailure("REVIEW_PATH", "A review path could not be inspected.") from error
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise BenchmarkFailure("REVIEW_PATH", "Review refresh requires ordinary paths without links or reparse points.")
        expected = stat.S_ISREG if entry == path and kind == "file" else stat.S_ISDIR
        if not expected(info.st_mode):
            raise BenchmarkFailure("REVIEW_PATH", "A review path is not an ordinary file or directory.")
    return True


def validate_review_png(path: Path, size: int) -> bytes:
    ordinary_review_path(path, "file")
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_IMAGE_BYTES + 1)
        sanitize_png(data, size)
        return data
    except (OSError, BenchmarkFailure) as error:
        raise BenchmarkFailure("REVIEW_IMAGE", "A saved review image is missing, oversized or invalid for its model profile.") from error


def refresh_review(directory: Path) -> Path:
    """Rebuild only saved HTML using validated local report/image files."""
    directory = Path(directory).absolute()
    if ".." in directory.parts:
        raise BenchmarkFailure("REVIEW_PATH", "Use the existing result folder's direct path.")
    ordinary_review_path(directory, "directory")
    report_path = directory / "report.json"
    ordinary_review_path(report_path, "file")
    review_path = directory / "review.html"
    backup_path = directory / "review-before-update.html"
    review_exists = ordinary_review_path(review_path, "file", allow_missing=True)
    backup_exists = ordinary_review_path(backup_path, "file", allow_missing=True)
    try:
        with report_path.open("rb") as stream:
            raw = stream.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError("oversized report")
        report = json.loads(raw.decode("utf-8"))
        if not isinstance(report, dict) or type(report.get("schemaVersion")) is not int or report["schemaVersion"] != 1:
            raise ValueError("invalid report")
        model = report.get("model")
        prompt_profile = report.get("promptProfile", "baseline")
        count = report.get("requestedImages")
        if (not isinstance(model, str) or model not in MODEL_PROFILES
                or prompt_profile not in ("baseline", "simple-action-first-v1", "guided-canny-layout-v1")
                or type(count) is not int or count not in (1, 4)):
            raise ValueError("unsupported report profile")
        guided = prompt_profile == "guided-canny-layout-v1"
        if guided and model != SDXL_MODEL_NAME:
            raise ValueError("incompatible guided profile")
        size = MODEL_PROFILES[model]["expectedSize"]
        records = report.get("images")
        if not isinstance(records, list) or len(records) > count:
            raise ValueError("invalid saved image list")
        images, seen_steps = [], set()
        for entry in records:
            if not isinstance(entry, dict):
                raise ValueError("invalid saved image entry")
            step = entry.get("step")
            if type(step) is not int or not 1 <= step <= count or step in seen_steps or entry.get("file") != f"step-{step}.png":
                raise ValueError("invalid saved image path or step")
            caption = entry.get("caption", CAPTIONS[step - 1])
            if not isinstance(caption, str) or len(caption) > 4096:
                raise ValueError("invalid caption")
            validate_review_png(directory / entry["file"], size)
            images.append({"step": step, "file": entry["file"], "caption": caption})
            seen_steps.add(step)
        references = []
        if guided:
            guidance = report.get("guidance")
            records = guidance.get("references") if isinstance(guidance, dict) else None
            if not isinstance(records, list) or len(records) > count:
                raise ValueError("invalid reference list")
            seen_steps = set()
            for entry in records:
                if not isinstance(entry, dict):
                    raise ValueError("invalid reference entry")
                step = entry.get("step")
                if (type(step) is not int or not 1 <= step <= count or step in seen_steps
                        or entry.get("file") != f"input/layout-step-{step}.png"):
                    raise ValueError("invalid reference path or step")
                data = validate_review_png(directory / "input" / f"layout-step-{step}.png", size)
                digest = entry.get("sha256")
                if digest is not None and (not isinstance(digest, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", digest)
                                           or hashlib.sha256(data).hexdigest() != digest.lower()):
                    raise ValueError("reference hash mismatch")
                references.append({"step": step, "file": entry["file"]})
                seen_steps.add(step)
        images.sort(key=lambda entry: entry["step"])
        references.sort(key=lambda entry: entry["step"])
    except BenchmarkFailure:
        raise
    except (OSError, ValueError, UnicodeError, TypeError, RecursionError) as error:
        raise BenchmarkFailure("REVIEW_REPORT", "The saved report is invalid or does not match a supported image test.") from error
    try:
        with tempfile.TemporaryDirectory(prefix="review-refresh-", dir=directory) as staging:
            staged_directory = Path(staging)
            write_gallery(staged_directory, images, model, prompt_profile == "simple-action-first-v1",
                          guided_layout=guided, references=references)
            # Recheck output paths immediately before publishing; never follow or
            # overwrite a link, and preserve the first backup on later refreshes.
            review_exists = ordinary_review_path(review_path, "file", allow_missing=True)
            backup_exists = ordinary_review_path(backup_path, "file", allow_missing=True)
            if review_exists and not backup_exists:
                staged_backup = staged_directory / "review-before-update.html"
                with staged_backup.open("xb") as target, review_path.open("rb") as source:
                    shutil.copyfileobj(source, target)
                try:
                    # A same-filesystem hard link publishes a complete backup
                    # atomically and refuses to overwrite a concurrent backup.
                    os.link(staged_backup, backup_path)
                except FileExistsError:
                    ordinary_review_path(backup_path, "file")
            os.replace(staged_directory / "review.html", review_path)
    except BenchmarkFailure:
        raise
    except OSError as error:
        raise BenchmarkFailure("REVIEW_WRITE", "The review page could not be updated. Saved reports and images were preserved.") from error
    return review_path


class BenchmarkRunner:
    def __init__(self, runtime: Path, model: str, output: Path, count: int = 1,
                 startup_timeout: float = 180, image_timeout: float = 900, *, simple_prompts: bool = False,
                 guided_layout: bool = False):
        self.runtime = Path(runtime).resolve()
        self.model = model
        self.output = Path(output).resolve()
        self.count = count
        self.startup_timeout = startup_timeout
        self.image_timeout = image_timeout
        self.guided_layout = guided_layout
        self.simple_prompts = simple_prompts or guided_layout
        self.run_directory = None
        self.process = None
        self.environment = offline_environment()

    def run(self):
        profile = MODEL_PROFILES.get(self.model)
        if self.count not in (1, 4) or profile is None:
            raise BenchmarkFailure("ARGUMENTS", "This comparison supports one or four images from a supported SD1.5 or SDXL Base profile.")
        if self.guided_layout and self.model != SDXL_MODEL_NAME:
            raise BenchmarkFailure("ARGUMENTS", "Guided layout requires the exact supported SDXL Base model.")
        size = profile["expectedSize"]
        self.output.mkdir(parents=True, exist_ok=True)
        folder_prefix = profile["slug"] + ("-guided-" if self.guided_layout else "-simple-" if self.simple_prompts else "-")
        self.run_directory = Path(tempfile.mkdtemp(prefix=folder_prefix, dir=self.output))
        raw_directory = self.run_directory / "raw"
        raw_directory.mkdir()
        report = {"schemaVersion": 1, "model": self.model, "modelProfile": dict(profile), "requestedImages": self.count,
                  "promptProfile": "guided-canny-layout-v1" if self.guided_layout else "simple-action-first-v1" if self.simple_prompts else "baseline",
                  "prompts": [{"step": step + 1, "positive": positive_prompt(step, self.simple_prompts), "negative": NEGATIVE}
                              for step in range(self.count)],
                  "complete": False, "status": "running", "images": [], "errors": [],
                  "configuration": {"width": size, "height": size, "batchSize": 1, "steps": 20,
                                    "sampler": "euler", "scheduler": "normal", "seed": 482031927,
                                    "conditioning": "CLIPTextEncodeSDXL" if self.model == SDXL_MODEL_NAME else "CLIPTextEncode",
                                    "cpuVae": True, "dtype": "ComfyUI automatic", "preloadedAV": True,
                                    "startupStackEnabled": True, "startupStackIntervalSeconds": STARTUP_TRACE_SECONDS},
                  "deviceMemoryNote": "Sampled whole-device usage includes other applications and can miss brief peaks.",
                  "quietWindowRequired": True}
        references = []
        if self.guided_layout:
            report["configuration"]["denoise"] = 0.55
            report["guidance"] = {"controlNetFile": CONTROLNET_NAME, "strength": 0.8, "startPercent": 0.0,
                                  "endPercent": 1.0, "cannyLowThreshold": 0.4, "cannyHighThreshold": 0.8,
                                  "denoise": 0.55, "referenceSource": "created by code", "references": references}
        start = time.monotonic()
        sampler = DeviceMemorySampler()
        log_file = None
        try:
            python = self.runtime / "python_embeded" / "python.exe"
            main = self.runtime / "ComfyUI" / "main.py"
            checkpoint = self.runtime / "ComfyUI" / "models" / "checkpoints" / self.model
            if not all(path.is_file() for path in (python, main, checkpoint)):
                raise BenchmarkFailure("INSTALLATION", f"The verified portable runtime or {profile['label']} model is missing. Run setup first.")
            if self.guided_layout:
                control_file = self.runtime / "ComfyUI" / "models" / "controlnet" / CONTROLNET_NAME
                if not control_file.is_file() or control_file.is_symlink():
                    raise BenchmarkFailure("GUIDANCE_MODEL", "The verified ControlLoRA guidance file is missing. Run the optional guided setup first.")
            ollama = LocalJsonClient("http://127.0.0.1:11434").request("/api/ps", timeout=10)
            if not isinstance(ollama.get("models"), list):
                raise BenchmarkFailure("OLLAMA_STATUS", "Ollama did not return a usable loaded-model list.")
            if ollama["models"]:
                raise BenchmarkFailure("TEXT_MODEL_LOADED", "A text model is loaded. Wait for Organizer AI work to finish and unload, then rerun during a quiet window.")
            help_result = subprocess.run([str(python), "-s", str(main), "--help"], cwd=self.runtime,
                                         stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=45, env=self.environment)
            required_flags = REQUIRED_FLAGS + (("--input-directory",) if self.guided_layout else ())
            if help_result.returncode != 0 or any(flag not in help_result.stdout for flag in required_flags):
                raise BenchmarkFailure("RUNTIME_FLAGS", "This portable runtime does not expose the required local-only test options.")
            input_directory = self.run_directory / "input"
            if self.guided_layout:
                references.extend(create_guidance_layouts(input_directory, self.count))
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            ready_path = self.run_directory / "startup-ready.signal"
            flags = ["--listen", "127.0.0.1", "--port", str(port), "--disable-auto-launch",
                     "--disable-all-custom-nodes", "--offline", "--disable-metadata", "--disable-assets",
                     "--output-directory", str(raw_directory), "--cpu-vae", "--preview-method", "none"]
            if self.guided_layout:
                flags.extend(("--input-directory", str(input_directory)))
            command = build_startup_command(python, main, flags, ready_path)
            log_file = (self.run_directory / "runtime.log").open("wb")
            creationflags = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == "nt" else 0
            startup = time.monotonic()
            self.process = subprocess.Popen(command, cwd=self.runtime, stdout=log_file, stderr=subprocess.STDOUT,
                                            stdin=subprocess.DEVNULL, env=self.environment, creationflags=creationflags)
            report["ownedProcessId"] = getattr(self.process, "pid", None)
            sampler.start()
            client = LocalJsonClient(f"http://127.0.0.1:{port}")
            deadline = startup + self.startup_timeout
            stats = None
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise BenchmarkFailure("PROCESS_EXIT", "The image process could not start. See the local runtime log.")
                try:
                    stats = client.request("/system_stats", timeout=min(3, max(0.1, deadline - time.monotonic())))
                    break
                except BenchmarkFailure as error:
                    if error.code != "LOCAL_HTTP":
                        raise
                    time.sleep(0.5)
            if stats is None:
                raise BenchmarkFailure("STARTUP_TIMEOUT", "The image process did not become ready within its startup time limit.")
            devices = stats.get("devices")
            if not isinstance(devices, list) or not any(isinstance(device, dict) and device.get("type") == "cuda" for device in devices):
                raise BenchmarkFailure("CUDA_UNAVAILABLE", "The test did not detect CUDA GPU execution. Review the portable runtime and NVIDIA driver.")
            ready_path.touch(exist_ok=False)
            report["devices"] = [{key: device[key] for key in ("name", "type", "vram_total") if key in device}
                                 for device in devices if isinstance(device, dict)]
            system = stats.get("system", {})
            report["runtimeSystem"] = ({key: system[key] for key in ("comfyui_version", "python_version", "pytorch_version")
                                        if key in system and isinstance(system[key], str) and len(system[key]) < 500}
                                       if isinstance(system, dict) else {})
            report["startupSeconds"] = round(time.monotonic() - startup, 3)
            if self.guided_layout:
                assert_guidance_nodes(client)
            run_token = uuid.uuid4().hex[:12]
            for step in range(self.count):
                prefix = f"skao_{profile['slug']}_{run_token}_step{step + 1}"
                started = time.monotonic()
                queued = client.request("/prompt", {"prompt": build_workflow(self.model, step, prefix, self.simple_prompts, self.guided_layout)}, timeout=10)
                if queued.get("node_errors") or "error" in queued:
                    raise BenchmarkFailure("WORKFLOW_REJECTED", "The image service rejected the synthetic workflow. See the local runtime log.")
                prompt_id = queued.get("prompt_id")
                if not isinstance(prompt_id, str):
                    raise BenchmarkFailure("PROMPT_ID", "The image service did not return a job identifier.")
                info = wait_for_image(client, prompt_id, started + self.image_timeout, self.process)
                filename = f"step-{step + 1}.png"
                validate_and_copy_image(raw_directory, info, prefix, self.run_directory / filename, size)
                image = {"step": step + 1, "file": filename, "caption": CAPTIONS[step],
                         "seconds": round(time.monotonic() - started, 3),
                         "timing": "cold-first-image" if step == 0 else "subsequent-image"}
                report["images"].append(image)
                write_json(self.run_directory / "report.json", report)
                print(f"PASS: {profile['label']} image {step + 1}/{self.count}; {image['seconds']:.2f} seconds", flush=True)
            report["complete"] = True
            report["status"] = "completed"
        except KeyboardInterrupt:
            report["status"] = "cancelled"
            report["errors"].append({"code": "CANCELLED", "message": "The attended test was cancelled."})
            raise
        except BenchmarkFailure as error:
            report["status"] = "failed"
            report["errors"].append({"code": error.code, "message": str(error)})
            raise
        except Exception as error:
            report["status"] = "failed"
            report["errors"].append({"code": "TEST_FAILED", "message": "The test could not complete (" + type(error).__name__ + ")."})
            raise BenchmarkFailure("TEST_FAILED", "The image test could not complete. Review its local report and runtime log.") from error
        finally:
            report["processStopped"] = self.process is None
            if self.process is not None:
                try:
                    if self.process.poll() is None:
                        try:
                            self.process.terminate()
                        except OSError:
                            pass
                        try:
                            self.process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            self.process.kill()
                            self.process.wait(timeout=5)
                    report["processStopped"] = self.process.poll() is not None
                except (OSError, subprocess.SubprocessError):
                    report["processStopped"] = False
            if not report["processStopped"]:
                report["complete"] = False
                report["status"] = "failed"
                report["errors"].append({"code": "CLEANUP_FAILED", "message": "Stopping the owned image process could not be confirmed. Check the recorded ownedProcessId locally."})
            if log_file is not None:
                try:
                    log_file.close()
                except OSError:
                    pass
            try:
                report["observedDeviceMemory"] = sampler.stop()
            except RuntimeError:
                report["observedDeviceMemory"] = []
            report["totalSeconds"] = round(time.monotonic() - start, 3)
            write_json(self.run_directory / "report.json", report)
            write_gallery(self.run_directory, report["images"], self.model, self.simple_prompts,
                          guided_layout=self.guided_layout, references=references)
        if not report["processStopped"]:
            raise BenchmarkFailure("CLEANUP_FAILED", "Stopping the owned image process could not be confirmed. Review the local report.")
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--model", choices=tuple(MODEL_PROFILES))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--count", type=int, choices=(1, 4))
    parser.add_argument("--simple-prompts", action="store_true", default=None, help="Use the fixed shorter action-first positive prompts with unchanged generation settings.")
    parser.add_argument("--guided-layout", action="store_true", default=None, help="Use fixed local reference layouts with the exact SDXL Base model and short prompts.")
    parser.add_argument("--refresh-review", type=Path, help="Update only the HTML review page in an existing result folder without generating images.")
    args = parser.parse_args(argv)
    if args.refresh_review is not None:
        if any(getattr(args, key) is not None for key in ("runtime", "model", "output", "count", "simple_prompts", "guided_layout")):
            parser.error("--refresh-review cannot be combined with generation options")
        try:
            print("PASS: review page updated: " + str(refresh_review(args.refresh_review)))
            return 0
        except BenchmarkFailure as error:
            print(error.code + ": " + str(error), file=sys.stderr)
            return 1
    if args.runtime is None or args.output is None:
        parser.error("image generation requires --runtime and --output")
    runner = BenchmarkRunner(args.runtime, args.model or MODEL_NAME, args.output, args.count or 1,
                             simple_prompts=bool(args.simple_prompts), guided_layout=bool(args.guided_layout))
    try:
        runner.run()
        print("PASS: image process stopped; review " + str(runner.run_directory / "review.html"))
        return 0
    except KeyboardInterrupt:
        print("CANCELLED: image test stopped.", file=sys.stderr)
        return 130
    except BenchmarkFailure as error:
        print(error.code + ": " + str(error), file=sys.stderr)
        if runner.run_directory:
            print("Report: " + str(runner.run_directory / "report.json"), file=sys.stderr)
            tail = runtime_log_tail(runner.run_directory)
            if tail:
                print("Recent local runtime messages (bounded tail):", file=sys.stderr)
                print(tail, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
