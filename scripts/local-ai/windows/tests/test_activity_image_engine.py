"""Generic activity-image engine tests without models or GPU inference."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zlib


SPEC = importlib.util.spec_from_file_location("activity_engine_under_test", Path(__file__).resolve().parents[1] / "activity_image_engine.py")
ENGINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENGINE)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


def image_png():
    header = chunk(b"IHDR", struct.pack(">IIBBBBB", 1024, 1024, 8, 2, 0, 0, 0))
    pixels = b"".join(b"\0" + b"\xff\0\0" * 1024 for _ in range(1024))
    return b"\x89PNG\r\n\x1a\n" + header + chunk(b"tEXt", b"workflow\0synthetic discarded metadata") + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


class FakeProcess:
    def __init__(self, command, *, pending=False, reject=False, cuda=True, **kwargs):
        self.command = command
        self.options = kwargs
        self.returncode = None
        self.stopped = False
        self.workflows = []
        self.jobs = {}
        self.raw = Path(command[command.index("--output-directory") + 1])
        process = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/system_stats":
                    self.respond({"devices": [{"type": "cuda"}] if cuda else []})
                elif self.path.startswith("/history/"):
                    job_id = self.path.rsplit("/", 1)[-1]
                    self.respond({} if pending else {job_id: process.jobs[job_id]})
                else:
                    self.respond({}, 404)

            def do_POST(self):
                value = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                workflow = value["prompt"]
                process.workflows.append(workflow)
                if reject:
                    self.respond({"node_errors": {"3": {"errors": ["synthetic error"]}}})
                    return
                filename = workflow["9"]["inputs"]["filename_prefix"] + "_00001_.png"
                (process.raw / filename).write_bytes(image_png())
                job_id = "job-" + str(len(process.jobs) + 1)
                process.jobs[job_id] = {"status": {"status_str": "success", "completed": True},
                                        "outputs": {"9": {"images": [{"filename": filename, "subfolder": "", "type": "output"}]}}}
                self.respond({"prompt_id": job_id, "node_errors": {}})

            def respond(self, value, status=200):
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *_):
                pass
        port = int(command[command.index("--port") + 1])
        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15
        self.stopped = True
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def wait(self, timeout=None):
        return self.returncode


class GenericEngineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.image_root = self.root / "images"
        self.engine = ENGINE.GenericEngine(self.image_root, startup_timeout=2, image_timeout=2)
        for path in (self.engine.runtime / "python_embeded" / "python.exe", self.engine.runtime / "ComfyUI" / "main.py",
                     self.engine.runtime / "ComfyUI" / "models" / "checkpoints" / ENGINE.MODEL_FILE):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic installation")
        self.processes = []
        self.helpers = ENGINE.benchmark_helpers()

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
        self.temporary.cleanup()

    def job(self, name="job"):
        directory = self.root / name
        directory.mkdir()
        return directory

    @contextmanager
    def fixtures(self, *, loaded=False, pending=False, reject=False, cuda=True):
        original_client = self.helpers.LocalJsonClient
        def client(base):
            if base == "http://127.0.0.1:11434":
                return SimpleNamespace(request=lambda path, **kwargs: {"models": [{"name": "in use"}] if loaded else []})
            return original_client(base)
        def process(*args, **kwargs):
            child = FakeProcess(*args, pending=pending, reject=reject, cuda=cuda, **kwargs)
            self.processes.append(child)
            return child
        with patch.object(self.helpers, "LocalJsonClient", side_effect=client), \
             patch.object(ENGINE.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=" ".join(self.helpers.REQUIRED_FLAGS))), \
             patch.object(ENGINE.subprocess, "Popen", side_effect=process), patch.object(ENGINE.ProcessJob, "attach"), patch.object(ENGINE.ProcessJob, "close"):
            yield

    def test_available_only_inspects_files_and_does_not_import_runtime_or_launch_gpu(self):
        before = sorted(str(path) for path in self.root.rglob("*"))
        with patch.object(ENGINE, "benchmark_helpers", side_effect=AssertionError("runtime import forbidden")), \
             patch.object(ENGINE.subprocess, "Popen", side_effect=AssertionError("launch forbidden")):
            self.assertTrue(self.engine.available())
        self.assertEqual(sorted(str(path) for path in self.root.rglob("*")), before)
        (self.engine.runtime / "ComfyUI" / "models" / "checkpoints" / ENGINE.MODEL_FILE).unlink()
        self.assertFalse(self.engine.available())

    def test_generic_workflow_uses_actual_activity_step_and_no_block_guidance(self):
        workflow = ENGINE.build_activity_workflow("Seed planting", "Put soil into the pot.", "skao_media_test_step1")
        self.assertTrue(workflow["6"]["inputs"]["text_g"].startswith("Put soil into the pot."))
        self.assertIn("Seed planting", workflow["6"]["inputs"]["text_g"])
        self.assertEqual(workflow["6"]["inputs"]["text_l"], workflow["6"]["inputs"]["text_g"])
        self.assertEqual(workflow["3"]["inputs"]["seed"], 483031927)
        self.assertEqual(workflow["5"]["inputs"], {"width": 1024, "height": 1024, "batch_size": 1})
        self.assertNotIn("ControlNetLoader", json.dumps(workflow))
        self.assertNotIn("cubes", json.dumps(workflow))

    def test_one_to_six_step_validation_rejects_markup_urls_and_extra_long_text(self):
        for name, steps in (("", ["step"]), ("name", []), ("name", ["step"] * 7), ("name", ["x" * 501]),
                            ("name", ["https://example.invalid"]), ("name", ["<script>bad</script>"])):
            with self.subTest(name=name, count=len(steps)), self.assertRaises(ENGINE.EngineError):
                ENGINE.validate_activity(name, steps)
        self.assertEqual(ENGINE.validate_activity(" Name ", [" A step "] * 6), ("Name", ["A step"] * 6))

    def test_three_real_step_requests_keep_gate_lifecycle_and_remove_raw_copies(self):
        directory = self.job()
        callbacks = []
        def complete(frame):
            self.assertIsNone(self.processes[-1].poll())
            callbacks.append(frame)
        with self.fixtures():
            frames = self.engine.generate("Seed planting", ["Fill a pot with soil.", "Place the seed in the soil.", "Water the pot lightly."],
                                          directory, threading.Event(), complete)
        self.assertEqual(len(frames), 3)
        self.assertEqual(callbacks, frames)
        self.assertTrue(self.processes[-1].stopped)
        self.assertEqual(list((directory / "raw").iterdir()), [])
        for frame in frames:
            self.assertEqual(set(frame), {"step", "sha256", "width", "height", "byteLength"})
            data = (directory / f"step-{frame['step']}.png").read_bytes()
            self.assertEqual(frame["byteLength"], len(data))
            self.assertNotIn(b"workflow", data)
        self.assertEqual(self.processes[-1].options["stdout"], subprocess.DEVNULL)
        self.assertEqual(self.processes[-1].options["stderr"], subprocess.DEVNULL)
        self.assertEqual(self.processes[-1].command[self.processes[-1].command.index("--listen") + 1], "127.0.0.1")
        self.assertIn("--cpu-vae", self.processes[-1].command)

    def test_loaded_ollama_model_is_not_unloaded_and_prevents_child_launch(self):
        with self.fixtures(loaded=True), self.assertRaises(ENGINE.EngineError) as error:
            self.engine.generate("Seed planting", ["Fill the pot."], self.job(), threading.Event())
        self.assertEqual(error.exception.code, "AI_BUSY")
        self.assertEqual(self.processes, [])

    def test_existing_output_is_preserved_and_no_process_is_started(self):
        directory = self.job()
        output = directory / "step-1.png"
        output.write_bytes(b"existing output")
        with self.fixtures(), self.assertRaises(ENGINE.EngineError) as error:
            self.engine.generate("Seed planting", ["Fill the pot."], directory, threading.Event())
        self.assertEqual(error.exception.code, "IMAGE_DIRECTORY")
        self.assertEqual(output.read_bytes(), b"existing output")
        self.assertEqual(self.processes, [])

    def test_cancel_during_launch_option_check_prevents_gpu_process_start(self):
        cancel = threading.Event()
        def checked(*args, **kwargs):
            cancel.set()
            return SimpleNamespace(returncode=0, stdout=" ".join(self.helpers.REQUIRED_FLAGS))
        directory = self.job()
        with self.fixtures(), patch.object(ENGINE.subprocess, "run", side_effect=checked), self.assertRaises(ENGINE.EngineError) as error:
            self.engine.generate("Seed planting", ["Fill the pot."], directory, cancel)
        self.assertEqual(error.exception.code, "CANCELLED")
        self.assertFalse((directory / "raw").exists())
        self.assertEqual(self.processes, [])

    def test_cancellation_during_pending_frame_stops_owned_process(self):
        cancel, errors = threading.Event(), []
        directory = self.job()
        def generate():
            try:
                self.engine.generate("Seed planting", ["Fill the pot."], directory, cancel)
            except ENGINE.EngineError as error:
                errors.append(error)
        with self.fixtures(pending=True):
            thread = threading.Thread(target=generate)
            thread.start()
            deadline = time.monotonic() + 3
            while (not self.processes or not self.processes[-1].workflows) and time.monotonic() < deadline:
                time.sleep(0.01)
            cancel.set()
            thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors[0].code, "CANCELLED")
        self.assertTrue(self.processes[-1].stopped)

    def test_bad_cuda_or_rejected_workflow_cleans_up_without_raw_error_details(self):
        for mode, code in (({"cuda": False}, "IMAGE_CUDA"), ({"reject": True}, "IMAGE_WORKFLOW")):
            with self.subTest(mode=mode), self.fixtures(**mode), self.assertRaises(ENGINE.EngineError) as error:
                self.engine.generate("Private synthetic title", ["A private synthetic step."], self.job(code), threading.Event())
            self.assertEqual(error.exception.code, code)
            self.assertNotIn("Private synthetic", str(error.exception))
            self.assertTrue(self.processes[-1].stopped)

    def test_uncertain_cleanup_is_explicit_for_worker_gate_poisoning(self):
        with self.fixtures(), patch.object(FakeProcess, "terminate", side_effect=OSError("synthetic")), \
             patch.object(FakeProcess, "wait", side_effect=subprocess.TimeoutExpired("fake", 1)), \
             patch.object(FakeProcess, "kill", side_effect=OSError("synthetic"), create=True):
            with self.assertRaises(ENGINE.EngineError) as error:
                self.engine.generate("Seed planting", ["Fill the pot."], self.job(), threading.Event())
        self.assertTrue(error.exception.cleanup_failed)
        self.assertEqual(error.exception.code, "PROCESS_CLEANUP")

    def test_helper_import_uses_absolute_sibling_without_sys_path_dependency(self):
        folder = self.root / "tool-copy"
        folder.mkdir()
        (folder / "run-activity-images.py").write_text("ABSOLUTE_FIXTURE = True\n", encoding="utf-8")
        previous = ENGINE._benchmark_module
        try:
            ENGINE._benchmark_module = None
            with patch.object(ENGINE, "__file__", str(folder / "activity_image_engine.py")):
                module = ENGINE.benchmark_helpers()
            self.assertTrue(module.ABSOLUTE_FIXTURE)
        finally:
            ENGINE._benchmark_module = previous

    @unittest.skipUnless(os.name == "nt", "Windows Job Objects require Windows")
    def test_windows_job_closes_only_its_owned_child(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(15)"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        job = ENGINE.ProcessJob()
        try:
            job.attach(child)
            job.close()
            child.wait(timeout=5)
            self.assertIsNotNone(child.poll())
        finally:
            job.close()
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
