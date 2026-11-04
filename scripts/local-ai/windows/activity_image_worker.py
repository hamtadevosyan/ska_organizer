#!/usr/bin/env python3
"""Private loopback image jobs and a serialized local Ollama generation broker."""
from __future__ import annotations

import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import stat
import sys
import threading
import time
import uuid


def load_engine():
    filename = Path(__file__).resolve().with_name("activity_image_engine.py")
    spec = importlib.util.spec_from_file_location("skao_activity_image_engine", filename)
    if spec is None or spec.loader is None:
        raise RuntimeError("The verified image engine companion is missing.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ENGINE = load_engine()
UUID_PATTERN = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
JOB_ROUTE = re.compile(r"/api/activity-images/jobs/(" + UUID_PATTERN + r")")
FRAME_ROUTE = re.compile(r"/api/activity-images/jobs/(" + UUID_PATTERN + r")/frames/([1-6])")
MAX_JSON = 262144
MAX_PNG = 8 * 1024 * 1024
MAX_JOBS = 16
JOB_TTL = 24 * 60 * 60
TOMBSTONE_TTL = 300
MAX_TOMBSTONES = 64


class Problem(RuntimeError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def canonical_id(value):
    if not isinstance(value, str) or not re.fullmatch(UUID_PATTERN, value):
        raise Problem(400, "IMAGE_INPUT", "Use a valid image request identifier.")
    return value


def ordinary(path, directory=False, missing=False):
    path = Path(path).absolute()
    if ".." in path.parts:
        raise Problem(400, "WORKER_PATH", "A worker path is invalid.")
    for item in reversed((path, *path.parents)):
        try:
            value = item.lstat()
        except FileNotFoundError:
            if missing and item == path:
                return False
            raise Problem(400, "WORKER_PATH", "A required worker path is missing.")
        if stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400:
            raise Problem(400, "WORKER_PATH", "Worker paths must not contain links or reparse points.")
        is_expected = stat.S_ISDIR if item != path or directory else stat.S_ISREG
        if not is_expected(value.st_mode):
            raise Problem(400, "WORKER_PATH", "A worker path has an unsupported file type.")
    return True


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def decode_json(raw):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
        if not isinstance(value, dict):
            raise ValueError("not an object")
        return value
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Problem(400, "INVALID_JSON", "Use one bounded JSON object.") from error


def read_config(path):
    ordinary(path)
    if os.name != "nt" and Path(path).stat().st_mode & 0o077:
        raise Problem(400, "WORKER_CONFIG", "The worker configuration must be private to its account.")
    with Path(path).open("rb") as stream:
        raw = stream.read(16385)
    if len(raw) > 16384:
        raise Problem(400, "WORKER_CONFIG", "The worker configuration is too large.")
    value = decode_json(raw)
    if (set(value) != {"version", "token", "imageRoot", "workerRoot"}
            or type(value["version"]) is not int or value["version"] != 1
            or not isinstance(value["token"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", value["token"])):
        raise Problem(400, "WORKER_CONFIG", "The worker configuration is unsupported.")
    for key in ("imageRoot", "workerRoot"):
        if not isinstance(value[key], str) or not Path(value[key]).is_absolute():
            raise Problem(400, "WORKER_CONFIG", "Worker directories must be absolute local paths.")
        value[key] = Path(value[key])
        ordinary(value[key], directory=True, missing=key == "workerRoot")
    if (value["workerRoot"] == value["imageRoot"] or value["workerRoot"].is_relative_to(value["imageRoot"])
            or value["imageRoot"].is_relative_to(value["workerRoot"])):
        raise Problem(400, "WORKER_CONFIG", "Worker job storage must be separate from the image installation.")
    return value


def fixed_ollama_json(path, body=None, timeout=10):
    connection = http.client.HTTPConnection("127.0.0.1", 11434, timeout=timeout)
    try:
        data = None if body is None else json.dumps(body).encode("utf-8")
        connection.request("GET" if data is None else "POST", path, body=data,
                           headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data else {})})
        response = connection.getresponse()
        raw = response.read(MAX_JSON + 1)
        if response.status != 200 or len(raw) > MAX_JSON or not response.getheader("Content-Type", "").lower().startswith("application/json"):
            raise ValueError("unusable local response")
        return decode_json(raw)
    except Exception as error:
        raise Problem(503, "AI_UNAVAILABLE", "The local AI is unavailable. Try again later.") from error
    finally:
        connection.close()


def close_connection(connection):
    try:
        if connection.sock:
            connection.sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    connection.close()


class Job:
    def __init__(self, identifier, directory, total, fingerprint, captions, created=None):
        self.id, self.directory, self.total, self.fingerprint = identifier, directory, total, fingerprint
        self.captions, self.created = captions, time.time() if created is None else created
        self.status, self.frames, self.message, self.code = "running", [], "Creating activity illustrations.", None
        self.cancel, self.thread = threading.Event(), None

    def public(self):
        result = {"version": 1, "id": self.id, "status": self.status, "completed": len(self.frames), "total": self.total,
                  "frames": [dict(frame) for frame in self.frames], "message": self.message}
        if self.code:
            result["code"] = self.code
        return result


class WorkerState:
    def __init__(self, engine, worker_root):
        self.engine = engine
        self.root = Path(worker_root).absolute()
        if not ordinary(self.root, directory=True, missing=True):
            self.root.mkdir(mode=0o700)
        self.jobs_root = self.root / "jobs"
        if not ordinary(self.jobs_root, directory=True, missing=True):
            self.jobs_root.mkdir(mode=0o700)
        self.lock, self.gate = threading.RLock(), threading.Lock()
        self.jobs, self.tombstones = {}, {}
        self.stop_event, self.poisoned = threading.Event(), False
        self.proxy_connection = None
        self._recover()

    def _persist(self, job):
        value = {"version": 1, "created": job.created, "requestHash": job.fingerprint, **job.public()}
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        if len(raw) > 16384:
            raise ValueError("bounded job metadata exceeded")
        temporary = job.directory / "job.json.new"
        ordinary(temporary, missing=True)
        temporary.write_bytes(raw)
        os.replace(temporary, job.directory / "job.json")

    def _recover(self):
        for directory in sorted(self.jobs_root.iterdir()):
            if not re.fullmatch(UUID_PATTERN, directory.name):
                continue
            try:
                ordinary(directory, directory=True)
                ordinary(directory / "job.json")
                with (directory / "job.json").open("rb") as stream:
                    raw = stream.read(16385)
                if len(raw) > 16384:
                    raise ValueError("oversized saved metadata")
                value = decode_json(raw)
                created, total = value.get("created"), value.get("total")
                if (type(value.get("version")) is not int or value.get("version") != 1 or value.get("id") != directory.name
                        or not isinstance(created, (float, int)) or not 0 <= time.time() - created <= JOB_TTL
                        or type(total) is not int or total not in range(1, 7)
                        or not isinstance(value.get("requestHash"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["requestHash"])):
                    self._discard_directory(directory)
                    continue
                job = Job(directory.name, directory, total, value.get("requestHash"), [], created)
                # A restarted worker never resumes inference or trusts an old PID.
                job.status, job.code, job.message = "failed", "WORKER_RESTARTED", "The AI worker restarted. Create the illustrations again."
                if value.get("status") == "complete":
                    frames = value.get("frames")
                    if not isinstance(frames, list) or len(frames) != total:
                        raise ValueError("invalid saved frames")
                    for step, frame in enumerate(frames, 1):
                        if (not isinstance(frame, dict) or type(frame.get("step")) is not int or frame["step"] != step
                                or not isinstance(frame.get("caption"), str) or len(frame["caption"]) > 500):
                            raise ValueError("invalid saved frame")
                        self._verified_image(job, frame)
                    job.frames = frames
                    job.status, job.code, job.message = "complete", None, "Illustrations are ready. Review them before use."
                elif value.get("status") == "cancelled":
                    job.status, job.code, job.message = "cancelled", None, "Image request cancelled."
                self.jobs[job.id] = job
                if job.status != "complete":
                    self._remove_outputs(job)
                self._persist(job)
            except (OSError, ValueError, Problem):
                self.jobs.pop(directory.name, None)
                self._discard_directory(directory)
        self._prune()

    @staticmethod
    def _discard_directory(directory):
        ordinary(directory, directory=True)
        for path in directory.rglob("*"):
            ordinary(path, directory=path.is_dir())
        shutil.rmtree(directory)

    def _remove_outputs(self, job):
        job.frames = []
        for child in job.directory.iterdir():
            if child.name == "job.json":
                continue
            ordinary(child, directory=child.is_dir())
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

    def _prune(self, reserve=False):
        now = time.time()
        self.tombstones = {key: expiry for key, expiry in self.tombstones.items() if expiry > now}
        for job in list(self.jobs.values()):
            if job.status != "running" and not (self.poisoned and job.code == "IMAGE_CLEANUP") and now - job.created > JOB_TTL:
                self._discard_directory(job.directory)
                self.jobs.pop(job.id, None)
        limit = MAX_JOBS - (1 if reserve else 0)
        for job in sorted(self.jobs.values(), key=lambda item: item.created):
            if len(self.jobs) <= limit:
                break
            if job.status != "running" and not (self.poisoned and job.code == "IMAGE_CLEANUP"):
                self._discard_directory(job.directory)
                self.jobs.pop(job.id, None)

    def status(self):
        available = not self.poisoned and self.engine.available()
        return {"enabled": True, "available": available, "busy": self.gate.locked(), "model": ENGINE.MODEL_FILE, "version": 1,
                "message": "Local activity illustrations are ready." if available else "Local activity illustrations are unavailable. Check the AI worker setup."}

    def start(self, value):
        if set(value) != {"name", "steps", "requestId"}:
            raise Problem(400, "IMAGE_INPUT", "Supply only the activity name, steps and request identifier.")
        identifier = canonical_id(value["requestId"])
        try:
            name, steps = ENGINE.validate_activity(value["name"], value["steps"])
        except Exception as error:
            raise Problem(400, "IMAGE_INPUT", "Use a short generic activity name and one to six plain-text steps.") from error
        fingerprint = hashlib.sha256(json.dumps({"name": name, "steps": steps}, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        with self.lock:
            self._prune()
            if identifier in self.tombstones:
                raise Problem(409, "IMAGE_CANCELLED", "This image request was cancelled.")
            existing = self.jobs.get(identifier)
            if existing:
                if existing.fingerprint != fingerprint:
                    raise Problem(409, "IMAGE_CONFLICT", "This request identifier belongs to different activity content.")
                return existing.public(), 202 if existing.status == "running" else 200
        if self.stop_event.is_set() or self.poisoned:
            raise Problem(503, "AI_UNAVAILABLE", "The local AI worker is unavailable.")
        if not self.gate.acquire(blocking=False):
            raise Problem(429, "AI_BUSY", "Another AI request is running. Try again shortly.")
        job = None
        try:
            with self.lock:
                if self.stop_event.is_set() or self.poisoned:
                    raise Problem(503, "AI_UNAVAILABLE", "The local AI worker is unavailable.")
                if identifier in self.tombstones:
                    raise Problem(409, "IMAGE_CANCELLED", "This image request was cancelled.")
                self._prune(reserve=True)
                if len(self.jobs) >= MAX_JOBS:
                    raise Problem(429, "AI_BUSY", "The image worker has reached its job limit. Try again later.")
                directory = self.jobs_root / identifier
                directory.mkdir(mode=0o700)
                job = Job(identifier, directory, len(steps), fingerprint, steps)
                self.jobs[identifier] = job
                self._persist(job)
            if not self.engine.available():
                raise Problem(503, "IMAGE_UNAVAILABLE", "The installed image model is unavailable.")
            loaded = fixed_ollama_json("/api/ps").get("models")
            if not isinstance(loaded, list):
                raise Problem(503, "AI_UNAVAILABLE", "The local text AI state could not be verified.")
            if loaded:
                raise Problem(429, "AI_BUSY", "A text model is loaded. Wait for the current AI work to finish.")
            with self.lock:
                if self.stop_event.is_set() or job.cancel.is_set():
                    raise Problem(409, "IMAGE_CANCELLED", "This image request was cancelled.")
                job.thread = threading.Thread(target=self._run_job, args=(job, name, steps), daemon=True)
                job.thread.start()
                return job.public(), 202
        except Exception:
            try:
                if job is not None:
                    with self.lock:
                        job.status = "cancelled" if job.cancel.is_set() else "failed"
                        job.code, job.message = "IMAGE_NOT_STARTED", "The image request could not start. Try again later."
                        try:
                            self._persist(job)
                        except (OSError, ValueError):
                            pass
            finally:
                self.gate.release()
            raise

    def _run_job(self, job, name, steps):
        cleanup_failed = False
        try:
            def frame_ready(frame):
                with self.lock:
                    if job.cancel.is_set():
                        return
                    step = frame.get("step")
                    if type(step) is not int or not 1 <= step <= job.total or any(item["step"] == step for item in job.frames):
                        raise ValueError("invalid engine frame")
                    record = {key: frame[key] for key in ("step", "sha256", "width", "height", "byteLength")}
                    record["caption"] = steps[step - 1]
                    self._verified_image(job, record)
                    job.frames.append(record)
                    job.frames.sort(key=lambda item: item["step"])
                    self._persist(job)
            self.engine.generate(name, steps, job.directory, job.cancel, frame_ready)
            with self.lock:
                if job.cancel.is_set():
                    job.status, job.message = "cancelled", "Image request cancelled."
                    self._remove_outputs(job)
                elif len(job.frames) == job.total:
                    job.status, job.message = "complete", "Illustrations are ready. Review them before use."
                else:
                    job.status, job.code, job.message = "failed", "IMAGE_INCOMPLETE", "The image worker could not finish every illustration."
                try:
                    self._persist(job)
                except (OSError, ValueError):
                    pass
        except Exception as error:
            cleanup_failed = getattr(error, "cleanup_failed", False) is True
            with self.lock:
                job.status = "cancelled" if job.cancel.is_set() and not cleanup_failed else "failed"
                job.code, job.message = ("IMAGE_CLEANUP", "The image process could not be stopped. Restart the AI worker.") if cleanup_failed else ("IMAGE_GENERATION_FAILED", "The illustrations could not be completed. Try again later.")
                if job.status == "cancelled":
                    self._remove_outputs(job)
                try:
                    self._persist(job)
                except (OSError, ValueError):
                    pass
        finally:
            if cleanup_failed:
                self.poisoned = True
            else:
                self.gate.release()

    def job(self, identifier):
        with self.lock:
            self._prune()
            job = self.jobs.get(identifier)
            if not job:
                raise Problem(404, "IMAGE_NOT_FOUND", "This image request is unavailable.")
            return job.public()

    def cancel(self, identifier):
        with self.lock:
            self._prune()
            job = self.jobs.get(identifier)
            if not job:
                if len(self.tombstones) >= MAX_TOMBSTONES:
                    self.tombstones.pop(min(self.tombstones, key=self.tombstones.get))
                self.tombstones[identifier] = time.time() + TOMBSTONE_TTL
                return {"version": 1, "id": identifier, "status": "cancelled", "completed": 0, "total": 0, "frames": [], "message": "Image request cancelled."}, 200
            job.cancel.set()
            if job.status == "running":
                return {**job.public(), "message": "Cancellation requested."}, 202
            if self.poisoned and job.code == "IMAGE_CLEANUP":
                return job.public(), 202
            self._remove_outputs(job)
            job.status, job.code, job.message = "cancelled", None, "Image request cancelled."
            self._persist(job)
            return job.public(), 200

    def image(self, identifier, step):
        with self.lock:
            job = self.jobs.get(identifier)
            if not job or job.status == "cancelled" or not any(frame["step"] == step for frame in job.frames):
                raise Problem(404, "IMAGE_NOT_FOUND", "This illustration is unavailable.")
            return self._verified_image(job, next(frame for frame in job.frames if frame["step"] == step))

    def _verified_image(self, job, frame):
        try:
            path = job.directory / f"step-{frame['step']}.png"
            ordinary(path)
            with path.open("rb") as stream:
                data = stream.read(MAX_PNG + 1)
            if (len(data) > MAX_PNG or frame.get("width") != 1024 or frame.get("height") != 1024
                    or frame.get("byteLength") != len(data) or hashlib.sha256(data).hexdigest() != frame.get("sha256")):
                raise ValueError("invalid image metadata")
            ENGINE.benchmark_helpers().sanitize_png(data, 1024)
            return data
        except Exception as error:
            raise Problem(503, "IMAGE_INVALID", "This illustration could not be verified.") from error

    def proxy_generate(self, value, disconnected=lambda: False, timeout=300):
        allowed = {"model", "prompt", "system", "format", "options", "think", "keep_alive", "stream"}
        model = value.get("model")
        if (not set(value).issubset(allowed) or value.get("stream") is not False or not isinstance(model, str)
                or len(model) > 128 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:-]*", model)
                or re.search(r"cloud|remote|://|:.*:", model, re.I)):
            raise Problem(400, "AI_INPUT", "Use a non-streaming request to a configured local text model.")
        if self.stop_event.is_set() or self.poisoned:
            raise Problem(503, "AI_UNAVAILABLE", "The local AI worker is unavailable.")
        if not self.gate.acquire(blocking=False):
            raise Problem(429, "AI_BUSY", "Another AI request is running. Try again shortly.")
        connection, thread, done, result = None, None, threading.Event(), {}
        try:
            if self.stop_event.is_set() or self.poisoned:
                raise Problem(503, "AI_UNAVAILABLE", "The local AI worker is unavailable.")
            if fixed_ollama_json("/api/status").get("cloud", {}).get("disabled") is not True:
                raise Problem(503, "AI_LOCAL_ONLY_REQUIRED", "The local text AI could not confirm that cloud access is disabled.")
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            if len(data) > 65536:
                raise Problem(413, "BODY_TOO_LARGE", "The text request is too large.")
            if self.stop_event.is_set():
                raise Problem(503, "AI_UNAVAILABLE", "The local AI worker is unavailable.")
            connection = http.client.HTTPConnection("127.0.0.1", 11434, timeout=timeout)
            self.proxy_connection = connection
            def perform():
                try:
                    if self.stop_event.is_set():
                        raise ValueError("worker stopped")
                    connection.request("POST", "/api/generate", body=data, headers={"Content-Type": "application/json", "Accept": "application/json"})
                    response = connection.getresponse()
                    raw = response.read(MAX_JSON + 1)
                    if response.status != 200 or len(raw) > MAX_JSON or not response.getheader("Content-Type", "").lower().startswith("application/json"):
                        raise ValueError("invalid local AI response")
                    result["value"] = decode_json(raw)
                except Exception:
                    result["error"] = True
                finally:
                    done.set()
            thread = threading.Thread(target=perform, daemon=True)
            thread.start()
            deadline = time.monotonic() + timeout
            while not done.wait(0.1):
                if self.stop_event.is_set() or disconnected() or time.monotonic() >= deadline:
                    close_connection(connection)
                    if not done.wait(2):
                        self.poisoned = True
                    raise Problem(503, "AI_CANCELLED", "The local text AI request was stopped.")
            if result.get("error"):
                raise Problem(503, "AI_UNAVAILABLE", "The local text AI is unavailable. Try again later.")
            if len(json.dumps(result["value"], ensure_ascii=False).encode("utf-8")) > MAX_JSON:
                raise Problem(503, "AI_UNAVAILABLE", "The local text AI returned too much data.")
            return result["value"]
        finally:
            if connection:
                close_connection(connection)
            self.proxy_connection = None
            if not self.poisoned:
                self.gate.release()

    def shutdown(self):
        self.stop_event.set()
        with self.lock:
            jobs = list(self.jobs.values())
            for job in jobs:
                job.cancel.set()
        if self.proxy_connection:
            close_connection(self.proxy_connection)
        for job in jobs:
            if job.thread:
                # A launch-option probe can take up to 45 seconds; cancellation
                # is checked immediately afterward before any GPU child starts.
                job.thread.join(timeout=55)


class WorkerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        pass

    def _reply(self, status, value, content_type="application/json"):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 429:
            self.send_header("Retry-After", "5")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _authorize(self):
        values = self.headers.get_all("Authorization", [])
        hosts = self.headers.get_all("Host", [])
        if (self.client_address[0] != "127.0.0.1" or self.headers.get_all("Origin", [])
                or len(values) != 1 or not values[0].isascii() or not hmac.compare_digest(values[0], "Bearer " + self.server.token)
                or len(hosts) != 1 or hosts[0] not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")):
            raise Problem(403, "FORBIDDEN", "Access denied.")
        if sum(len(key) + len(value) for key, value in self.headers.items()) > 16384:
            raise Problem(431, "HEADERS_TOO_LARGE", "The request headers are too large.")
        if not self.path.startswith("/") or any(character in self.path for character in "?#%"):
            raise Problem(400, "INVALID_PATH", "Use a fixed worker route without a query string.")

    def _body(self, limit):
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
            raise Problem(400, "INVALID_BODY", "Use one bounded JSON request body.")
        length = int(lengths[0])
        if not 0 < length <= limit:
            raise Problem(413, "BODY_TOO_LARGE", "The request body is empty or too large.")
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise Problem(415, "CONTENT_TYPE", "Use application/json.")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise Problem(400, "INVALID_BODY", "The JSON request body was incomplete.")
        return decode_json(raw)

    def _disconnected(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _handle(self):
        try:
            self._authorize()
            state = self.server.state
            if self.command == "GET" and self.path == "/api/activity-images/status":
                self._reply(200, state.status())
            elif self.command == "POST" and self.path == "/api/activity-images/jobs":
                value, status = state.start(self._body(16384))
                self._reply(status, value)
            elif self.command == "POST" and self.path == "/api/generate":
                self._reply(200, state.proxy_generate(self._body(65536), self._disconnected))
            elif self.command == "GET" and (match := FRAME_ROUTE.fullmatch(self.path)):
                self._reply(200, state.image(match[1], int(match[2])), "image/png")
            elif (match := JOB_ROUTE.fullmatch(self.path)) and self.command in ("GET", "DELETE"):
                if self.command == "GET":
                    self._reply(200, state.job(match[1]))
                else:
                    value, status = state.cancel(match[1])
                    self._reply(status, value)
            else:
                raise Problem(405 if self.command not in ("GET", "POST", "DELETE") else 404,
                              "INVALID_ROUTE", "This worker route or method is unavailable.")
        except Problem as error:
            self._reply(error.status, {"code": error.code, "message": str(error)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except OSError:
            try:
                self._reply(503, {"code": "WORKER_STORAGE", "message": "The local AI worker could not access its private storage."})
            except OSError:
                self.close_connection = True
        except Exception:
            self._reply(500, {"code": "WORKER_ERROR", "message": "The local AI worker could not complete this request."})

    do_GET = do_POST = do_DELETE = do_HEAD = do_OPTIONS = do_PUT = do_PATCH = do_TRACE = do_CONNECT = _handle


class WorkerServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, state, token):
        if address[0] != "127.0.0.1":
            raise ValueError("Only literal loopback binding is supported.")
        self.state, self.token = state, token
        self.slots = threading.BoundedSemaphore(8)
        self.next_prune = time.monotonic() + 60
        super().__init__(address, WorkerHandler)

    def service_actions(self):
        if time.monotonic() >= self.next_prune:
            self.next_prune = time.monotonic() + 60
            try:
                with self.state.lock:
                    self.state._prune()
            except (OSError, Problem):
                self.state.poisoned = True

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, *_):
        # Neither request bodies nor prompts are written to the background log.
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    state = None
    try:
        config = read_config(args.config)
        # Claim the one loopback listener before recovering or changing job
        # storage. A second launch must not disturb the running worker's jobs.
        with WorkerServer(("127.0.0.1", 11435), None, config["token"]) as server:
            state = WorkerState(ENGINE.GenericEngine(config["imageRoot"]), config["workerRoot"])
            server.state = state
            print("SKAO private AI worker ready on loopback.", flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            finally:
                # Retain the listener until owned work has stopped so another
                # worker cannot recover the same storage during normal shutdown.
                state.shutdown()
    except KeyboardInterrupt:
        return 0
    except Exception:
        print("WORKER_STARTUP: The private AI worker could not start. Check its protected setup.", file=sys.stderr)
        return 1
    finally:
        if state:
            state.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
