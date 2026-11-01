"""Native deployment ordering; no network, sudo, host settings or database access."""
import argparse
import importlib.util
import os
import shutil
import stat
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('saved_ai_native', REPO / 'scripts/ubuntu.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)

class SavedAiIntegrationTests(unittest.TestCase):
    def test_prepare_is_offline_and_only_configured_hosts_are_adopted(self):
        with patch.object(u, 'run') as run:
            u.prepare_local_ai(Path('/synthetic/checkout'))
        self.assertEqual(run.call_args.args[0], ['bash', '/synthetic/checkout/scripts/local-ai/pi/setup.sh', '--prepare', '--if-configured'])

    def test_local_update_prepares_before_environment_and_root_preflight(self):
        order = []
        with patch.object(u.os, 'geteuid', return_value=1000), patch.object(u, 'check_ubuntu'), patch.object(u, 'node_binary', return_value='/node'), patch.object(u, 'prepare_local_ai', side_effect=lambda repo: order.append('prepare')), patch.object(u, 'read_activity_ai_environment', side_effect=lambda *a: order.append('env') or {}), patch.object(u, 'root_call', side_effect=lambda *a: order.append(a[0])), patch.object(u, 'build_release'), patch.object(u, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='synthetic')), patch.object(u, 'secure_write'):
            u.public_deploy(argparse.Namespace(command='update', local=True))
        self.assertEqual(order[:3], ['prepare', 'env', '_preflight'])

    def test_pull_reexec_happens_before_preparation(self):
        class Reexecuted(Exception): pass
        with patch.object(u.os, 'geteuid', return_value=1000), patch.object(u, 'check_ubuntu'), patch.object(u, 'node_binary', return_value='/node'), patch.object(u, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='')), patch.object(u.os, 'execv', side_effect=Reexecuted), patch.object(u, 'prepare_local_ai') as prepare:
            with self.assertRaises(Reexecuted):
                u.public_deploy(argparse.Namespace(command='update', local=False))
        prepare.assert_not_called()

    def test_setup_prepares_before_initial_environment(self):
        order = []
        with patch.object(u.os, 'geteuid', return_value=1000), patch.object(u, 'check_ubuntu'), patch.object(u, 'node_binary', return_value='/node'), patch.object(u, 'lan_address', return_value={'ip':'192.168.1.20','interface':'eth0'}), patch.object(u, 'prepare_local_ai', side_effect=lambda repo: order.append('prepare')), patch.object(u, 'read_source_environment', side_effect=lambda *a: order.append('env') or {}), patch.object(u, 'root_call'), patch.object(u, 'build_release'), patch.object(u, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='synthetic')), patch.object(u, 'secure_write'):
            u.public_deploy(argparse.Namespace(command='setup', ip=None))
        self.assertEqual(order[:2], ['prepare', 'env'])

class PublicAiOnlyStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name)
        self.etc = self.base / 'etc-skao'
        self.ai = self.etc / 'ai'
        self.ai.mkdir(parents=True)
        self.etc.chmod(0o755); self.ai.chmod(0o755)
        if not shutil.which('openssl'):
            self.skipTest('openssl is needed to create a synthetic public test CA')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Synthetic Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-days', '1', '-keyout', str(self.base / 'unused-test-key.pem'), '-out', str(self.ai / 'ca.pem')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (self.ai / 'ca.pem').chmod(0o644)
        self.context = patch.object(u, 'CONF', self.etc / 'native')
        self.context.start(); self.addCleanup(self.context.stop)
        # Root ownership is emulated only for temporary test paths. File type,
        # no-follow opens, permissions and actual certificate parsing remain real.
        real_lstat = Path.lstat
        real_fstat = os.fstat
        def root_metadata(metadata):
            fields = list(metadata); fields[4] = 0; fields[5] = 0
            return os.stat_result(fields)
        self.lstat = patch.object(Path, 'lstat', lambda p: root_metadata(real_lstat(p)))
        self.fstat = patch.object(u.os, 'fstat', lambda fd: root_metadata(real_fstat(fd)))
        self.lstat.start(); self.fstat.start()
        self.addCleanup(self.lstat.stop); self.addCleanup(self.fstat.stop)

    def test_secure_public_ca_only_state_is_accepted_without_native_ownership_marker(self):
        self.assertTrue(u.public_ai_only_state())
        self.assertFalse(u.CONF.exists())

    def test_extra_state_symlinks_and_unsafe_modes_are_rejected(self):
        extra = self.etc / 'unexpected'; extra.touch()
        self.assertFalse(u.public_ai_only_state()); extra.unlink()
        self.ai.chmod(0o777)
        self.assertFalse(u.public_ai_only_state()); self.ai.chmod(0o755)
        cert = self.ai / 'ca.pem'; data = cert.read_bytes(); cert.unlink()
        outside = self.base / 'outside.pem'; outside.write_bytes(data); cert.symlink_to(outside)
        self.assertFalse(u.public_ai_only_state())

    def test_only_a_single_public_ca_certificate_is_accepted(self):
        cert = self.ai / 'ca.pem'; original = cert.read_text()
        for invalid in (original + original, original + 'PRIVATE_APPENDIX', '-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----'):
            cert.write_text(invalid)
            self.assertFalse(u.public_ai_only_state())

    def test_nonroot_ownership_is_rejected(self):
        self.lstat.stop(); self.fstat.stop()
        real_lstat = Path.lstat
        def nonroot_metadata(path):
            fields = list(real_lstat(path)); fields[4] = 1000
            return os.stat_result(fields)
        with patch.object(Path, 'lstat', nonroot_metadata):
            self.assertFalse(u.public_ai_only_state())

if __name__ == '__main__': unittest.main()
