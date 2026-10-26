"""Exercise local OCR installation with synthetic commands, never real APT."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'setup-ccrc-ocr.sh'


class CcrcSetupTests(unittest.TestCase):
    def invoke(self, failed_step='', english=True):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            commands = folder / 'commands'
            commands.mkdir()
            log = folder / 'calls'
            binaries = {
                'id': '#!/bin/sh\nprintf "0\\n"\n',
                'apt-get': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CCRC_SETUP_LOG"\n'
                           'case "$CCRC_SETUP_FAIL:$*" in update:*update*|install:*install*) exit 100;; esac\n',
                'tesseract': '#!/bin/sh\n[ "$CCRC_SETUP_ENGLISH" = yes ] && printf "eng\\n"\n',
                'pdfinfo': '#!/bin/sh\nexit 0\n',
                'pdftotext': '#!/bin/sh\nexit 0\n',
                'pdftoppm': '#!/bin/sh\nexit 0\n',
                'pdfimages': '#!/bin/sh\nexit 0\n',
                'prlimit': '#!/bin/sh\nexit 0\n',
                'python3': '#!/bin/sh\n[ "$CCRC_SETUP_FAIL" = pillow ] && exit 1\nexit 0\n',
            }
            for name, source in binaries.items():
                executable = commands / name
                executable.write_text(source)
                executable.chmod(0o700)
            result = subprocess.run(['bash', str(SCRIPT)], text=True, capture_output=True, timeout=5,
                                    env={**os.environ, 'PATH': str(commands) + ':' + os.environ['PATH'],
                                         'CCRC_SETUP_LOG': str(log), 'CCRC_SETUP_FAIL': failed_step,
                                         'CCRC_SETUP_ENGLISH': 'yes' if english else 'no'})
            return result, log.read_text().splitlines() if log.exists() else []

    def test_prerequisites_use_command_scoped_lock_wait_and_verify_english(self):
        result, calls = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ['--error-on=any update',
                               '-o DPkg::Lock::Timeout=600 install -y --no-install-recommends '
                               'poppler-utils tesseract-ocr tesseract-ocr-eng util-linux python3-pil'])
        self.assertIn('Local PDF and image reading is installed', result.stdout)

    def test_failed_refresh_does_not_install_or_report_success(self):
        result, calls = self.invoke(failed_step='update')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ['--error-on=any update'])
        self.assertNotIn('reading is installed', result.stdout)

    def test_install_or_missing_language_never_reports_success(self):
        for arguments in ({'failed_step': 'install'}, {'english': False}, {'failed_step': 'pillow'}):
            with self.subTest(arguments=arguments):
                result, _ = self.invoke(**arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('reading is installed', result.stdout)


if __name__ == '__main__':
    unittest.main()
