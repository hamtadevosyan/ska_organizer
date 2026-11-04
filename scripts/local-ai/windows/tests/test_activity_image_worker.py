"""Real loopback HTTP with synthetic images and a fake local model service."""
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zlib


FILE = Path(__file__).resolve().parents[1] / "activity_image_worker.py"
SPEC = importlib.util.spec_from_file_location("image_worker_tests_subject", FILE)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)
TOKEN = "synthetic-private-worker-token-0123456789abcdef"


def png():
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xffffffff)
    pixels = (b"\0" + b"\xff\0\0" * 1024) * 1024
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1024, 1024, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


def wait_until(predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("The synthetic operation did not finish in time.")


class FakeEngine:
    def __init__(self, block=False, cleanup_wait=False, cleanup_failed=False):
        self.block, self.cleanup_wait, self.cleanup_failed = block, cleanup_wait, cleanup_failed
        self.calls = []
        self.started, self.release, self.cleaning, self.cleanup_release = (threading.Event() for _ in range(4))
        self.available_calls = 0

    def available(self):
        self.available_calls += 1
        return True

    def generate(self, name, steps, directory, cancel, on_frame=None):
        self.calls.append((name, list(steps)))
        self.started.set()
        while self.block and not self.release.is_set() and not cancel.wait(0.01):
            pass
        if cancel.is_set():
            self.cleaning.set()
            if self.cleanup_wait:
                self.cleanup_release.wait(3)
            raise WORKER.ENGINE.EngineError("CANCELLED", "Cancelled")
        if self.cleanup_failed:
            raise WORKER.ENGINE.EngineError("PROCESS_CLEANUP", "Cleanup not confirmed", cleanup_failed=True)
        frames, data = [], png()
        for step in range(1, len(steps) + 1):
            (directory / f"step-{step}.png").write_bytes(data)
            frame = {"step": step, "sha256": hashlib.sha256(data).hexdigest(), "width": 1024, "height": 1024, "byteLength": len(data)}
            frames.append(frame)
            if on_frame:
                on_frame(frame)
        return frames


class LocalOllama:
    def __init__(self):
        self.calls = []
        self.loaded = []
        self.text_started, self.text_release = threading.Event(), threading.Event()
        self.block_text = False
        self.response = {"response": "Synthetic local answer", "done": True}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def reply(self, value):
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass

            def do_GET(self):
                owner.calls.append(("GET", self.path, dict(self.headers), None))
                self.reply({"models": owner.loaded} if self.path == "/api/ps" else {"cloud": {"disabled": True}})

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                owner.calls.append(("POST", self.path, dict(self.headers), json.loads(raw)))
                owner.text_started.set()
                if owner.block_text:
                    owner.text_release.wait(4)
                self.reply(owner.response)

            def log_message(self, *_):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.text_release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.engine = FakeEngine()
        self.state = WORKER.WorkerState(self.engine, self.root / "worker")
        self.server = WORKER.WorkerServer(("127.0.0.1", 0), self.state, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.ollama = LocalOllama()
        original = http.client.HTTPConnection
        def connection(host, port=None, *args, **kwargs):
            return original(host, self.ollama.server.server_port if host == "127.0.0.1" and port == 11434 else port, *args, **kwargs)
        self.proxy_patch = patch.object(WORKER.http.client, "HTTPConnection", side_effect=connection)
        self.proxy_patch.start()

    def tearDown(self):
        self.engine.release.set()
        self.engine.cleanup_release.set()
        self.ollama.text_release.set()
        self.state.shutdown()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.proxy_patch.stop()
        self.ollama.close()
        self.temporary.cleanup()

    def request(self, method, path, value=None, headers=None, authorize=True, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            body = raw if raw is not None else None if value is None else json.dumps(value).encode()
            outgoing = {**({"Authorization": "Bearer " + TOKEN} if authorize else {}),
                        **({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
            connection.request(method, path, body, outgoing)
            response = connection.getresponse()
            data = response.read()
            return response.status, data if response.getheader("Content-Type") == "image/png" else json.loads(data)
        finally:
            connection.close()

    @staticmethod
    def payload(identifier=None):
        return {"requestId": identifier or str(uuid.uuid4()), "name": "Paper collage", "steps": ["Tear large paper pieces.", "Glue the pieces onto card."]}

    def finished(self, identifier):
        return self.state.job(identifier)["status"] != "running" and (not self.state.gate.locked() or self.state.poisoned)

    def test_status_auth_origin_route_and_idle_no_generation(self):
        for method, path, headers, authorized in (("GET", "/api/activity-images/status", {}, False),
                                                  ("GET", "/api/activity-images/status", {"Origin": "http://example.invalid"}, True),
                                                  ("GET", "/api/activity-images/status?x=1", {}, True),
                                                  ("PUT", "/api/activity-images/jobs", {}, True)):
            status, _ = self.request(method, path, headers=headers, authorize=authorized)
            self.assertIn(status, (400, 403, 405))
        status, value = self.request("GET", "/api/activity-images/status")
        self.assertEqual(status, 200)
        self.assertEqual((value["version"], value["model"], value["busy"]), (1, "sd_xl_base_1.0.safetensors", False))
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(self.ollama.calls, [])

    def test_actual_http_job_idempotency_poll_png_and_content_conflict(self):
        self.engine.block = True
        payload = self.payload()
        status, first = self.request("POST", "/api/activity-images/jobs", payload)
        self.assertEqual(status, 202)
        self.assertEqual(first["id"], payload["requestId"])
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", payload)[1]["id"], first["id"])
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", {**payload, "name": "Changed"})[0], 409)
        self.assertTrue(self.engine.started.wait(1))
        self.assertEqual(len(self.engine.calls), 1)
        self.engine.release.set()
        wait_until(lambda: self.finished(first["id"]))
        status, value = self.request("GET", "/api/activity-images/jobs/" + first["id"])
        self.assertEqual((status, value["status"], value["completed"], value["total"]), (200, "complete", 2, 2))
        self.assertEqual(value["frames"][1]["caption"], payload["steps"][1])
        self.assertNotIn(str(self.root), json.dumps(value))
        status, image = self.request("GET", "/api/activity-images/jobs/" + first["id"] + "/frames/1")
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(image).hexdigest(), value["frames"][0]["sha256"])

    def test_cancel_holds_shared_gate_through_cleanup_and_unknown_cancel_prevents_later_start(self):
        self.engine.block, self.engine.cleanup_wait = True, True
        payload = self.payload()
        self.request("POST", "/api/activity-images/jobs", payload)
        self.assertTrue(self.engine.started.wait(1))
        self.assertEqual(self.request("DELETE", "/api/activity-images/jobs/" + payload["requestId"])[0], 202)
        self.assertTrue(self.engine.cleaning.wait(1))
        self.assertTrue(self.state.gate.locked())
        status, problem = self.request("POST", "/api/generate", {"model": "qwen3:4b", "stream": False, "prompt": "Synthetic"})
        self.assertEqual((status, problem["code"]), (429, "AI_BUSY"))
        self.engine.cleanup_release.set()
        wait_until(lambda: self.finished(payload["requestId"]))
        self.assertFalse(self.state.gate.locked())
        unknown = str(uuid.uuid4())
        status, cancelled = self.request("DELETE", "/api/activity-images/jobs/" + unknown)
        self.assertEqual((status, cancelled["total"], cancelled["version"]), (200, 0, 1))
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", self.payload(unknown))[0], 409)
        self.assertEqual(len(self.engine.calls), 1)

    def test_validation_body_limits_and_loaded_ollama_admission(self):
        for value in ({**self.payload(), "unknown": True}, {**self.payload(), "steps": ["https://invalid.example/"]},
                      {**self.payload(), "steps": ["Step"] * 7}, {**self.payload(), "requestId": "../escape"}):
            self.assertEqual(self.request("POST", "/api/activity-images/jobs", value)[0], 400)
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", raw=b"x" * 16385)[0], 413)
        self.ollama.loaded = [{"name": "Synthetic loaded model"}]
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", self.payload())[0], 429)
        self.assertEqual(self.engine.calls, [])
        self.assertFalse(self.state.gate.locked())

    def test_text_proxy_uses_same_gate_fixed_local_target_and_strips_worker_auth(self):
        self.ollama.block_text = True
        result = []
        thread = threading.Thread(target=lambda: result.append(self.request("POST", "/api/generate", {"model": "qwen3:4b", "stream": False, "prompt": "Synthetic private text"})))
        thread.start()
        self.assertTrue(self.ollama.text_started.wait(2))
        self.assertTrue(self.state.gate.locked())
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", self.payload())[0], 429)
        self.ollama.text_release.set()
        thread.join(timeout=3)
        self.assertEqual(result[0][0], 200)
        actual = next(call for call in self.ollama.calls if call[0] == "POST")
        self.assertEqual(actual[1], "/api/generate")
        self.assertNotIn("Authorization", actual[2])
        self.assertEqual(actual[3]["prompt"], "Synthetic private text")
        self.assertFalse(self.state.gate.locked())

    def test_text_proxy_rejects_urls_streaming_unknown_proxy_fields_and_oversized_response(self):
        for value in ({"model": "http://example.invalid", "stream": False}, {"model": "qwen:cloud", "stream": False},
                      {"model": "qwen3:4b", "stream": True}, {"model": "qwen3:4b", "stream": False, "url": "http://bad"}):
            self.assertEqual(self.request("POST", "/api/generate", value)[0], 400)
        self.assertEqual(self.ollama.calls, [])
        self.ollama.response = {"response": "x" * (WORKER.MAX_JSON + 1)}
        self.assertEqual(self.request("POST", "/api/generate", {"model": "qwen3:4b", "stream": False})[0], 503)
        self.assertFalse(self.state.gate.locked())

    def test_delete_during_admission_and_shutdown_never_starts_engine(self):
        for stopping in (False, True):
            identifier, entered, release = str(uuid.uuid4()), threading.Event(), threading.Event()
            original = WORKER.fixed_ollama_json
            def check(path, *args, **kwargs):
                if path == "/api/ps":
                    entered.set()
                    release.wait(2)
                    return {"models": []}
                return original(path, *args, **kwargs)
            result = []
            with patch.object(WORKER, "fixed_ollama_json", side_effect=check):
                thread = threading.Thread(target=lambda: result.append(self.request("POST", "/api/activity-images/jobs", self.payload(identifier))))
                thread.start()
                self.assertTrue(entered.wait(1))
                if stopping:
                    self.state.shutdown()
                else:
                    self.request("DELETE", "/api/activity-images/jobs/" + identifier)
                release.set()
                thread.join(timeout=3)
            self.assertEqual(result[0][0], 409)
            self.assertEqual(self.engine.calls, [])
            self.assertFalse(self.state.gate.locked())

    def test_metadata_failure_does_not_leak_admission_gate(self):
        with patch.object(self.state, "_persist", side_effect=OSError("synthetic full disk")):
            with self.assertRaises(OSError):
                self.state.start(self.payload())
        self.assertFalse(self.state.gate.locked())
        self.assertEqual(self.engine.calls, [])

    def test_uncertain_engine_cleanup_poison_prevents_new_text_or_image_work(self):
        self.engine.cleanup_failed = True
        payload = self.payload()
        self.request("POST", "/api/activity-images/jobs", payload)
        wait_until(lambda: self.finished(payload["requestId"]))
        self.assertTrue(self.state.poisoned)
        self.assertTrue(self.state.gate.locked())
        self.assertFalse(self.state.status()["available"])
        cancelled, status = self.state.cancel(payload["requestId"])
        self.assertEqual((status, cancelled["status"]), (202, "failed"))
        self.assertEqual(self.request("POST", "/api/activity-images/jobs", self.payload())[0], 503)
        self.assertEqual(self.request("POST", "/api/generate", {"model": "qwen3:4b", "stream": False})[0], 503)

    def test_recovery_retains_verified_completed_images_and_bounds_jobs_and_tombstones(self):
        for _ in range(WORKER.MAX_JOBS + 1):
            payload = self.payload()
            self.state.start(payload)
            wait_until(lambda: self.finished(payload["requestId"]))
        self.assertEqual(len(self.state.jobs), WORKER.MAX_JOBS)
        orphan = self.state.jobs_root / str(uuid.uuid4())
        orphan.mkdir()
        (orphan / "uncompleted.bin").write_bytes(b"owned partial data")
        recovered = WORKER.WorkerState(FakeEngine(), self.state.root)
        self.assertFalse(orphan.exists())
        self.assertEqual(len(recovered.jobs), WORKER.MAX_JOBS)
        self.assertTrue(all(job.status == "complete" for job in recovered.jobs.values()))
        for _ in range(WORKER.MAX_TOMBSTONES + 2):
            recovered.cancel(str(uuid.uuid4()))
        self.assertEqual(len(recovered.tombstones), WORKER.MAX_TOMBSTONES)
        expired = next(iter(recovered.jobs.values()))
        expired.created = time.time() - WORKER.JOB_TTL - 1
        recovered._prune()
        self.assertFalse(expired.directory.exists())

    def test_client_disconnect_stops_text_proxy_and_releases_gate(self):
        self.ollama.block_text = True
        body = json.dumps({"model": "qwen3:4b", "stream": False, "prompt": "Synthetic"}).encode()
        connection = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3)
        request = (f"POST /api/generate HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body
        connection.sendall(request)
        self.assertTrue(self.ollama.text_started.wait(2))
        connection.close()
        wait_until(lambda: not self.state.gate.locked())


class ConfigurationTests(unittest.TestCase):
    def test_normal_shutdown_keeps_listener_owned_until_work_cleanup(self):
        events = []
        class Server:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                events.append("listener closed")
            def serve_forever(self, **_):
                events.append("serving")
                raise KeyboardInterrupt
        state = type("State", (), {"shutdown": lambda _: events.append("work stopped")})()
        config = {"imageRoot": Path("/synthetic/images"), "workerRoot": Path("/synthetic/worker"), "token": TOKEN}
        with patch.object(WORKER, "read_config", return_value=config), patch.object(WORKER, "WorkerServer", return_value=Server()), \
             patch.object(WORKER, "WorkerState", return_value=state), patch.object(sys, "stdout", new_callable=io.StringIO):
            self.assertEqual(WORKER.main(["--config", "synthetic.json"]), 0)
        self.assertLess(events.index("work stopped"), events.index("listener closed"))

    def test_second_worker_launch_does_not_recover_or_modify_running_job_storage(self):
        config = {"imageRoot": Path("/synthetic/images"), "workerRoot": Path("/synthetic/worker"), "token": TOKEN}
        with patch.object(WORKER, "read_config", return_value=config), \
             patch.object(WORKER, "WorkerServer", side_effect=OSError("listener already owned")), \
             patch.object(WORKER, "WorkerState") as state, patch.object(sys, "stderr", new_callable=io.StringIO):
            self.assertEqual(WORKER.main(["--config", "synthetic.json"]), 1)
        state.assert_not_called()

    def test_private_config_and_isolated_import_need_no_model_or_cuda_initialization(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            image = directory / "images"
            image.mkdir()
            config = directory / "worker.json"
            config.write_text(json.dumps({"version": 1, "token": TOKEN, "imageRoot": str(image), "workerRoot": str(directory / "worker")}))
            config.chmod(0o600)
            self.assertEqual(WORKER.read_config(config)["imageRoot"], image)
            script = ("import importlib.util,sys; "
                      "s=importlib.util.spec_from_file_location('worker',sys.argv[1]); "
                      "m=importlib.util.module_from_spec(s);s.loader.exec_module(m); "
                      "assert not any(x in sys.modules for x in ('torch','av','PIL')); "
                      "assert not m.ENGINE.GenericEngine(sys.argv[2]).available()")
            result = subprocess.run([sys.executable, "-I", "-c", script, str(FILE), str(image)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((directory / "worker").exists())

    def test_overlapping_installation_and_job_roots_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            image = directory / "worker" / "images"
            image.mkdir(parents=True)
            config = directory / "worker.json"
            config.write_text(json.dumps({"version": 1, "token": TOKEN, "imageRoot": str(image), "workerRoot": str(directory / "worker")}))
            config.chmod(0o600)
            with self.assertRaises(WORKER.Problem):
                WORKER.read_config(config)


if __name__ == "__main__":
    unittest.main()
