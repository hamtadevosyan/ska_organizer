#!/usr/bin/env python3
"""Exercise APT's real lock handling against an EMPTY temporary database.

No host packages, sources, services or locks are changed. No packages are
downloaded or installed. Run on Ubuntu, where apt-get is available.
"""

import fcntl
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import time
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ubuntu', Path(__file__).resolve().parents[1] / 'ubuntu.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


def install_command(root, timeout):
    """Use production's APT options; remove the packages for this empty fixture."""
    commands = []
    with patch.object(u, 'CONF', root), patch.object(u, 'check_managed'), \
            patch.object(u, 'listener_preflight'), patch.object(u, 'systemctl'), \
            patch.object(u, 'APT_LOCK_TIMEOUT', timeout), \
            patch.object(u, 'run', side_effect=lambda args, **kw: commands.append(args)), \
            redirect_stdout(io.StringIO()):
        u.packages()
    install = next(args for args in commands if 'install' in args)
    return install[:install.index('-y') + 1]


def main():
    with tempfile.TemporaryDirectory(prefix='skao-apt-check-') as temporary:
        root = Path(temporary)
        for directory in ('etc/apt.conf.d', 'etc/sources.list.d', 'etc/preferences.d',
                          'dpkg/updates', 'state/lists/partial', 'cache/archives/partial', 'log'):
            (root / directory).mkdir(parents=True)
        (root / 'owner').write_text(u.MARKER)
        (root / 'dpkg/status').touch()
        (root / 'etc/sources.list').touch()
        config = root / 'apt-test.conf'
        # APT_CONFIG is read first. All config/source/state paths point inside
        # the fixture, so host hooks, repositories and dpkg state are not used.
        config.write_text(f'Dir "{root}";\nDir::Etc "{root}/etc";\n'
                          f'Dir::State "{root}/state";\nDir::State::status "{root}/dpkg/status";\n'
                          f'Dir::Cache "{root}/cache";\nDir::Log "{root}/log";\n')
        env = {**os.environ, 'APT_CONFIG': str(config), 'LC_ALL': 'C'}
        for lock_name in ('lock-frontend', 'lock'):
            lock_path = root / 'dpkg' / lock_name
            with lock_path.open('a') as lock:
                inode = lock_path.stat().st_ino
                fcntl.lockf(lock, fcntl.LOCK_EX)
                started = time.monotonic()
                result = subprocess.run(install_command(root, 1), env=env, text=True,
                                        capture_output=True, timeout=10)
                assert result.returncode == 100, result.stdout + result.stderr
                assert time.monotonic() - started >= 0.8, 'APT did not wait for the lock'
                assert 'Waiting for cache lock' in result.stdout + result.stderr
                assert lock_path.stat().st_ino == inode, 'The lock file was replaced'
                fcntl.lockf(lock, fcntl.LOCK_UN)
            print(f'PASS APT waits and exits safely when {lock_name} remains held')

        lock_path = root / 'dpkg/lock-frontend'
        with lock_path.open('a') as lock:
            fcntl.lockf(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(install_command(root, 5), env=env, text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                try:
                    out, err = process.communicate(timeout=1.2)
                except subprocess.TimeoutExpired:
                    pass
                else:
                    raise AssertionError('APT exited before the lock was released: ' + out + err)
                fcntl.lockf(lock, fcntl.LOCK_UN)
                out, err = process.communicate(timeout=10)
                assert process.returncode == 0, out + err
                assert 'Waiting for cache lock' in out + err
                assert '0 newly installed' in out + err
            finally:
                # This process belongs only to the empty fixture, never to the
                # host updater. Ensure failed tests cannot leave a child behind.
                if process.poll() is None:
                    process.kill()
                    process.wait()
        print('PASS the same APT process continues successfully after the lock is released')


if __name__ == '__main__':
    main()
