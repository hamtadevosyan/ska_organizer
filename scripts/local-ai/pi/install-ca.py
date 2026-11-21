#!/usr/bin/env python3
"""Install one public AI CA at a fixed service-readable path. No settings or keys."""
import errno
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import uuid

TARGET = Path('/etc/skao/ai/ca.pem')
MAX_BYTES = 65536
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class SafeFailure(Exception):
    pass


def require(value, code):
    if not value:
        raise SafeFailure(code)


def public_ca(data):
    require(0 < len(data) <= MAX_BYTES, 'AI_CA_INVALID')
    try:
        text = data.decode('ascii')
        require(re.fullmatch(r'\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*', text), 'AI_CA_INVALID')
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=text)
        der = ssl.PEM_cert_to_DER_cert(text.strip())
        # Some runtimes inject another trust anchor. Verify the supplied CA's DER.
        require(der in context.get_ca_certs(binary_form=True), 'AI_CA_INVALID')
    except (UnicodeError, ValueError, ssl.SSLError):
        raise SafeFailure('AI_CA_INVALID') from None
    return data


def open_directory(filename):
    path = Path(filename)
    require(path.is_absolute() and '..' not in path.parts, 'AI_SOURCE_UNSAFE')
    descriptor = os.open('/', DIRECTORY_FLAGS)
    try:
        for piece in path.parts[1:]:
            child = os.open(piece, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def source_bytes(source, uid):
    source = Path(source)
    require(source.is_absolute(), 'AI_SOURCE_UNSAFE')
    parent = open_directory(source.parent)
    try:
        info = os.fstat(parent)
        require(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700, 'AI_SOURCE_UNSAFE')
        descriptor = os.open(source.name, FILE_FLAGS, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o600 and 0 < info.st_size <= MAX_BYTES, 'AI_SOURCE_UNSAFE')
            data = os.read(descriptor, MAX_BYTES + 1)
            require(len(data) == info.st_size, 'AI_SOURCE_CHANGED')
            return public_ca(data)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def safe_root_directory(descriptor):
    info = os.fstat(descriptor)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and not info.st_mode & 0o022, 'AI_CA_PATH_UNSAFE')


def target_directory(target=TARGET):
    """Tests can use a protected temporary root; the CLI has no target option."""
    target = Path(target)
    descriptor = os.open('/', DIRECTORY_FLAGS)
    try:
        safe_root_directory(descriptor)
        parts = target.parent.parts[1:]
        for i, piece in enumerate(parts):
            try:
                child = os.open(piece, DIRECTORY_FLAGS, dir_fd=descriptor)
            except FileNotFoundError:
                # Only the fixed final skao/ai directories may be created by CLI.
                require(i >= len(parts) - 2, 'AI_CA_PATH_UNSAFE')
                try:
                    os.mkdir(piece, 0o755, dir_fd=descriptor)
                except FileExistsError:
                    pass
                child = os.open(piece, DIRECTORY_FLAGS, dir_fd=descriptor)
            safe_root_directory(child)
            if i >= len(parts) - 2:
                if stat.S_IMODE(os.fstat(child).st_mode) != 0o755:
                    os.fchmod(child, 0o755)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def existing_bytes(parent, name):
    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and 0 < info.st_size <= MAX_BYTES, 'AI_CA_PATH_UNSAFE')
        data = os.read(descriptor, MAX_BYTES + 1)
        require(len(data) == info.st_size, 'AI_CA_CHANGED')
        return descriptor, data, info
    except BaseException:
        os.close(descriptor)
        raise


def install(data, target=TARGET, before_publish=None):
    public_ca(data)
    parent = target_directory(target)
    name = Path(target).name
    temporary = '.ca-' + uuid.uuid4().hex
    created = False
    try:
        existing = existing_bytes(parent, name)
        if existing:
            descriptor, current, info = existing
            try:
                require(current == data, 'AI_CA_CONFLICT')
                if info.st_gid != 0:
                    os.fchown(descriptor, 0, 0)
                if stat.S_IMODE(info.st_mode) != 0o644:
                    os.fchmod(descriptor, 0o644)
                return False
            finally:
                os.close(descriptor)
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644, dir_fd=parent)
        created = True
        try:
            os.fchown(descriptor, 0, 0)
            os.fchmod(descriptor, 0o644)
            view = memoryview(data)
            while view:
                view = view[os.write(descriptor, view):]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if before_publish:
            before_publish()
        try:
            os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError:
            raise SafeFailure('AI_CA_CONFLICT') from None
        os.fsync(parent)
        return True
    finally:
        if created:
            os.unlink(temporary, dir_fd=parent)
        os.close(parent)


def main(argv):
    try:
        require(os.geteuid() == 0 and re.fullmatch(r'[1-9][0-9]*', os.environ.get('SUDO_UID', '')) and len(argv) == 1, 'AI_NORMAL_USER_SUDO_REQUIRED')
        data = source_bytes(argv[0], int(os.environ['SUDO_UID']))
        changed = install(data)
        print('PASS: public AI CA installed' if changed else 'PASS: matching public AI CA preserved')
    except SafeFailure as failure:
        print('FAIL: public AI CA installation [' + str(failure) + ']', file=sys.stderr)
        return 1
    except OSError as failure:
        code = errno.errorcode.get(failure.errno, 'AI_CA_IO_FAILED')
        print('FAIL: public AI CA installation [' + code + ']', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
