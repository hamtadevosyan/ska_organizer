import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'Receive-Connection.py'
spec = importlib.util.spec_from_file_location('receiver', SOURCE)
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.data = {'ca.pem': b'public synthetic CA\n', 'ai.env': b'SKAO_AI_TOKEN=synthetic-test-token\n'}
        hashes = [hashlib.sha256(self.data[name]).hexdigest() for name in receiver.FILES]
        self.app = receiver.Receiver(self.home, hashes)

    def tearDown(self):
        self.app.close()
        self.temp.cleanup()

    def upload(self, stage):
        location = self.home / 'skao-ai-transfer' / stage
        for name, data in self.data.items():
            (location / name).write_bytes(data)
        return location

    def save_existing(self):
        destination = self.home / 'skao-ai-transfer'
        destination.mkdir(mode=0o700)
        for name, data in self.data.items():
            path = destination / name
            path.write_bytes(data)
            path.chmod(0o600)
        return destination

    def test_inspect_absent_is_read_only(self):
        self.assertEqual(self.app.inspect(), {'status': 'missing'})
        self.assertEqual(list(self.home.iterdir()), [])

    def test_complete_private_publication_and_repeat_are_noops(self):
        prepared = self.app.prepare()
        self.upload(prepared['stage'])
        self.assertEqual(self.app.publish(prepared['stage']), {'status': 'ready'})
        destination = self.home / 'skao-ai-transfer'
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
        before = {p.name: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in destination.iterdir()}
        self.assertEqual(self.app.prepare(), {'status': 'ready'})
        self.assertEqual(self.app.inspect(), {'status': 'ready'})
        for p in destination.iterdir():
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
            self.assertEqual(before[p.name], (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns))

    def test_manual_matching_files_adopt_without_touch(self):
        destination = self.save_existing()
        before = [(p.name, p.stat().st_ino, p.stat().st_mtime_ns) for p in destination.iterdir()]
        self.assertEqual(self.app.prepare(), {'status': 'ready'})
        self.assertEqual(before, [(p.name, p.stat().st_ino, p.stat().st_mtime_ns) for p in destination.iterdir()])

    def test_conflicting_manual_file_is_preserved(self):
        destination = self.save_existing()
        (destination / 'ai.env').write_bytes(b'older-secret')
        with self.assertRaisesRegex(receiver.TransferError, 'DESTINATION_CONFLICT'):
            self.app.prepare()
        self.assertEqual((destination / 'ai.env').read_bytes(), b'older-secret')
        self.assertEqual(sorted(p.name for p in destination.iterdir()), ['ai.env', 'ca.pem'])

    def test_all_staged_hashes_verified_before_first_publication(self):
        prepared = self.app.prepare()
        stage = self.upload(prepared['stage'])
        (stage / 'ai.env').write_bytes(b'tampered')
        with self.assertRaisesRegex(receiver.TransferError, 'STAGED_HASH_MISMATCH'):
            self.app.publish(prepared['stage'])
        self.assertFalse((stage.parent / 'ca.pem').exists())
        self.assertFalse((stage.parent / 'ai.env').exists())

    def test_partial_matching_destination_is_completed(self):
        destination = self.save_existing()
        (destination / 'ai.env').unlink()
        original = (destination / 'ca.pem').stat()
        prepared = self.app.prepare()
        self.upload(prepared['stage'])
        self.app.publish(prepared['stage'])
        self.assertEqual(original.st_ino, (destination / 'ca.pem').stat().st_ino)
        self.assertEqual(original.st_mtime_ns, (destination / 'ca.pem').stat().st_mtime_ns)

    def test_destination_symlink_is_rejected(self):
        outside = self.home / 'outside'
        outside.mkdir()
        (self.home / 'skao-ai-transfer').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.app.prepare()
        self.assertEqual(list(outside.iterdir()), [])

    def test_destination_permissions_are_never_repaired_silently(self):
        destination = self.save_existing()
        destination.chmod(0o755)
        with self.assertRaisesRegex(receiver.TransferError, 'DESTINATION_UNSAFE'):
            self.app.inspect()
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)

    def test_read_only_inspection_rejects_open_file_permissions(self):
        destination = self.save_existing()
        (destination / 'ai.env').chmod(0o644)
        with self.assertRaisesRegex(receiver.TransferError, 'FILE_PERMISSIONS'):
            self.app.inspect()
        self.assertEqual(stat.S_IMODE((destination / 'ai.env').stat().st_mode), 0o644)

    def test_staged_symlink_and_extra_file_are_rejected(self):
        prepared = self.app.prepare()
        stage = self.upload(prepared['stage'])
        (stage / 'ai.env').unlink()
        (stage / 'ai.env').symlink_to(stage / 'ca.pem')
        with self.assertRaises(OSError):
            self.app.publish(prepared['stage'])
        (stage / 'extra').write_text('preserve')
        with self.assertRaisesRegex(receiver.TransferError, 'STAGE_EXTRA_FILES'):
            self.app.cleanup(prepared['stage'])
        self.assertTrue((stage / 'extra').exists())

    def test_fifo_does_not_block_receiver(self):
        destination = self.home / 'skao-ai-transfer'
        destination.mkdir(mode=0o700)
        os.mkfifo(destination / 'ai.env', 0o600)
        with self.assertRaisesRegex(receiver.TransferError, 'FILE_UNSAFE'):
            self.app.inspect()

    def test_cli_root_is_refused_without_touching_files(self):
        if os.geteuid() != 0:
            self.skipTest('CLI root guard test runs only as root')
        self.assertEqual(receiver.main(['inspect', 'a' * 64, 'b' * 64]), 1)
        self.assertEqual(list(self.home.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
