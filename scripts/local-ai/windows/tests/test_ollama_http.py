"""Exercise the real proxy-free PowerShell HTTP helper with synthetic localhost data.

Run with SKAO_TEST_PWSH pointing to powershell.exe or pwsh. No model is loaded.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import unittest


class Handler(http.server.BaseHTTPRequestHandler):
    scenario = "valid"
    received = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        code = 200
        headers = {}
        body = b'{"version":"0.40.13"}'
        if self.scenario == "array":
            body = b'[{"canary":"PRIVATE_BODY_CANARY"}]'
        elif self.scenario == "oversized":
            body = b'{"canary":"' + b'a' * 1048577 + b'"}'
        elif self.scenario == "redirect":
            code = 302
            headers["Location"] = "http://127.0.0.1:1/PRIVATE_BODY_CANARY"
        elif self.scenario == "error":
            code = 500
            body = b'{"error":"PRIVATE_BODY_CANARY"}'
        elif self.scenario == "invalid":
            body = b'{PRIVATE_BODY_CANARY}'
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        Handler.received = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        body = b'{"capabilities":["completion"]}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class HttpHelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pwsh = os.environ.get("SKAO_TEST_PWSH")
        if not cls.pwsh:
            raise unittest.SkipTest("Set SKAO_TEST_PWSH to run PowerShell HTTP integration checks")
        try:
            cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 11434), Handler)
        except OSError:
            raise unittest.SkipTest("The isolated test's localhost 11434 is already in use")
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(timeout=3)

    def invoke(self, expression):
        script = str(Path(__file__).resolve().parents[1] / "Setup-Ollama.ps1").replace("'", "''")
        command = f". '{script}'; try {{ {expression} }} catch {{ $_.Exception.Message; exit 2 }}"
        env = dict(os.environ, HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1", ALL_PROXY="http://127.0.0.1:1", NO_PROXY="")
        return subprocess.run([self.pwsh, "-NoLogo", "-NoProfile", "-Command", command], capture_output=True, text=True, env=env, timeout=15)

    def test_direct_localhost_ignores_proxy(self):
        Handler.scenario = "valid"
        result = self.invoke("(Invoke-SkaoOllamaJson -Path '/api/version').version")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "0.40.13")

    def test_post_is_json_with_exact_model(self):
        Handler.scenario = "valid"
        result = self.invoke("Invoke-SkaoOllamaJson -Path '/api/show' -Body @{ model = $script:SkaoOllamaModel } | ConvertTo-Json -Compress")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["capabilities"], ["completion"])
        self.assertEqual(Handler.received, {"model": "qwen3:4b-instruct-2507-q4_K_M"})

    def test_untrusted_response_shapes_are_redacted(self):
        for scenario in ("array", "oversized", "redirect", "error", "invalid"):
            with self.subTest(scenario=scenario):
                Handler.scenario = scenario
                result = self.invoke("Invoke-SkaoOllamaJson -Path '/api/version'")
                self.assertEqual(result.returncode, 2)
                self.assertIn("AI_LOCAL_HTTP:", result.stdout)
                self.assertNotIn("PRIVATE_BODY_CANARY", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
