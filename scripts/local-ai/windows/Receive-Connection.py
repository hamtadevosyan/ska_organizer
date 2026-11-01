#!/usr/bin/env python3
"""Fixed SSH receiver for two private SKAO connection files. No credentials in argv."""
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import sys

FILES = ("ca.pem", "ai.env")
MAX_BYTES = 65536


class TransferError(Exception):
    pass


def need(value, code):
    if not value:
        raise TransferError(code)


class Receiver:
    def __init__(self, home, hashes, uid=None):
        self.uid = os.geteuid() if uid is None else uid
        need(len(hashes) == 2 and all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes), "HASH_ARGUMENT")
        self.hashes = dict(zip(FILES, hashes))
        self.home = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        info = os.fstat(self.home)
        need(info.st_uid == self.uid and not info.st_mode & 0o022, "HOME_UNSAFE")
        self.target = None

    def close(self):
        if self.target is not None:
            os.close(self.target)
            self.target = None
        if self.home is not None:
            os.close(self.home)
            self.home = None

    def target_dir(self, create=False):
        if self.target is not None:
            return self.target
        try:
            self.target = os.open("skao-ai-transfer", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.home)
        except FileNotFoundError:
            if not create:
                return None
            try:
                os.mkdir("skao-ai-transfer", 0o700, dir_fd=self.home)
            except FileExistsError:
                pass
            self.target = os.open("skao-ai-transfer", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.home)
        info = os.fstat(self.target)
        need(info.st_uid == self.uid and stat.S_IMODE(info.st_mode) == 0o700, "DESTINATION_UNSAFE")
        return self.target

    def file_hash(self, directory, name, staged=False):
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(descriptor)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1,
                 "FILE_UNSAFE")
            need(0 < info.st_size <= MAX_BYTES, "FILE_SIZE")
            if not staged:
                need(stat.S_IMODE(info.st_mode) == 0o600, "FILE_PERMISSIONS")
            data = bytearray()
            while len(data) <= MAX_BYTES:
                chunk = os.read(descriptor, min(8192, MAX_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(descriptor)
            need(len(data) == info.st_size and after.st_size == info.st_size and
                 after.st_mtime_ns == info.st_mtime_ns and len(data) <= MAX_BYTES, "FILE_CHANGED")
            if staged:
                os.fchmod(descriptor, 0o600)
            return hashlib.sha256(data).hexdigest()
        finally:
            os.close(descriptor)

    def inspect(self):
        target = self.target_dir()
        if target is None:
            return {"status": "missing"}
        found = 0
        for name in FILES:
            digest = self.file_hash(target, name)
            need(digest is None or digest == self.hashes[name], "DESTINATION_CONFLICT")
            found += digest is not None
        return {"status": "ready" if found == len(FILES) else "missing"}

    def prepare(self):
        if self.inspect()["status"] == "ready":
            return {"status": "ready"}
        target = self.target_dir(create=True)
        stage = ".incoming-" + secrets.token_hex(16)
        os.mkdir(stage, 0o700, dir_fd=target)
        return {"status": "staging", "stage": stage}

    def stage_dir(self, stage):
        need(isinstance(stage, str) and re.fullmatch(r"\.incoming-[0-9a-f]{32}", stage), "STAGE_ARGUMENT")
        target = self.target_dir()
        need(target is not None, "DESTINATION_MISSING")
        directory = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
        info = os.fstat(directory)
        try:
            need(info.st_uid == self.uid and stat.S_IMODE(info.st_mode) == 0o700, "STAGE_UNSAFE")
            need(set(os.listdir(directory)).issubset(FILES), "STAGE_EXTRA_FILES")
            return directory
        except BaseException:
            os.close(directory)
            raise

    def cleanup(self, stage):
        directory = self.stage_dir(stage)
        try:
            for name in FILES:
                try:
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                need(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid, "STAGE_FILE_UNSAFE")
            for name in FILES:
                try:
                    os.unlink(name, dir_fd=directory)
                except FileNotFoundError:
                    pass
        finally:
            os.close(directory)
        os.rmdir(stage, dir_fd=self.target)
        return {"status": "cleaned"}

    def publish(self, stage):
        self.inspect()  # Refuse any existing conflicting file before publishing either file.
        directory = self.stage_dir(stage)
        try:
            for name in FILES:
                need(self.file_hash(directory, name, staged=True) == self.hashes[name], "STAGED_HASH_MISMATCH")
            for name in FILES:
                existing = self.file_hash(self.target, name)
                if existing is not None:
                    need(existing == self.hashes[name], "DESTINATION_CONFLICT")
                    continue
                try:
                    os.link(name, name, src_dir_fd=directory, dst_dir_fd=self.target, follow_symlinks=False)
                except FileExistsError:
                    need(self.file_hash(self.target, name) == self.hashes[name], "DESTINATION_CONFLICT")
                # Remove this staging link immediately, restoring target nlink=1.
                else:
                    os.unlink(name, dir_fd=directory)
            os.fsync(self.target)
        finally:
            os.close(directory)
        self.cleanup(stage)
        need(self.inspect()["status"] == "ready", "PUBLICATION_INCOMPLETE")
        return {"status": "ready"}


def main(argv):
    receiver = None
    try:
        need(os.geteuid() != 0, "NORMAL_PI_ACCOUNT_REQUIRED")
        need(len(argv) in (3, 4) and argv[0] in ("inspect", "prepare", "publish", "cleanup"), "ARGUMENTS")
        mode = argv[0]
        need((mode in ("publish", "cleanup")) == (len(argv) == 4), "ARGUMENTS")
        receiver = Receiver(os.path.expanduser("~"), argv[1:3])
        result = getattr(receiver, mode)(argv[3]) if len(argv) == 4 else getattr(receiver, mode)()
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except TransferError as error:
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        return 1
    except (OSError, ValueError):
        print('{"error":"FILESYSTEM_CHECK_FAILED"}')
        return 1
    finally:
        if receiver is not None:
            receiver.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
