"""Synthetic HTTP/filesystem tests; no GPU, model downloads or Ollama changes."""
from contextlib import contextmanager
import importlib.util
import hashlib
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
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


SPEC = importlib.util.spec_from_file_location("activity_image_benchmark", Path(__file__).resolve().parents[1] / "run-activity-images.py")
BENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCH)
EXPECTED_SIMPLE_PROMPTS = (
    "Six large wooden toy cubes spread apart on a table: two red, two blue, two yellow. Simple educational diagram, plain cream background.",
    "Six large wooden toy cubes sorted into three separate pairs: two red together, two blue together, two yellow together. Simple educational diagram, plain cream background.",
    "A vertical tower of three wooden cubes: red bottom, blue middle, yellow top. Three spare cubes beside the tower: one red, one blue, one yellow. Simple educational diagram, plain cream background.",
    "Six large wooden toy cubes inside one open storage box: two red, two blue, two yellow. Simple educational diagram, plain cream background.",
)


class GalleryStructure(HTMLParser):
    def __init__(self, document):
        super().__init__()
        self.in_main = False
        self.in_details = False
        self.main_images = []
        self.reference_images = []
        self.details_attributes = []
        self.feed(document)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "main":
            self.in_main = True
        elif tag == "details":
            self.in_details = True
            self.details_attributes.append(attributes)
        elif tag == "img":
            if self.in_main:
                self.main_images.append(attributes.get("src"))
            if self.in_details:
                self.reference_images.append(attributes.get("src"))

    def handle_endtag(self, tag):
        if tag == "main":
            self.in_main = False
        elif tag == "details":
            self.in_details = False


def file_snapshot(directory):
    return {str(path.relative_to(directory)): ("link", os.readlink(path)) if path.is_symlink() else path.read_bytes()
            for path in directory.rglob("*") if path.is_symlink() or path.is_file()}


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)


def png(width=512, height=512, metadata=False, rgba=False):
    header = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6 if rgba else 2, 0, 0, 0))
    color = b"\xff\0\0\xff" if rgba else b"\xff\0\0"
    pixels = b"".join(b"\0" + color * width for _ in range(height))
    annotation = chunk(b"tEXt", b"workflow\0synthetic private metadata") if metadata else b""
    return b"\x89PNG\r\n\x1a\n" + header + annotation + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


@contextmanager
def http_server(callback):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            callback(self)

        def do_POST(self):
            callback(self)

        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def respond(handler, value, status=200, location=None):
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    if location:
        handler.send_header("Location", location)
    handler.end_headers()
    handler.wfile.write(raw)


class ClientTests(unittest.TestCase):
    def test_literal_local_address_only(self):
        for address in ("http://localhost:8188", "https://127.0.0.1:8188", "http://1.2.3.4:8188",
                        "http://user@127.0.0.1:8188", "http://127.0.0.1:8188/elsewhere", "http://127.0.0.1"):
            with self.subTest(address=address), self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.LocalJsonClient(address)

    def test_real_loopback_http_ignores_proxy_environment(self):
        with http_server(lambda handler: respond(handler, {"models": []})) as server:
            with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""}):
                client = BENCH.LocalJsonClient(f"http://127.0.0.1:{server.server_port}")
                self.assertEqual(client.request("/api/ps"), {"models": []})

    def test_redirect_is_rejected(self):
        with http_server(lambda handler: respond(handler, b"", 302, "http://example.invalid/")) as server:
            client = BENCH.LocalJsonClient(f"http://127.0.0.1:{server.server_port}")
            with self.assertRaises(BENCH.BenchmarkFailure) as error:
                client.request("/system_stats")
            self.assertEqual(error.exception.code, "HTTP_REDIRECT")

    def test_response_size_and_shape_are_bounded(self):
        for value, code in ((b"x" * (BENCH.MAX_JSON_BYTES + 1), "RESPONSE_SIZE"), (b"[]", "RESPONSE_SHAPE")):
            with self.subTest(code=code), http_server(lambda handler: respond(handler, value)) as server:
                client = BENCH.LocalJsonClient(f"http://127.0.0.1:{server.server_port}")
                with self.assertRaises(BENCH.BenchmarkFailure) as error:
                    client.request("/system_stats")
                self.assertEqual(error.exception.code, code)


class WorkflowTests(unittest.TestCase):
    def test_guided_workflow_uses_reference_rgb_for_latents_and_canny_conditioning(self):
        for step, positive in enumerate(EXPECTED_SIMPLE_PROMPTS):
            workflow = BENCH.build_workflow(BENCH.SDXL_MODEL_NAME, step, "skao_sdxl_guided_step1", guided_layout=True)
            self.assertNotIn("5", workflow)
            self.assertEqual(workflow["10"], {"class_type": "LoadImage", "inputs": {"image": f"layout-step-{step + 1}.png"}})
            self.assertEqual(workflow["11"], {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["4", 2]}})
            self.assertEqual(workflow["12"], {"class_type": "Canny", "inputs": {"image": ["10", 0], "low_threshold": 0.4, "high_threshold": 0.8}})
            self.assertEqual(workflow["13"], {"class_type": "ControlNetLoader", "inputs": {"control_net_name": BENCH.CONTROLNET_NAME}})
            self.assertEqual(workflow["14"]["inputs"], {"positive": ["6", 0], "negative": ["7", 0], "control_net": ["13", 0],
                                                        "image": ["12", 0], "strength": 0.8, "start_percent": 0.0,
                                                        "end_percent": 1.0, "vae": ["4", 2]})
            sampler = workflow["3"]["inputs"]
            self.assertEqual(sampler["latent_image"], ["11", 0])
            self.assertEqual(sampler["positive"], ["14", 0])
            self.assertEqual(sampler["negative"], ["14", 1])
            self.assertEqual(sampler["denoise"], 0.55)
            self.assertEqual((sampler["seed"], sampler["steps"], sampler["cfg"], sampler["sampler_name"], sampler["scheduler"]),
                             (482031927, 20, 7.0, "euler", "normal"))
            self.assertEqual(workflow["6"]["inputs"]["text_g"], positive)
            self.assertEqual(workflow["6"]["inputs"]["text_l"], positive)
            self.assertEqual(workflow["7"]["inputs"]["text_g"], BENCH.NEGATIVE)
        with self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.build_workflow(BENCH.MODEL_NAME, 0, "skao_sd15_guided_step1", guided_layout=True)

    def test_simple_trial_changes_only_positive_text_for_both_model_profiles(self):
        for model, slug in ((BENCH.MODEL_NAME, "sd15"), (BENCH.SDXL_MODEL_NAME, "sdxl")):
            for step, positive in enumerate(EXPECTED_SIMPLE_PROMPTS):
                with self.subTest(model=model, step=step):
                    prefix = "skao_" + slug + "_test_step1"
                    baseline = BENCH.build_workflow(model, step, prefix)
                    self.assertEqual(baseline, BENCH.build_workflow(model, step, prefix, simple_prompts=False))
                    trial = BENCH.build_workflow(model, step, prefix, simple_prompts=True)
                    expected = json.loads(json.dumps(baseline))
                    if model == BENCH.SDXL_MODEL_NAME:
                        self.assertEqual(baseline["6"]["inputs"]["text_g"], BENCH.STYLE + BENCH.SCENES[step])
                        expected["6"]["inputs"]["text_g"] = positive
                        expected["6"]["inputs"]["text_l"] = positive
                    else:
                        self.assertEqual(baseline["6"]["inputs"]["text"], BENCH.STYLE + BENCH.SCENES[step])
                        expected["6"]["inputs"]["text"] = positive
                    self.assertEqual(trial, expected)
                    self.assertLess(len(positive.split()), 45)
                    self.assertNotIn("no ", positive.lower())

    def test_sdxl_uses_native_1024_conditioning_and_same_comparison_prompts(self):
        for step in range(4):
            baseline = BENCH.build_workflow(BENCH.MODEL_NAME, step, "skao_sd15_test_step1")
            sdxl = BENCH.build_workflow(BENCH.SDXL_MODEL_NAME, step, "skao_sdxl_test_step1")
            self.assertEqual(sdxl["4"]["inputs"]["ckpt_name"], BENCH.SDXL_MODEL_NAME)
            self.assertEqual(sdxl["5"]["inputs"], {"width": 1024, "height": 1024, "batch_size": 1})
            self.assertEqual(sdxl["3"], baseline["3"])
            for node in ("6", "7"):
                text = baseline[node]["inputs"]["text"]
                self.assertEqual(sdxl[node], {"class_type": "CLIPTextEncodeSDXL", "inputs": {
                    "clip": ["4", 1], "width": 1024, "height": 1024, "crop_w": 0, "crop_h": 0,
                    "target_width": 1024, "target_height": 1024, "text_g": text, "text_l": text}})
            self.assertEqual(baseline["5"]["inputs"], {"width": 512, "height": 512, "batch_size": 1})
            self.assertEqual(baseline["6"]["class_type"], "CLIPTextEncode")
            self.assertEqual(baseline["7"]["class_type"], "CLIPTextEncode")

    def test_cross_profile_prefix_and_arbitrary_models_are_rejected(self):
        for model, prefix in ((BENCH.MODEL_NAME, "skao_sdxl_test_step1"),
                              (BENCH.SDXL_MODEL_NAME, "skao_sd15_test_step1"),
                              ("other.safetensors", "skao_sd15_test_step1"),
                              ("../sd_xl_base_1.0.safetensors", "skao_sdxl_test_step1")):
            with self.subTest(model=model, prefix=prefix), self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.build_workflow(model, 0, prefix)


class ImageTests(unittest.TestCase):
    def test_png_metadata_removed_while_pixel_chunks_are_preserved(self):
        cleaned = BENCH.sanitize_png(png(metadata=True))
        self.assertNotIn(b"workflow", cleaned)
        self.assertEqual(cleaned, png())

    def test_sdxl_png_uses_trusted_1024_size_and_strips_metadata(self):
        for rgba in (False, True):
            self.assertEqual(BENCH.sanitize_png(png(1024, 1024, metadata=True, rgba=rgba), 1024),
                             png(1024, 1024, rgba=rgba))

    def test_png_dimensions_must_match_the_selected_profile(self):
        for data, size in ((png(), 1024), (png(1024, 1024), 512), (png(), 2048), (png(), 512.0)):
            with self.subTest(size=size), self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.sanitize_png(data, size)

    def test_invalid_dimensions_checksum_and_pixel_data_rejected(self):
        invalid_crc = bytearray(png())
        invalid_crc[-1] ^= 1
        bad_pixels = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 512, 512, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"short")) + chunk(b"IEND", b"")
        for data in (png(1, 1), bytes(invalid_crc), png()[:-8], png() + b"trailing", bad_pixels):
            with self.subTest(size=len(data)), self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.sanitize_png(data)

    def test_decompression_bomb_is_bounded(self):
        data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 512, 512, 8, 2, 0, 0, 0))
        data += chunk(b"IDAT", zlib.compress(b"\0" * 5_000_000)) + chunk(b"IEND", b"")
        with self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.sanitize_png(data)

    def test_sdxl_rgba_decompression_is_bounded(self):
        data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1024, 1024, 8, 6, 0, 0, 0))
        data += chunk(b"IDAT", zlib.compress(b"\0" * 5_000_000)) + chunk(b"IEND", b"")
        with self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.sanitize_png(data, 1024)

    def test_output_path_must_be_exactly_own_saveimage_file(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            prefix = "skao_sd15_test_step1"
            filename = prefix + "_00001_.png"
            (directory / filename).write_bytes(png())
            good = {"filename": filename, "subfolder": "", "type": "output"}
            BENCH.validate_and_copy_image(directory, good, prefix, directory / "review.png")
            self.assertTrue((directory / "review.png").is_file())
            for changes in ({"filename": "../" + filename}, {"subfolder": "../"}, {"type": "input"}, {"filename": "other_00001_.png"}):
                with self.subTest(changes=changes), self.assertRaises(BENCH.BenchmarkFailure):
                    BENCH.validate_and_copy_image(directory, {**good, **changes}, prefix, directory / "bad.png")


class HistoryTests(unittest.TestCase):
    def test_failed_or_interrupted_job_never_becomes_an_image(self):
        for status in ("error", "interrupted", "unknown"):
            entry = {"job": {"status": {"completed": True, "status_str": status}, "outputs": {}}}
            with self.subTest(status=status), http_server(lambda handler: respond(handler, entry)) as server:
                client = BENCH.LocalJsonClient(f"http://127.0.0.1:{server.server_port}")
                with self.assertRaises(BENCH.BenchmarkFailure):
                    BENCH.wait_for_image(client, "job", time.monotonic() + 2, SimpleNamespace(poll=lambda: None))

    def test_pending_job_times_out(self):
        with http_server(lambda handler: respond(handler, {})) as server:
            client = BENCH.LocalJsonClient(f"http://127.0.0.1:{server.server_port}")
            with self.assertRaises(BENCH.BenchmarkFailure) as error:
                BENCH.wait_for_image(client, "job", time.monotonic() + 0.05, SimpleNamespace(poll=lambda: None))
            self.assertEqual(error.exception.code, "GENERATION_TIMEOUT")


class StartupBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.scripts = self.root / "ComfyUI"
        self.scripts.mkdir()
        (self.scripts / "av.py").write_text(
            "import builtins\nbuiltins.skao_fixture_av_preloaded = True\n__version__ = 'fixture-av'\n", encoding="utf-8")
        self.main = self.scripts / "main.py"
        self.ready = self.root / "ready.signal"

    def tearDown(self):
        self.temporary.cleanup()

    def test_real_python_preloads_av_and_preserves_script_context(self):
        (self.scripts / "sibling.py").write_text("VALUE = 'sibling import works'\n", encoding="utf-8")
        self.main.write_text(
            "import builtins, json, os, sys\nimport sibling\n"
            "print('CONTEXT=' + json.dumps({'preloaded': builtins.skao_fixture_av_preloaded, "
            "'av_version': sys.modules['av'].__version__, 'file': __file__, 'name': __name__, "
            "'argv': sys.argv, 'cwd': os.getcwd(), 'sibling': sibling.VALUE}), flush=True)\n", encoding="utf-8")
        command = BENCH.build_startup_command(sys.executable, self.main, ["--example", "two words"], self.ready, trace_delay=0.2)
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=5, env=BENCH.offline_environment())
        self.assertEqual(result.returncode, 0, result.stderr)
        context = json.loads(next(line[len("CONTEXT="):] for line in result.stdout.splitlines() if line.startswith("CONTEXT=")))
        self.assertTrue(context["preloaded"])
        self.assertEqual(context["av_version"], "fixture-av")
        self.assertEqual(Path(context["file"]), self.main)
        self.assertEqual(context["name"], "__main__")
        self.assertEqual(context["argv"], [str(self.main), "--example", "two words"])
        self.assertEqual(Path(context["cwd"]), self.root)
        self.assertEqual(context["sibling"], "sibling import works")
        self.assertLess(result.stdout.index("PyAV fixture-av loaded"), result.stdout.index("entering ComfyUI"))

    def test_ready_marker_cancels_startup_trace_timer(self):
        entered, release = self.root / "entered", self.root / "release"
        self.main.write_text(
            "import pathlib, time\npathlib.Path('entered').touch()\n"
            "while not pathlib.Path('release').exists():\n    time.sleep(0.02)\n", encoding="utf-8")
        log = self.root / "runtime.log"
        with log.open("wb") as stream:
            process = subprocess.Popen(BENCH.build_startup_command(sys.executable, self.main, [], self.ready, trace_delay=0.3),
                                       cwd=self.root, stdout=stream, stderr=subprocess.STDOUT, env=BENCH.offline_environment())
            try:
                deadline = time.monotonic() + 3
                while not entered.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(entered.exists(), log.read_text())
                self.ready.touch()
                while "startup stack timer stopped" not in log.read_text() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertIn("startup stack timer stopped", log.read_text())
                time.sleep(0.4)
                self.assertIsNone(process.poll())
                release.touch()
                self.assertEqual(process.wait(timeout=3), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=3)
        self.assertNotIn("Timeout (", log.read_text())


class RuntimeLogTests(unittest.TestCase):
    def test_cli_guided_flag_is_optional_and_forwarded(self):
        with tempfile.TemporaryDirectory() as root:
            for extra, enabled in (([], False), (["--guided-layout", "--model", BENCH.SDXL_MODEL_NAME], True)):
                runner = SimpleNamespace(run_directory=Path(root), run=lambda: None)
                with self.subTest(enabled=enabled), patch.object(BENCH, "BenchmarkRunner", return_value=runner) as constructor, \
                     patch.object(sys, "stdout", new_callable=io.StringIO):
                    self.assertEqual(BENCH.main(["--runtime", root, "--output", root, *extra]), 0)
                    self.assertEqual(constructor.call_args.kwargs["guided_layout"], enabled)

    def test_cli_simple_prompt_flag_is_optional_and_forwarded(self):
        with tempfile.TemporaryDirectory() as root:
            for extra, enabled in (([], False), (["--simple-prompts"], True)):
                runner = SimpleNamespace(run_directory=Path(root), run=lambda: None)
                with self.subTest(enabled=enabled), patch.object(BENCH, "BenchmarkRunner", return_value=runner) as constructor, \
                     patch.object(sys, "stdout", new_callable=io.StringIO):
                    self.assertEqual(BENCH.main(["--runtime", root, "--output", root, *extra]), 0)
                    self.assertEqual(constructor.call_args.kwargs["simple_prompts"], enabled)

    def test_tail_is_bounded_by_bytes_and_lines(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "runtime.log").write_bytes((b"line " + b"x" * 400 + b"\n") * 500 + b"\xff" * 30 + b"\nLAST STACK LINE\n")
            tail = BENCH.runtime_log_tail(directory)
            self.assertLessEqual(len(tail.encode("utf-8")), 16_384)
            self.assertLessEqual(len(tail.splitlines()), 60)
            self.assertTrue(tail.endswith("LAST STACK LINE"))

    def test_main_prints_bounded_log_tail_and_log_read_failure_does_not_mask_error(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            log = directory / "runtime.log"
            log.write_text("synthetic stack line\n" * 2000 + "LAST STACK LINE\n", encoding="utf-8")
            runner = SimpleNamespace(run_directory=directory, run=lambda: (_ for _ in ()).throw(BENCH.BenchmarkFailure("SYNTHETIC", "Original failure")))
            args = ["--runtime", str(directory), "--output", str(directory)]
            with patch.object(BENCH, "BenchmarkRunner", return_value=runner), patch.object(sys, "stderr", new_callable=io.StringIO) as error:
                self.assertEqual(BENCH.main(args), 1)
                output = error.getvalue()
            self.assertIn("SYNTHETIC: Original failure", output)
            self.assertIn("Recent local runtime messages", output)
            self.assertIn("LAST STACK LINE", output)
            self.assertLess(len(output.encode("utf-8")), 17_000)
            log.unlink()
            log.mkdir()
            with patch.object(BENCH, "BenchmarkRunner", return_value=runner), patch.object(sys, "stderr", new_callable=io.StringIO) as error:
                self.assertEqual(BENCH.main(args), 1)
                self.assertIn("SYNTHETIC: Original failure", error.getvalue())


class GalleryRefreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "saved-run"
        self.directory.mkdir()
        (self.directory / "input").mkdir()
        self.report = {"schemaVersion": 1, "model": BENCH.SDXL_MODEL_NAME, "promptProfile": "guided-canny-layout-v1", "requestedImages": 4,
                       "images": [], "guidance": {"references": []}, "complete": True}
        data = png(1024, 1024, metadata=True)
        for step in range(1, 5):
            (self.directory / f"step-{step}.png").write_bytes(data)
            (self.directory / "input" / f"layout-step-{step}.png").write_bytes(data)
            self.report["images"].append({"step": step, "file": f"step-{step}.png", "caption": BENCH.CAPTIONS[step - 1]})
            self.report["guidance"]["references"].append({"step": step, "file": f"input/layout-step-{step}.png", "sha256": hashlib.sha256(data).hexdigest()})
        self.save_report()
        (self.directory / "review.html").write_bytes(b"Original review with duplicate-looking step panels.\n")

    def tearDown(self):
        self.temporary.cleanup()

    def save_report(self):
        (self.directory / "report.json").write_text(json.dumps(self.report), encoding="utf-8")

    def test_refresh_only_changes_html_and_preserves_first_backup_on_repeat(self):
        before = file_snapshot(self.directory)
        with patch.object(BENCH, "LocalJsonClient", side_effect=AssertionError("network must not run")), \
             patch.object(BENCH.subprocess, "Popen", side_effect=AssertionError("process must not start")), \
             patch.object(BENCH.subprocess, "run", side_effect=AssertionError("help or GPU probe must not run")), \
             patch.object(BENCH, "create_guidance_layouts", side_effect=AssertionError("layout rendering must not run")):
            result = BENCH.refresh_review(self.directory)
            after_first = file_snapshot(self.directory)
            self.assertEqual(BENCH.refresh_review(self.directory), result)
        self.assertEqual(result, self.directory / "review.html")
        self.assertEqual(file_snapshot(self.directory), after_first)
        self.assertEqual((self.directory / "review-before-update.html").read_bytes(), before["review.html"])
        for name, data in before.items():
            if name != "review.html":
                self.assertEqual(after_first[name], data)
        parsed = GalleryStructure(result.read_text())
        self.assertEqual(parsed.main_images, [f"step-{step}.png" for step in range(1, 5)])
        self.assertEqual(parsed.reference_images, [f"input/layout-step-{step}.png" for step in range(1, 5)])
        self.assertEqual(parsed.details_attributes, [{}])

    def test_refresh_cli_needs_no_generation_arguments_and_rejects_explicit_generation_flags(self):
        with patch.object(BENCH, "BenchmarkRunner", side_effect=AssertionError("generation must not run")), \
             patch.object(sys, "stdout", new_callable=io.StringIO) as output:
            self.assertEqual(BENCH.main(["--refresh-review", str(self.directory)]), 0)
        self.assertIn(str(self.directory / "review.html"), output.getvalue())
        before = file_snapshot(self.directory)
        for flags in (["--runtime", str(self.directory)], ["--output", str(self.directory)], ["--model", BENCH.MODEL_NAME],
                      ["--count", "1"], ["--simple-prompts"], ["--guided-layout"]):
            with self.subTest(flags=flags), patch.object(BENCH, "refresh_review") as refresh, \
                 patch.object(sys, "stderr", new_callable=io.StringIO), self.assertRaises(SystemExit) as error:
                BENCH.main(["--refresh-review", str(self.directory), *flags])
            self.assertEqual(error.exception.code, 2)
            refresh.assert_not_called()
            self.assertEqual(file_snapshot(self.directory), before)

    def test_partial_and_failed_reports_show_only_completed_generated_outputs(self):
        self.report["images"] = self.report["images"][:2]
        self.report["complete"] = False
        self.save_report()
        BENCH.refresh_review(self.directory)
        parsed = GalleryStructure((self.directory / "review.html").read_text())
        self.assertEqual(parsed.main_images, ["step-1.png", "step-2.png"])
        self.assertEqual(len(parsed.reference_images), 4)
        self.report["images"] = []
        self.save_report()
        BENCH.refresh_review(self.directory)
        document = (self.directory / "review.html").read_text()
        self.assertEqual(GalleryStructure(document).main_images, [])
        self.assertIn("no completed illustrations", document)

    def test_legacy_version_one_report_without_prompt_profile_refreshes_as_baseline(self):
        self.report.pop("promptProfile")
        self.report.pop("guidance")
        self.report["model"] = BENCH.MODEL_NAME
        for step in range(1, 5):
            (self.directory / f"step-{step}.png").write_bytes(png())
        self.save_report()
        before = file_snapshot(self.directory)
        BENCH.refresh_review(self.directory)
        document = (self.directory / "review.html").read_text()
        parsed = GalleryStructure(document)
        self.assertEqual(parsed.main_images, [f"step-{step}.png" for step in range(1, 5)])
        self.assertEqual(parsed.reference_images, [])
        self.assertNotIn("Simple prompts", document)
        self.assertIn("SD1.5 activity image test", document)
        self.assertEqual((self.directory / "report.json").read_bytes(), before["report.json"])

    def test_invalid_report_models_paths_steps_and_sizes_leave_all_files_untouched(self):
        valid = json.loads(json.dumps(self.report))
        cases = (lambda report: report["images"][0].update(file="../outside.png"),
                 lambda report: report["images"][0].update(file="https://example.invalid/step-1.png"),
                 lambda report: report["guidance"]["references"][0].update(file="input/../step-1.png"),
                 lambda report: report["images"][0].update(step=True),
                 lambda report: report["images"][1].update(step=1, file="step-1.png"),
                 lambda report: report.update(model="unknown.safetensors"),
                 lambda report: report.update(promptProfile="unknown-profile"),
                 lambda report: report.update(schemaVersion=2),
                 lambda report: report.update(model=BENCH.MODEL_NAME),
                 lambda report: report.update(requestedImages=3))
        for mutate in cases:
            self.report = json.loads(json.dumps(valid))
            mutate(self.report)
            self.save_report()
            before = file_snapshot(self.directory)
            with self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.refresh_review(self.directory)
            self.assertEqual(file_snapshot(self.directory), before)
        for invalid in (b"x" * (BENCH.MAX_JSON_BYTES + 1), b'{"nested":' + b'[' * 1100 + b'0' + b']' * 1100 + b'}'):
            (self.directory / "report.json").write_bytes(invalid)
            before = file_snapshot(self.directory)
            with self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.refresh_review(self.directory)
            self.assertEqual(file_snapshot(self.directory), before)

    def test_invalid_saved_png_preserves_page_and_does_not_create_backup(self):
        (self.directory / "step-1.png").write_bytes(png())
        before = file_snapshot(self.directory)
        with self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.refresh_review(self.directory)
        self.assertEqual(file_snapshot(self.directory), before)
        self.assertFalse((self.directory / "review-before-update.html").exists())

    def test_symlink_assets_pages_backups_and_result_directory_are_rejected(self):
        external = Path(self.temporary.name) / "outside.png"
        external.write_bytes(png(1024, 1024))
        for name in ("step-1.png", "review.html", "review-before-update.html"):
            path = self.directory / name
            original = path.read_bytes() if path.exists() else None
            if path.exists():
                path.unlink()
            try:
                path.symlink_to(external)
            except OSError:
                if original is not None:
                    path.write_bytes(original)
                self.skipTest("Symbolic links are unavailable in this test environment.")
            before = file_snapshot(self.directory)
            with self.assertRaises(BENCH.BenchmarkFailure):
                BENCH.refresh_review(self.directory)
            self.assertEqual(file_snapshot(self.directory), before)
            path.unlink()
            if original is not None:
                path.write_bytes(original)
        link = Path(self.temporary.name) / "linked-result"
        link.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.refresh_review(link)

    def test_windows_reparse_attributes_are_rejected_before_writes(self):
        original = Path.lstat
        def inspect(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == self.directory:
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        before = file_snapshot(self.directory)
        with patch.object(Path, "lstat", inspect), self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.refresh_review(self.directory)
        self.assertEqual(file_snapshot(self.directory), before)

    def test_backup_copy_failure_preserves_original_and_does_not_publish_partial_backup(self):
        before = file_snapshot(self.directory)
        def failed_copy(source, target):
            target.write(b"partial")
            raise OSError("synthetic copy failure")
        with patch.object(BENCH.shutil, "copyfileobj", side_effect=failed_copy), self.assertRaises(BENCH.BenchmarkFailure):
            BENCH.refresh_review(self.directory)
        self.assertEqual(file_snapshot(self.directory), before)
        BENCH.refresh_review(self.directory)
        self.assertEqual((self.directory / "review-before-update.html").read_bytes(), before["review.html"])


class FakeProcess:
    """Serve the real HTTP protocol without launching ComfyUI or using a GPU."""
    def __init__(self, command, *, reject=False, interrupt=False, malformed=False, wrong_size=None,
                 missing_guidance_node=None, missing_guidance_input=None, **_):
        self.command = command
        self.returncode = None
        self.stopped = False
        self.jobs = {}
        self.requests = []
        self.reject, self.interrupt, self.malformed = reject, interrupt, malformed
        self.wrong_size = wrong_size
        self.output = Path(command[command.index("--output-directory") + 1])
        self.input = Path(command[command.index("--input-directory") + 1]) if "--input-directory" in command else None
        self.inputs_at_launch = sorted(path.name for path in self.input.iterdir()) if self.input else []
        self.references_used = []
        port = int(command[command.index("--port") + 1])
        process = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                process.requests.append(("GET", self.path))
                if self.path == "/system_stats":
                    respond(self, {"devices": [{"name": "Synthetic CUDA", "type": "cuda", "vram_total": 6 * 1024**3}]})
                elif self.path.startswith("/history/"):
                    job_id = self.path.rsplit("/", 1)[-1]
                    respond(self, {job_id: process.jobs[job_id]})
                elif self.path.startswith("/object_info/"):
                    name = self.path.rsplit("/", 1)[-1]
                    if name == missing_guidance_node:
                        respond(self, {})
                    else:
                        fields = {field: ["SYNTHETIC"] for field in BENCH.GUIDANCE_NODE_INPUTS[name]}
                        optional = {"vae": fields.pop("vae")} if name == "ControlNetApplyAdvanced" else {}
                        if missing_guidance_input and missing_guidance_input[0] == name:
                            fields.pop(missing_guidance_input[1], None)
                            optional.pop(missing_guidance_input[1], None)
                        respond(self, {name: {"input": {"required": fields, "optional": optional}}})
                else:
                    respond(self, {}, 404)

            def do_POST(self):
                process.requests.append(("POST", self.path))
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                workflow = request["prompt"]
                self.server.workflows.append(workflow)
                if process.reject:
                    respond(self, {"node_errors": {"3": {"errors": ["synthetic rejection"]}}})
                    return
                prefix = workflow["9"]["inputs"]["filename_prefix"]
                filename = prefix + "_00001_.png"
                latent = workflow["5"]["inputs"] if "5" in workflow else workflow["6"]["inputs"]
                if "10" in workflow:
                    reference = workflow["10"]["inputs"]["image"]
                    if process.input is None or not (process.input / reference).is_file():
                        respond(self, {"error": "missing synthetic input"}, 400)
                        return
                    process.references_used.append(reference)
                width = process.wrong_size or latent["width"]
                height = process.wrong_size or latent["height"]
                (process.output / filename).write_bytes(b"invalid" if process.malformed else png(width, height, metadata=True))
                job_id = "job-" + str(len(process.jobs) + 1)
                process.jobs[job_id] = {"status": {"completed": True, "status_str": "interrupted" if process.interrupt else "success"},
                                        "outputs": {"9": {"images": [{"filename": filename, "subfolder": "", "type": "output"}]}}}
                respond(self, {"prompt_id": job_id, "node_errors": {}})

            def log_message(self, *_):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.workflows = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def poll(self):
        return self.returncode

    def terminate(self):
        self.stopped = True
        self.returncode = -15
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def wait(self, timeout=None):
        return self.returncode


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        for path in (self.runtime / "python_embeded" / "python.exe", self.runtime / "ComfyUI" / "main.py",
                     self.runtime / "ComfyUI" / "models" / "checkpoints" / BENCH.MODEL_NAME,
                     self.runtime / "ComfyUI" / "models" / "checkpoints" / BENCH.SDXL_MODEL_NAME,
                     self.runtime / "ComfyUI" / "models" / "controlnet" / BENCH.CONTROLNET_NAME):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic fixture")
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
        self.temporary.cleanup()

    @contextmanager
    def dependencies(self, models=None, reject=False, interrupt=False, malformed=False, wrong_size=None,
                     missing_guidance_node=None, missing_guidance_input=None):
        original_client = BENCH.LocalJsonClient
        def client(base):
            if base == "http://127.0.0.1:11434":
                return SimpleNamespace(request=lambda path, **kwargs: {"models": [] if models is None else models})
            return original_client(base)
        def process(*args, **kwargs):
            result = FakeProcess(*args, reject=reject, interrupt=interrupt, malformed=malformed, wrong_size=wrong_size,
                                 missing_guidance_node=missing_guidance_node, missing_guidance_input=missing_guidance_input, **kwargs)
            self.processes.append(result)
            return result
        with patch.object(BENCH, "LocalJsonClient", side_effect=client), \
             patch.object(BENCH.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=" ".join(BENCH.REQUIRED_FLAGS) + " --input-directory")), \
             patch.object(BENCH.subprocess, "Popen", side_effect=process), \
             patch.object(BENCH.DeviceMemorySampler, "start"), \
             patch.object(BENCH.DeviceMemorySampler, "stop", return_value=[]):
            yield

    def test_four_images_use_one_owned_process_and_save_readable_report(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results", 4)
        with self.dependencies():
            report = runner.run()
        self.assertTrue(report["complete"])
        self.assertEqual(len(report["images"]), 4)
        self.assertEqual(len(self.processes), 1)
        process = self.processes[0]
        self.assertTrue(process.stopped)
        self.assertEqual(process.command[process.command.index("--listen") + 1], "127.0.0.1")
        self.assertIn("--disable-all-custom-nodes", process.command)
        self.assertIn("--offline", process.command)
        self.assertNotIn("--force-fp32", process.command)
        self.assertTrue(all(workflow["5"]["inputs"]["batch_size"] == 1 for workflow in process.server.workflows))
        self.assertEqual(len({workflow["6"]["inputs"]["text"] for workflow in process.server.workflows}), 4)
        for image in report["images"]:
            self.assertNotIn(b"workflow", (runner.run_directory / image["file"]).read_bytes())
        saved = json.loads((runner.run_directory / "report.json").read_text())
        self.assertTrue(saved["complete"])
        self.assertEqual(saved["status"], "completed")
        self.assertTrue(saved["configuration"]["preloadedAV"])
        self.assertTrue(saved["configuration"]["startupStackEnabled"])
        self.assertEqual(saved["promptProfile"], "baseline")
        self.assertEqual(saved["prompts"], [{"step": step + 1, "positive": BENCH.STYLE + BENCH.SCENES[step], "negative": BENCH.NEGATIVE}
                                           for step in range(4)])
        self.assertTrue((runner.run_directory / "startup-ready.signal").is_file())
        self.assertIn("Step 4", (runner.run_directory / "review.html").read_text())
        self.assertNotIn("Simple prompts", (runner.run_directory / "review.html").read_text())
        self.assertFalse(runner.run_directory.name.startswith("sd15-simple-"))

    def test_guided_run_prepares_four_local_inputs_before_launch_and_records_guidance(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", 4, guided_layout=True)
        with self.dependencies():
            report = runner.run()
        self.assertTrue(report["complete"])
        self.assertEqual(report["promptProfile"], "guided-canny-layout-v1")
        self.assertEqual([entry["positive"] for entry in report["prompts"]], list(EXPECTED_SIMPLE_PROMPTS))
        self.assertTrue(runner.run_directory.name.startswith("sdxl-guided-"))
        self.assertEqual(report["configuration"]["denoise"], 0.55)
        expected_files = [f"layout-step-{step}.png" for step in range(1, 5)]
        process = self.processes[-1]
        self.assertEqual(process.inputs_at_launch, expected_files)
        self.assertEqual(process.references_used, expected_files)
        self.assertEqual(process.input, runner.run_directory / "input")
        self.assertTrue(process.stopped)
        self.assertEqual([path for method, path in process.requests if path.startswith("/object_info/")],
                         ["/object_info/" + name for name in BENCH.GUIDANCE_NODE_INPUTS])
        self.assertNotIn(("GET", "/object_info"), process.requests)
        self.assertEqual(len(process.server.workflows), 4)
        for step, workflow in enumerate(process.server.workflows):
            self.assertEqual(workflow, BENCH.build_workflow(BENCH.SDXL_MODEL_NAME, step, workflow["9"]["inputs"]["filename_prefix"], guided_layout=True))
        guidance = report["guidance"]
        self.assertEqual(guidance["controlNetFile"], BENCH.CONTROLNET_NAME)
        self.assertEqual((guidance["strength"], guidance["cannyLowThreshold"], guidance["cannyHighThreshold"], guidance["denoise"]), (0.8, 0.4, 0.8, 0.55))
        for reference in guidance["references"]:
            path = runner.run_directory / reference["file"]
            self.assertEqual(reference["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(BENCH.sanitize_png(path.read_bytes(), 1024), path.read_bytes())
        gallery = (runner.run_directory / "review.html").read_text()
        self.assertIn("Guided layout", gallery)
        self.assertIn("REFERENCE - Step 1 (created by code)", gallery)
        self.assertIn("GENERATED - Step 1", gallery)
        self.assertIn('src="input/layout-step-4.png"', gallery)
        self.assertIn('src="step-4.png"', gallery)
        self.assertTrue(report["processStopped"])
        parsed = GalleryStructure(gallery)
        self.assertEqual(parsed.main_images, [f"step-{step}.png" for step in range(1, 5)])
        self.assertEqual(parsed.reference_images, [f"input/layout-step-{step}.png" for step in range(1, 5)])
        self.assertEqual(parsed.details_attributes, [{}])
        original_assets = {name: data for name, data in file_snapshot(runner.run_directory).items()
                           if name.endswith(".png") or name == "report.json"}
        with patch.object(BENCH, "LocalJsonClient", side_effect=AssertionError("refresh must not contact services")), \
             patch.object(BENCH.subprocess, "Popen", side_effect=AssertionError("refresh must not start ComfyUI")), \
             patch.object(BENCH.subprocess, "run", side_effect=AssertionError("refresh must not probe GPU")), \
             patch.object(BENCH, "create_guidance_layouts", side_effect=AssertionError("refresh must not render references")):
            BENCH.refresh_review(runner.run_directory)
        for name, data in original_assets.items():
            self.assertEqual((runner.run_directory / name).read_bytes(), data)

    def test_guided_one_image_default_keeps_only_one_reference_and_one_generation(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", guided_layout=True)
        with self.dependencies():
            report = runner.run()
        self.assertEqual(report["requestedImages"], 1)
        self.assertEqual(len(report["images"]), 1)
        self.assertEqual(len(report["guidance"]["references"]), 1)
        self.assertEqual(self.processes[-1].inputs_at_launch, ["layout-step-1.png"])

    def test_guided_requires_exact_sdxl_before_any_output_write(self):
        output = self.root / "never-created"
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, output, guided_layout=True)
        with self.dependencies(), self.assertRaises(BENCH.BenchmarkFailure) as error:
            runner.run()
        self.assertEqual(error.exception.code, "ARGUMENTS")
        self.assertFalse(output.exists())
        self.assertEqual(self.processes, [])

    def test_guided_missing_model_or_input_flag_fails_before_launch(self):
        control = self.runtime / "ComfyUI" / "models" / "controlnet" / BENCH.CONTROLNET_NAME
        control.unlink()
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", guided_layout=True)
        with self.dependencies(), self.assertRaises(BENCH.BenchmarkFailure) as error:
            runner.run()
        self.assertEqual(error.exception.code, "GUIDANCE_MODEL")
        control.write_bytes(b"synthetic guidance")
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", guided_layout=True)
        with self.dependencies(), patch.object(BENCH.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=" ".join(BENCH.REQUIRED_FLAGS))):
            with self.assertRaises(BENCH.BenchmarkFailure) as error:
                runner.run()
        self.assertEqual(error.exception.code, "RUNTIME_FLAGS")
        self.assertFalse((runner.run_directory / "input").exists())
        self.assertEqual(self.processes, [])

    def test_guidance_helper_is_lazy_and_missing_or_unsafe_helper_has_clear_stage(self):
        tools = self.root / "synthetic-tools"
        tools.mkdir()
        runner_path = tools / "run-activity-images.py"
        for unsafe in (False, True):
            if unsafe:
                (tools / "activity_image_layouts.py").write_text(
                    "def create_layouts(directory, count, size):\n    return [{'step': 1, 'file': '../escape.png'}]\n", encoding="utf-8")
            runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", guided_layout=True)
            with self.dependencies(), patch.object(BENCH, "__file__", str(runner_path)):
                with self.assertRaises(BENCH.BenchmarkFailure) as error:
                    runner.run()
            self.assertEqual(error.exception.code, "GUIDANCE_LAYOUT")
            self.assertEqual(self.processes, [])
        baseline = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results")
        with self.dependencies(), patch.object(BENCH, "__file__", str(runner_path)):
            report = baseline.run()
        self.assertTrue(report["complete"])
        self.assertIsNone(self.processes[-1].input)

    def test_guidance_missing_nodes_or_inputs_fail_before_queue_and_cleanup_owned_process(self):
        for options in ({"missing_guidance_node": "Canny"}, {"missing_guidance_input": ("ControlNetApplyAdvanced", "vae")}):
            with self.subTest(options=options):
                runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", guided_layout=True)
                with self.dependencies(**options), self.assertRaises(BENCH.BenchmarkFailure) as error:
                    runner.run()
                self.assertEqual(error.exception.code, "GUIDANCE_NODES")
                process = self.processes[-1]
                self.assertTrue(process.stopped)
                self.assertEqual(process.server.workflows, [])
                report = json.loads((runner.run_directory / "report.json").read_text())
                self.assertFalse(report["complete"])
                self.assertTrue(report["processStopped"])
                self.assertEqual(len(report["guidance"]["references"]), 1)
                gallery = (runner.run_directory / "review.html").read_text()
                self.assertIn("REFERENCE - Step 1 (created by code)", gallery)
                self.assertIn("no completed illustration", gallery)

    def test_guided_rejected_generation_keeps_reference_and_incomplete_report(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", guided_layout=True)
        with self.dependencies(reject=True), self.assertRaises(BENCH.BenchmarkFailure) as error:
            runner.run()
        self.assertEqual(error.exception.code, "WORKFLOW_REJECTED")
        report = json.loads((runner.run_directory / "report.json").read_text())
        self.assertFalse(report["complete"])
        self.assertEqual(report["images"], [])
        self.assertTrue((runner.run_directory / "input" / "layout-step-1.png").is_file())
        self.assertTrue(report["processStopped"])

    def test_simple_trial_http_requests_report_and_gallery_match_for_both_profiles(self):
        for model, slug in ((BENCH.MODEL_NAME, "sd15"), (BENCH.SDXL_MODEL_NAME, "sdxl")):
            with self.subTest(model=model):
                runner = BENCH.BenchmarkRunner(self.runtime, model, self.root / "results", 4, simple_prompts=True)
                with self.dependencies():
                    report = runner.run()
                self.assertTrue(report["complete"])
                self.assertEqual(report["promptProfile"], "simple-action-first-v1")
                self.assertEqual(report["prompts"], [{"step": step + 1, "positive": positive, "negative": BENCH.NEGATIVE}
                                                    for step, positive in enumerate(EXPECTED_SIMPLE_PROMPTS)])
                self.assertEqual([image["caption"] for image in report["images"]], list(BENCH.CAPTIONS))
                self.assertTrue(runner.run_directory.name.startswith(slug + "-simple-"))
                self.assertIn("Simple prompts", (runner.run_directory / "review.html").read_text())
                process = self.processes[-1]
                self.assertTrue(process.stopped)
                for workflow, expected in zip(process.server.workflows, EXPECTED_SIMPLE_PROMPTS):
                    if model == BENCH.SDXL_MODEL_NAME:
                        self.assertEqual(workflow["6"]["inputs"]["text_g"], expected)
                        self.assertEqual(workflow["6"]["inputs"]["text_l"], expected)
                        self.assertEqual(workflow["7"]["inputs"]["text_g"], BENCH.NEGATIVE)
                        self.assertEqual(workflow["7"]["inputs"]["text_l"], BENCH.NEGATIVE)
                    else:
                        self.assertEqual(workflow["6"]["inputs"]["text"], expected)
                        self.assertEqual(workflow["7"]["inputs"]["text"], BENCH.NEGATIVE)
                saved = json.loads((runner.run_directory / "report.json").read_text())
                self.assertEqual(saved["prompts"], report["prompts"])

    def test_failed_simple_trial_still_records_all_requested_frame_prompts(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", 4, simple_prompts=True)
        with self.dependencies(reject=True), self.assertRaises(BENCH.BenchmarkFailure):
            runner.run()
        report = json.loads((runner.run_directory / "report.json").read_text())
        self.assertFalse(report["complete"])
        self.assertEqual(report["images"], [])
        self.assertEqual(report["promptProfile"], "simple-action-first-v1")
        self.assertEqual([prompt["positive"] for prompt in report["prompts"]], list(EXPECTED_SIMPLE_PROMPTS))

    def test_sdxl_four_native_images_have_correct_profile_report_gallery_and_output_names(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results", 4)
        with self.dependencies():
            report = runner.run()
        self.assertTrue(report["complete"])
        self.assertEqual(report["modelProfile"], {"label": "SDXL Base", "slug": "sdxl", "expectedSize": 1024})
        self.assertEqual((report["configuration"]["width"], report["configuration"]["height"]), (1024, 1024))
        self.assertEqual(report["configuration"]["conditioning"], "CLIPTextEncodeSDXL")
        self.assertEqual(report["configuration"]["seed"], 482031927)
        self.assertEqual([image["caption"] for image in report["images"]], list(BENCH.CAPTIONS))
        self.assertTrue(runner.run_directory.name.startswith("sdxl-"))
        self.assertTrue(self.processes[-1].stopped)
        self.assertTrue(all(workflow["9"]["inputs"]["filename_prefix"].startswith("skao_sdxl_")
                            for workflow in self.processes[-1].server.workflows))
        for image in report["images"]:
            data = (runner.run_directory / image["file"]).read_bytes()
            self.assertEqual(data, BENCH.sanitize_png(data, 1024))
        gallery = (runner.run_directory / "review.html").read_text()
        self.assertIn("SDXL Base activity image test", gallery)
        self.assertIn('width="1024" height="1024"', gallery)
        self.assertNotIn("SD1.5", gallery)

    def test_sdxl_wrong_size_is_a_failure_without_silent_baseline_fallback(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.SDXL_MODEL_NAME, self.root / "results")
        with self.dependencies(wrong_size=512):
            with self.assertRaises(BENCH.BenchmarkFailure) as error:
                runner.run()
        self.assertEqual(error.exception.code, "IMAGE_FORMAT")
        report = json.loads((runner.run_directory / "report.json").read_text())
        self.assertFalse(report["complete"])
        self.assertEqual(report["images"], [])
        self.assertEqual(len(self.processes), 1)
        self.assertEqual(self.processes[0].server.workflows[0]["4"]["inputs"]["ckpt_name"], BENCH.SDXL_MODEL_NAME)

    def test_arbitrary_model_is_rejected_before_output_or_process_creation(self):
        output = self.root / "never-created"
        runner = BENCH.BenchmarkRunner(self.runtime, "other.safetensors", output)
        with self.dependencies(), self.assertRaises(BENCH.BenchmarkFailure) as error:
            runner.run()
        self.assertEqual(error.exception.code, "ARGUMENTS")
        self.assertFalse(output.exists())
        self.assertEqual(self.processes, [])

    def test_real_blocked_startup_emits_stack_and_runner_stops_only_owned_process(self):
        main = self.runtime / "ComfyUI" / "main.py"
        (main.parent / "av.py").write_text("__version__ = 'fixture-av'\n", encoding="utf-8")
        (main.parent / "blocked_sibling.py").write_text("import time\nwhile True:\n    time.sleep(0.02)\n", encoding="utf-8")
        main.write_text("import blocked_sibling\n", encoding="utf-8")
        original_client = BENCH.LocalJsonClient
        original_command = BENCH.build_startup_command
        def client(base):
            return SimpleNamespace(request=lambda path, **kwargs: {"models": []}) if base == "http://127.0.0.1:11434" else original_client(base)
        def command(python, script, flags, ready_path):
            return original_command(sys.executable, script, flags, ready_path, trace_delay=0.15)
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results", startup_timeout=0.8)
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(15)"], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            with patch.object(BENCH, "LocalJsonClient", side_effect=client), \
                 patch.object(BENCH, "build_startup_command", side_effect=command), \
                 patch.object(BENCH.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=" ".join(BENCH.REQUIRED_FLAGS))), \
                 patch.object(BENCH.DeviceMemorySampler, "start"), patch.object(BENCH.DeviceMemorySampler, "stop", return_value=[]):
                with self.assertRaises(BENCH.BenchmarkFailure) as error:
                    runner.run()
            self.assertEqual(error.exception.code, "STARTUP_TIMEOUT")
            self.assertIsNotNone(runner.process.poll())
            self.assertIsNone(unrelated.poll())
            log = (runner.run_directory / "runtime.log").read_text()
            self.assertIn("PyAV fixture-av loaded", log)
            self.assertIn("Timeout (", log)
            self.assertIn("blocked_sibling.py", log)
            report = json.loads((runner.run_directory / "report.json").read_text())
            self.assertTrue(report["processStopped"])
            self.assertFalse(report["complete"])
            self.assertFalse((runner.run_directory / "startup-ready.signal").exists())
        finally:
            if unrelated.poll() is None:
                unrelated.terminate()
            unrelated.wait(timeout=3)

    def test_loaded_text_model_prevents_launch_without_unloading_it(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results")
        with self.dependencies(models=[{"name": "synthetic text model"}]):
            with self.assertRaises(BENCH.BenchmarkFailure) as error:
                runner.run()
        self.assertEqual(error.exception.code, "TEXT_MODEL_LOADED")
        self.assertEqual(self.processes, [])
        self.assertFalse(json.loads((runner.run_directory / "report.json").read_text())["complete"])

    def test_rejected_interrupted_or_bad_output_stops_only_owned_process(self):
        for mode, expected in (({"reject": True}, "WORKFLOW_REJECTED"), ({"interrupt": True}, "GENERATION_FAILED"),
                               ({"malformed": True}, "IMAGE_SIZE")):
            with self.subTest(mode=mode):
                runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results")
                with self.dependencies(**mode):
                    with self.assertRaises(BENCH.BenchmarkFailure) as error:
                        runner.run()
                self.assertEqual(error.exception.code, expected)
                self.assertTrue(self.processes[-1].stopped)
                report = json.loads((runner.run_directory / "report.json").read_text())
                self.assertFalse(report["complete"])
                self.assertEqual(report["status"], "failed")

    def test_keyboard_interrupt_preserves_cancelled_report_and_stops_owned_process(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results")
        with self.dependencies(), patch.object(BENCH, "wait_for_image", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                runner.run()
        report = json.loads((runner.run_directory / "report.json").read_text())
        self.assertEqual(report["status"], "cancelled")
        self.assertFalse(report["complete"])
        self.assertTrue(report["processStopped"])
        self.assertTrue(self.processes[-1].stopped)

    def test_partial_run_keeps_only_successfully_validated_frames(self):
        original_wait = BENCH.wait_for_image
        calls = []
        def wait(*args, **kwargs):
            calls.append(True)
            if len(calls) == 2:
                raise BENCH.BenchmarkFailure("GENERATION_TIMEOUT", "Synthetic timeout")
            return original_wait(*args, **kwargs)
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results", 4)
        with self.dependencies(), patch.object(BENCH, "wait_for_image", side_effect=wait):
            with self.assertRaises(BENCH.BenchmarkFailure):
                runner.run()
        report = json.loads((runner.run_directory / "report.json").read_text())
        self.assertFalse(report["complete"])
        self.assertEqual(len(report["images"]), 1)
        self.assertTrue((runner.run_directory / "step-1.png").exists())
        self.assertFalse((runner.run_directory / "step-2.png").exists())
        self.assertTrue(report["processStopped"])

    def test_cleanup_failure_still_writes_incomplete_report_and_never_reports_success(self):
        runner = BENCH.BenchmarkRunner(self.runtime, BENCH.MODEL_NAME, self.root / "results")
        with self.dependencies(), \
             patch.object(FakeProcess, "terminate", side_effect=OSError("synthetic terminate failure")), \
             patch.object(FakeProcess, "wait", side_effect=subprocess.TimeoutExpired("fake", 1)), \
             patch.object(FakeProcess, "kill", side_effect=OSError("synthetic kill failure"), create=True):
            with self.assertRaises(BENCH.BenchmarkFailure) as error:
                runner.run()
        self.assertEqual(error.exception.code, "CLEANUP_FAILED")
        report = json.loads((runner.run_directory / "report.json").read_text())
        self.assertFalse(report["complete"])
        self.assertFalse(report["processStopped"])
        self.assertEqual(report["errors"][-1]["code"], "CLEANUP_FAILED")
        self.assertTrue((runner.run_directory / "review.html").exists())


if __name__ == "__main__":
    unittest.main()
