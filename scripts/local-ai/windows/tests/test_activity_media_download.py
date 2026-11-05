"""Verify the standalone download carries exact source bytes and is read-only in check mode."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

BUILDER = Path(__file__).resolve().parents[2] / "build-activity-media.py"
spec = importlib.util.spec_from_file_location("media_builder", BUILDER)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
PWSH = os.environ.get("SKAO_TEST_PWSH") or shutil.which("powershell.exe") or shutil.which("pwsh")


class StandaloneDownloadTests(unittest.TestCase):
    @unittest.skipUnless(PWSH, "PowerShell is required to parse the actual download")
    def test_literal_payload_matches_source_and_check_creates_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "Setup-SKAO-ActivityMedia.ps1"
            builder.build(output)
            self.assertTrue(output.read_bytes().startswith(b"\xef\xbb\xbf"))
            probe = root / "probe.ps1"
            probe.write_text(r'''$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:SKAO_DOWNLOAD, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$assignment = $ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$payload'}, $true)
$payload = @($assignment.Right.FindAll({param($node) $node -is [System.Management.Automation.Language.HashtableAst]}, $true) | ForEach-Object {
    $entry = @{}
    foreach ($pair in $_.KeyValuePairs) {
        $value = $pair.Item2.Find({param($node) $node -is [System.Management.Automation.Language.StringConstantExpressionAst]}, $true)
        if ($value -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { throw 'Nonliteral payload' }
        $entry[$pair.Item1.Value] = $value.Value
    }
    $entry
})
$payload | ConvertTo-Json -Depth 5 -Compress
''', encoding="utf-8-sig")
            env = {**os.environ, "SKAO_DOWNLOAD": str(output), "LOCALAPPDATA": str(root / "local")}
            result = subprocess.run([PWSH, "-NoProfile", "-File", str(probe)], env=env,
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual([p["Path"] for p in payload], list(builder.FILES))
            for item in payload:
                content = (builder.REPOSITORY / item["Path"]).read_text(encoding="utf-8-sig")
                self.assertEqual(item["Content"], content)
                self.assertEqual(hashlib.sha256(content.encode()).hexdigest(), item["Sha256"])
            check = subprocess.run([PWSH, "-NoProfile", "-File", str(output), "-Check"],
                                   env=env, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(check.returncode, 0)
            self.assertIn("AI_MEDIA_NOT_CONFIGURED", check.stderr)
            self.assertFalse((root / "local").exists())
            diagnose = subprocess.run([PWSH, "-NoProfile", "-File", str(output), "-Diagnose"],
                                      env=env, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(diagnose.returncode, 0)
            self.assertIn("AI_MEDIA_DIAGNOSTIC", diagnose.stderr)
            self.assertFalse((root / "local").exists(), "Diagnosis must not extract or create any tool files")
            self.assertNotIn(str(root), diagnose.stdout + diagnose.stderr)


if __name__ == "__main__":
    unittest.main()
