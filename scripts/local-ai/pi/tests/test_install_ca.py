import importlib.util
import os
from pathlib import Path
import ssl
import stat
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'install-ca.py'
spec = importlib.util.spec_from_file_location('install_ai_ca', MODULE)
ca = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ca)


@unittest.skipUnless(os.geteuid() == 0, 'Root ownership contracts need isolated root-owned test paths')
class PublicCaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Use a root-owned protected ancestor; /tmp is correctly refused by installer.
        cls.root = tempfile.TemporaryDirectory(prefix='skao-ca-tests-', dir='/root')
        cls.folder = Path(cls.root.name)
        cls.cert = cls.make_certificate('one')
        cls.other = cls.make_certificate('two')

    @classmethod
    def tearDownClass(cls):
        cls.root.cleanup()

    @classmethod
    def make_certificate(cls, name):
        certificate = cls.folder / (name + '.pem')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=SKAO-Synthetic-' + name, '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', str(cls.folder / (name + '.key')), '-out', str(certificate)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return certificate.read_bytes()

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(dir=self.folder))
        self.target = self.case / 'skao' / 'ai' / 'ca.pem'

    def test_public_ca_accepts_exact_ca_and_rejects_junk_bundle_and_private_key(self):
        self.assertEqual(ca.public_ca(self.cert), self.cert)
        for data in (self.cert + self.cert, self.cert + b'junk', b'junk' + self.cert, (self.folder / 'one.key').read_bytes(), b''):
            with self.assertRaises(ca.SafeFailure):
                ca.public_ca(data)

    def test_public_ca_tolerates_other_trust_anchor_and_requires_exact_der_present(self):
        original = ssl.SSLContext
        extra = ssl.PEM_cert_to_DER_cert(self.other.decode().strip())
        class Proxy:
            def __init__(self, protocol):
                self.inner = original(protocol)
            def load_verify_locations(self, **kwargs):
                return self.inner.load_verify_locations(**kwargs)
            def get_ca_certs(self, binary_form=False):
                return self.inner.get_ca_certs(binary_form=binary_form) + [extra]
        ssl.SSLContext = Proxy
        try:
            self.assertEqual(ca.public_ca(self.cert), self.cert)
        finally:
            ssl.SSLContext = original

    def test_installs_root_public_ca_with_fixed_permissions_and_repeated_call_preserves_mtime(self):
        self.assertTrue(ca.install(self.cert, self.target))
        info = self.target.stat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o644))
        self.assertEqual(stat.S_IMODE(self.target.parent.stat().st_mode), 0o755)
        self.assertFalse(ca.install(self.cert, self.target))
        self.assertEqual(self.target.stat().st_mtime_ns, info.st_mtime_ns)
        self.assertEqual(self.target.stat().st_ctime_ns, info.st_ctime_ns)

    def test_different_existing_ca_and_symlink_are_preserved(self):
        ca.install(self.cert, self.target)
        with self.assertRaisesRegex(ca.SafeFailure, 'AI_CA_CONFLICT'):
            ca.install(self.other, self.target)
        self.assertEqual(self.target.read_bytes(), self.cert)
        self.target.unlink()
        destination = self.case / 'unrelated'
        destination.write_bytes(b'preserve')
        self.target.symlink_to(destination)
        with self.assertRaises(OSError):
            ca.install(self.cert, self.target)
        self.assertEqual(destination.read_bytes(), b'preserve')

    def test_matching_ca_permission_repair_is_limited_to_matching_cert(self):
        ca.install(self.cert, self.target)
        self.target.chmod(0o600)
        self.assertFalse(ca.install(self.cert, self.target))
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o644)
        self.target.chmod(0o600)
        with self.assertRaises(ca.SafeFailure):
            ca.install(self.other, self.target)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)

    def test_insecure_parent_refused_without_repairing_it(self):
        self.target.parent.mkdir(parents=True)
        self.target.parent.parent.chmod(0o777)
        with self.assertRaisesRegex(ca.SafeFailure, 'AI_CA_PATH_UNSAFE'):
            ca.install(self.cert, self.target)
        self.assertEqual(stat.S_IMODE(self.target.parent.parent.stat().st_mode), 0o777)
        self.assertFalse(self.target.exists())

    def test_publish_race_never_overwrites_the_winner_and_cleans_temporary_file(self):
        def competing_writer():
            self.target.write_bytes(self.other)
        with self.assertRaisesRegex(ca.SafeFailure, 'AI_CA_CONFLICT'):
            ca.install(self.cert, self.target, before_publish=competing_writer)
        self.assertEqual(self.target.read_bytes(), self.other)
        self.assertEqual([p.name for p in self.target.parent.iterdir()], ['ca.pem'])

    def test_private_source_owner_mode_regular_file_and_symlink_contract(self):
        source = self.case / 'transfer'
        source.mkdir(mode=0o700)
        certificate = source / 'ca.pem'
        certificate.write_bytes(self.cert)
        certificate.chmod(0o600)
        self.assertEqual(ca.source_bytes(certificate, 0), self.cert)
        certificate.chmod(0o644)
        with self.assertRaises(ca.SafeFailure):
            ca.source_bytes(certificate, 0)
        certificate.chmod(0o600)
        with self.assertRaises(ca.SafeFailure):
            ca.source_bytes(certificate, 999999)
        link = source / 'link.pem'
        link.symlink_to(certificate)
        with self.assertRaises(OSError):
            ca.source_bytes(link, 0)
        fifo = source / 'fifo.pem'
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(ca.SafeFailure):
            ca.source_bytes(fifo, 0)

    def test_cli_cannot_set_an_arbitrary_destination_and_requires_nonroot_sudo_uid(self):
        previous = os.environ.get('SUDO_UID')
        try:
            os.environ['SUDO_UID'] = '0'
            self.assertEqual(ca.main([str(self.target)]), 1)
            os.environ['SUDO_UID'] = '12345'
            self.assertEqual(ca.main([str(self.target), '/tmp/arbitrary-target']), 1)
        finally:
            if previous is None:
                os.environ.pop('SUDO_UID', None)
            else:
                os.environ['SUDO_UID'] = previous


if __name__ == '__main__':
    unittest.main()
