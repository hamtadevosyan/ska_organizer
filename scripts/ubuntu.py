#!/usr/bin/env python3
"""Native SKAO deployment for Ubuntu 24.04. No Docker, shell eval or remote ingress.

Builds run as the invoking user; only installation/management requests use sudo.
Boot and renewal use an installed, root-owned copy, never the working checkout.
"""

import argparse
import datetime as dt
import fcntl
import getpass
import grp
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path('/opt/skao')
CONF = Path('/etc/skao/native')
HELPER = Path('/usr/local/lib/skao/ubuntu.py')
BACKUPS = Path('/var/backups/skao')
UNITS = Path('/etc/systemd/system')
MARKER = 'SKAO native Ubuntu deployment v1\n'
DOMAIN = 'app.smartkidsacademycenter.com'
SERVICES = ['skao-api.service', 'skao-web.service', 'skao-dns.service', 'skao-awake.service']
PRIVATE = [ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
APT_LOCK_TIMEOUT = 600
APT_SOURCES = Path('/etc/apt')
ROS_KEY = Path('/usr/share/keyrings/ros-archive-keyring.gpg')
ROS_FINGERPRINT = 'C1CF6E31E6BADE8868B172B4F42ED6FBAB17C654'


class Failure(Exception):
    pass


def run(args, *, capture=False, check=True, env=None, cwd=None, input=None, quiet=False):
    # Do not include argv or raw subprocess errors in exceptions: a future command
    # may contain a secret. Database commands also suppress stderr (see backup).
    result = subprocess.run([str(a) for a in args], text=True, cwd=cwd, env=env,
                            input=input, stdout=subprocess.PIPE if capture or quiet else None,
                            stderr=subprocess.PIPE if capture or quiet else None)
    if check and result.returncode:
        raise Failure(f'{Path(args[0]).name} failed (exit {result.returncode}); later steps were not run.')
    return result


def systemctl(*args, **kwargs):
    return run(['systemctl', *args], **kwargs)


def active(unit):
    return systemctl('is-active', '--quiet', unit, check=False, quiet=True).returncode == 0


def secure_write(path, text, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.skao-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def check_ubuntu():
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines()
                   if '=' in line and not line.startswith('#'))
    system = release.get('ID', '').strip('"')
    version = release.get('VERSION_ID', '').strip('"')
    if system != 'ubuntu' or version != '24.04':
        raise Failure(f'Native deployment requires Ubuntu 24.04 on a PC, VM or ARM64 device; '
                      f'detected {system or "unknown OS"} {version or "unknown version"}. '
                      'Use SKAO.sh build for development validation without host installation.')
    if not Path('/run/systemd/system').is_dir():
        raise Failure('Run this on the Ubuntu host with systemd, not in a container.')


def node_binary(*, service=True):
    node = shutil.which('node')
    if not node:
        raise Failure('Node is not installed or is not on PATH.')
    if service and node not in ('/usr/bin/node', '/usr/local/bin/node'):
        raise Failure('Install system-wide Node 22.12+ or 24 using APT; a per-user Node install cannot run the boot service.')
    version = run([node, '--version'], capture=True).stdout.strip()
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', version)
    parts = tuple(map(int, match.groups())) if match else (0, 0, 0)
    if not ((parts[0] == 20 and parts >= (20, 19, 0)) or
            (parts[0] == 22 and parts >= (22, 12, 0)) or parts[0] == 24):
        raise Failure('Use Node 20.19+, 22.12+ or 24. Node 24 is recommended for this deployment.')
    if not shutil.which('npm'):
        raise Failure('npm is missing from this Node installation.')
    return node


def validate_network(address, prefix, interface):
    try:
        ip = ipaddress.IPv4Address(address)
        network = ipaddress.ip_network(f'{address}/{prefix}', strict=False)
    except ValueError:
        raise Failure('Select an IPv4 address on the trusted private LAN.') from None
    if not any(network.subnet_of(n) for n in PRIVATE) or network.prefixlen > 30:
        raise Failure('The address and subnet must be within an RFC1918 private LAN.')
    if ip in (network.network_address, network.broadcast_address):
        raise Failure('The selected address is not a usable LAN host address.')
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', interface):
        raise Failure('Unexpected network interface name.')
    return {'ip': str(ip), 'cidr': str(network), 'interface': interface}


def lan_address(requested=None):
    candidates = []
    for device in json.loads(run(['ip', '-j', '-d', '-4', 'address', 'show', 'up'], capture=True).stdout):
        name = device['ifname']
        # Guest Ethernet adapters (virtio, VMware, Hyper-V, VirtualBox) are
        # legitimate LAN interfaces too. Classify the link, not its hardware.
        # Exclude tunnels/container links even when --ip is supplied.
        if (device.get('link_type') != 'ether' or
                device.get('linkinfo', {}).get('info_kind') not in (None, 'vlan', 'bond', 'team')):
            continue
        for address in device.get('addr_info', []):
            if (address.get('scope') != 'global' or address.get('tentative', False) or
                    address.get('dadfailed', False)):
                continue
            try:
                candidate = validate_network(address['local'], address['prefixlen'], name)
            except Failure:
                continue
            if requested is None or requested == candidate['ip']:
                candidates.append(candidate)
    if len(candidates) != 1:
        raise Failure('Cannot select one private LAN address on an Ethernet, Wi-Fi or VM guest adapter. '
                      'Use setup --ip YOUR_LAN_IP if multiple addresses are present. '
                      'For phone access to a VM, use a bridged/external adapter on the trusted LAN.')
    return candidates[0]


def database_settings(values):
    raw = values.get('DATABASE_URL', '')
    try:
        url = urlsplit(raw)
        port = url.port or 5432
        name = unquote(url.path.lstrip('/'))
        user = unquote(url.username or '')
        password = unquote(url.password or '')
        if (url.scheme not in ('postgres', 'postgresql') or
                url.hostname not in ('localhost', '127.0.0.1', '::1') or
                not name or not user or url.query or url.fragment or
                not 1 <= port <= 65535 or port in (53, 443, 3001, 5173)):
            raise ValueError()
        if any(c in raw + name + user + password for c in '\r\n\0'):
            raise ValueError()
    except ValueError:
        raise Failure('DATABASE_URL must name the existing local PostgreSQL database, with no query string. Percent-encode special characters in credentials.') from None
    schema = values.get('DB_SCHEMA', 'public')
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', schema):
        raise Failure('DB_SCHEMA is invalid.')
    zone = values.get('FACILITY_TIME_ZONE', 'America/Los_Angeles')
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        raise Failure('FACILITY_TIME_ZONE is invalid.') from None
    return {'url': raw, 'host': url.hostname, 'port': port, 'name': name,
            'user': user, 'password': password, 'schema': schema, 'zone': zone}


def read_source_environment(repo, node):
    path = repo / 'server/.env'
    if not path.is_file():
        raise Failure('Configure server/.env with the existing DATABASE_URL before setup.')
    # Node's own dotenv parser; never execute/source the file.
    code = "process.stdout.write(JSON.stringify(require('node:util').parseEnv(require('node:fs').readFileSync(process.argv[1],'utf8'))))"
    values = json.loads(run([node, '-e', code, str(path)], capture=True).stdout)
    db = database_settings(values)
    return {'DATABASE_URL': db['url'], 'DB_SCHEMA': db['schema'], 'FACILITY_TIME_ZONE': db['zone']}


def server_environment(cfg):
    return {**cfg['environment'], 'NODE_ENV': 'production', 'DB_ADAPTER': 'sequelize',
            'BIND_HOST': '127.0.0.1', 'PORT': '3001', 'APP_ORIGINS': 'https://' + cfg['domain']}


def environment_file(values):
    # systemd EnvironmentFile quoting (not shell or JSON escaping).
    lines = []
    for key, value in values.items():
        if not re.fullmatch('[A-Z_]+', key) or any(c in value for c in '\r\n\0'):
            raise Failure('Unexpected multiline environment setting.')
        quoted = value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
        lines.append(f'{key}="{quoted}"')
    return '\n'.join(lines) + '\n'


def build_release(repo, stage):
    tracked = run(['git', 'ls-files', '-z', '--', 'server', 'client', 'shared'], cwd=repo, capture=True).stdout
    for name in filter(None, tracked.split('\0')):
        source = repo / name
        rel = Path(name)
        if any(p in ('node_modules', 'dist', '.git', 'test-results', 'playwright-report', '__pycache__') for p in rel.parts):
            continue
        if source.name == '.env' or source.name.endswith(('.dump', '.backup', '.log')):
            continue
        if source.is_symlink() or not source.resolve().is_relative_to(repo):
            raise Failure('Application source must not contain symlinks outside the release.')
        if source.is_file():
            destination = stage / 'release' / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    for folder, args in [('server', ['ci', '--omit=dev']), ('client', ['ci', '--include=dev'])]:
        print(f'Installing locked {folder} dependencies as your normal user.', flush=True)
        run(['npm', *args], cwd=stage / 'release' / folder)
    env = {**os.environ, 'VITE_API_BASE_URL': '/'}
    run(['npm', 'run', 'build'], cwd=stage / 'release/client', env=env)
    # node-gyp may leave an absolute link to the build machine's Python. The
    # compiled addon is needed at runtime; this build-only helper directory isn't.
    for helper in (stage / 'release/server/node_modules').rglob('build/node_gyp_bins'):
        if helper.is_dir() and not helper.is_symlink():
            shutil.rmtree(helper)
    # Web service only needs the build, not the build toolchain.
    shutil.rmtree(stage / 'release/client/node_modules')
    shutil.copytree(repo / 'deploy/ubuntu', stage / 'templates')
    shutil.copy2(Path(__file__), stage / 'ubuntu.py')


def root_call(command, *args):
    run(['sudo', '--', '/usr/bin/python3', str(Path(__file__).resolve()), command, *map(str, args)])


def public_build():
    """Validate a production build without installing anything on this host."""
    if os.geteuid() == 0:
        raise Failure('Run SKAO.sh build as your normal user, without sudo.')
    node_binary(service=False)
    repo = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='skao-build-check-') as directory:
        build_release(repo, Path(directory))
    print('PASS Production build. No services, firewall, DNS, certificates or database were changed. '
          'Build files were temporary; the deployment host builds its own native dependencies.')


def public_deploy(args):
    if os.geteuid() == 0:
        raise Failure('Run SKAO.sh as your normal user, without sudo. It requests sudo only for host management.')
    check_ubuntu()
    repo = Path(__file__).resolve().parent.parent
    node = node_binary()
    if args.command == 'update' and not args.local:
        if run(['git', 'status', '--porcelain'], cwd=repo, capture=True).stdout:
            raise Failure('The checkout has local changes. Commit them first, or use update --local to test them.')
        run(['git', 'pull', '--ff-only'], cwd=repo)
        # Re-execute so changes to this helper are used after pulling.
        os.execv(sys.executable, [sys.executable, str(Path(__file__)), 'update', '--local'])
    metadata = {'node': node, 'operation': args.command}
    if args.command == 'setup':
        metadata.update(lan_address(args.ip))
        metadata['domain'] = DOMAIN
        metadata['environment'] = read_source_environment(repo, node)
        print(f"Host address: {metadata['ip']} ({metadata['interface']}). Keep this address stable and its DNS record in sync.", flush=True)
        root_call('_packages')
    else:
        root_call('_preflight')
    with tempfile.TemporaryDirectory(prefix='skao-build-') as directory:
        stage = Path(directory)
        build_release(repo, stage)
        metadata['revision'] = run(['git', 'rev-parse', '--short=12', 'HEAD'], cwd=repo, capture=True).stdout.strip()
        secure_write(stage / 'request.json', json.dumps(metadata))
        root_call('_install', stage)


def check_managed():
    if CONF.exists() and (not (CONF / 'owner').is_file() or (CONF / 'owner').read_text() != MARKER):
        raise Failure('/etc/skao/native is not owned by this installer; refusing to overwrite it.')
    if not CONF.exists():
        for path in [ROOT, HELPER.parent, CONF.parent, *UNITS.glob('skao*')]:
            if path.exists():
                raise Failure('An unmanaged SKAO installation exists; inspect it before installing.')


def configuration():
    check_managed()
    if not (CONF / 'config.json').exists():
        raise Failure('Run bash SKAO.sh setup first.')
    return json.loads((CONF / 'config.json').read_text())


def listener_preflight(cfg=None):
    # Existing loopback DNS is compatible with our separate LAN-only listener.
    db_port = database_settings(cfg['environment'])['port'] if cfg else 5432
    owners = {}
    if cfg:
        for port, unit in [(3001, 'skao-api.service'), (443, 'skao-web.service'), (53, 'skao-dns.service')]:
            pid = systemctl('show', unit, '--property=MainPID', '--value', capture=True, check=False).stdout.strip()
            if pid.isdigit() and int(pid):
                owners[port] = pid
    for proto in ('-ltnp', '-lunp'):
        for line in run(['ss', '-H', proto], capture=True).stdout.splitlines():
            fields = line.split()
            if len(fields) < 5:
                continue
            address, _, port = fields[3].rpartition(':')
            # ss may include the bound interface, e.g. 127.0.0.53%lo:53.
            # Compare the address itself while retaining the original endpoint
            # for diagnostics. Wildcard listeners must still fail closed.
            address = address.strip('[]').split('%', 1)[0]
            if not port.isdigit():
                continue
            port = int(port)
            if port == db_port and address not in ('127.0.0.1', '::1'):
                raise Failure('PostgreSQL is listening beyond loopback. Set its listen_addresses to localhost before setup; this script does not rewrite your database configuration.')
            if port == 5173:
                raise Failure('Stop the manually started Vite and Node servers before setup (Ctrl+C in their terminals).')
            if port == 53:
                try:
                    if ipaddress.ip_address(address).is_loopback:
                        continue
                except ValueError:
                    pass  # ss can print a wildcard as '*'; it is not loopback.
            if port in (53, 443, 3001):
                allowed = {'127.0.0.1'} if port == 3001 else {cfg['ip'], '127.0.0.1'} if cfg else set()
                if address not in allowed or owners.get(port) not in re.findall(r'pid=(\d+)', line):
                    if port == 53:
                        raise Failure(f"DNS port 53 is occupied at {fields[3]}. Run sudo ss -H -lntup 'sport = :53' to identify it. Leave the existing DNS service running until the conflict is reviewed.")
                    if port == 443:
                        raise Failure(f"HTTPS port 443 is occupied at {fields[3]}. Run sudo ss -H -ltnp 'sport = :443' to identify the existing web service.")
                    raise Failure(f'API port 3001 is occupied at {fields[3]}. Stop the manually started Node server before setup.')


def packages():
    check_managed()
    cfg = configuration() if (CONF / 'config.json').exists() else None
    listener_preflight(cfg)
    marker = CONF / 'owner'
    if not marker.exists():
        if run(['dpkg-query', '-W', '-f=${Status}', 'caddy'], capture=True, check=False).stdout == 'install ok installed':
            raise Failure('Caddy is already installed outside SKAO. Review that configuration before using this dedicated-host installer.')
        CONF.parent.mkdir(parents=True, exist_ok=True)
        CONF.parent.chmod(0o755)
        CONF.mkdir(mode=0o755)
        CONF.chmod(0o755)
        secure_write(marker, MARKER)
    # Prevent the package's default wildcard HTTP listener, including during apt.
    systemctl('mask', '--now', 'caddy.service')
    print('Refreshing package indexes; all configured repositories must verify successfully.', flush=True)
    try:
        # Without this option apt can exit successfully after reusing stale
        # indexes from a repository whose signing key has expired.
        run(['apt-get', '--error-on=any', 'update'])
    except Failure as error:
        raise Failure(f'{error} Package indexes were not refreshed successfully. '
                      'Resolve the APT error above before rerunning setup. '
                      'For ROS EXPKEYSIG, see the package troubleshooting section in docs/ubuntu-native.md.') from None
    print(f'Installing prerequisites; APT will wait up to {APT_LOCK_TIMEOUT // 60} minutes '
          'for the package-install lock. Leave automatic updates running.', flush=True)
    try:
        # APT owns acquisition/release of the dpkg locks. This command-scoped
        # timeout does not change global APT settings or stop the updater.
        # It does not cover the separate apt update lists lock.
        run(['apt-get', '-o', f'DPkg::Lock::Timeout={APT_LOCK_TIMEOUT}', 'install', '-y',
             'caddy', 'certbot', 'python3-certbot-dns-cloudflare', 'dnsmasq-base', 'dnsutils',
             'nftables', 'postgresql-client', 'build-essential', 'python3', 'ca-certificates',
             'curl', 'openssl', 'iproute2'])
    except Failure as error:
        raise Failure(f'{error} Prerequisite installation did not complete. '
                      'If APT still reports a lock, let the other package operation finish and rerun setup. '
                      'Do not delete lock files or stop the updater.') from None
    # The mask is intentional and limited to the package's unused caddy.service.
    # SKAO runs its own skao-web.service, with a LAN-only bind and separate identity.


def legacy_ros_sources():
    """Accept only the legacy ROS 2 layout this one-time repair supports."""
    sources = [APT_SOURCES / 'sources.list',
               *sorted((APT_SOURCES / 'sources.list.d').glob('*.list')),
               *sorted((APT_SOURCES / 'sources.list.d').glob('*.sources'))]
    found = []
    for source in sources:
        if not source.exists():
            continue
        for line in source.read_text().splitlines():
            line = line.split('#', 1)[0].strip()
            if not re.search(r'https?://packages\.ros\.org/ros2(?:/|\s|$)', line):
                continue
            entry = re.fullmatch(r'deb(?:-src)?\s+\[([^\]]+)\]\s+'
                                 r'https?://packages\.ros\.org/ros2/ubuntu/?\s+noble\s+main\s*', line)
            if source.suffix == '.sources' or not entry or \
                    ('signed-by=' + str(ROS_KEY)) not in entry.group(1).split():
                raise Failure(f'ROS source {source} uses a different layout or signing key. '
                              'No key was changed; review that source before repairing it.')
            found.append(source)
    if not found:
        raise Failure('No supported legacy ROS 2 Noble source was found. No key was changed.')
    return found


def inspect_ros_key(path, home, *, require_current):
    result = run(['gpg', '--batch', '--no-options', '--homedir', home,
                  '--with-colons', '--show-keys', path], capture=True)
    rows = [line.split(':') for line in result.stdout.splitlines()]
    primary = [i for i, row in enumerate(rows) if row[0] == 'pub']
    if (len(primary) != 1 or primary[0] + 1 >= len(rows) or
            rows[primary[0] + 1][0] != 'fpr' or
            rows[primary[0] + 1][9] != ROS_FINGERPRINT):
        raise Failure('The ROS key fingerprint did not match the official legacy ROS key. No key was changed.')
    key = rows[primary[0]]
    if require_current and (key[1] in ('r', 'e', 'd') or not key[6].isdigit() or int(key[6]) <= time.time()):
        raise Failure('The downloaded ROS key is expired, revoked or unusable. No key was changed.')


def repair_ros_key():
    """Explicit, narrowly scoped key refresh from the official ROS migration guide.

    Keep repository definitions and ROS packages intact. Do not run this from
    setup automatically: the ROS repository belongs to the host, not SKAO.
    """
    legacy_ros_sources()
    if not ROS_KEY.is_file() or ROS_KEY.is_symlink():
        raise Failure('The expected legacy ROS key must be an existing regular file. No key was changed.')
    owner = run(['dpkg-query', '-S', ROS_KEY], capture=True, check=False)
    if owner.returncode != 1:
        raise Failure('The ROS key is package-managed or its ownership could not be checked. '
                      'Use the ROS package migration instructions; no key was changed.')
    if not shutil.which('curl') or not shutil.which('gpg'):
        raise Failure('This repair requires curl and gpg. No key was changed.')
    with tempfile.TemporaryDirectory(prefix='skao-ros-key-') as temporary:
        home = Path(temporary)
        inspect_ros_key(ROS_KEY, home, require_current=False)
        downloaded = home / 'ros.key'
        print('Downloading the refreshed signing key from the official ros/rosdistro repository.', flush=True)
        run(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
             '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '60',
             'https://raw.githubusercontent.com/ros/rosdistro/master/ros.key', '--output', downloaded])
        inspect_ros_key(downloaded, home, require_current=True)
        if downloaded.read_bytes() == ROS_KEY.read_bytes():
            print('The ROS key is already current. Rerun bash SKAO.sh setup.')
            return
        timestamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup_path = ROS_KEY.with_name(ROS_KEY.name + '.before-skao-' + timestamp + '.bak')
        with backup_path.open('xb') as backup_file:
            os.fchmod(backup_file.fileno(), 0o600)
            backup_file.write(ROS_KEY.read_bytes())
            backup_file.flush()
            os.fsync(backup_file.fileno())
        fd, name = tempfile.mkstemp(prefix='.skao-ros-key-', dir=ROS_KEY.parent)
        try:
            with os.fdopen(fd, 'wb') as replacement:
                os.fchmod(replacement.fileno(), 0o644)
                replacement.write(downloaded.read_bytes())
                replacement.flush()
                os.fsync(replacement.fileno())
            os.replace(name, ROS_KEY)
        finally:
            Path(name).unlink(missing_ok=True)
        print(f'Refreshed the ROS signing key. Previous key saved at {backup_path}\n'
              'Repository definitions and installed ROS packages were preserved.\n'
              'Rerun bash SKAO.sh setup to verify the repository and continue.')


def create_accounts():
    for user in ('skao-api', 'skao-web', 'skao-dns'):
        try:
            record = pwd.getpwnam(user)
        except KeyError:
            run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
                 '--shell', '/usr/sbin/nologin', user])
            record = pwd.getpwnam(user)
        if (record.pw_shell != '/usr/sbin/nologin' or record.pw_uid == 0 or record.pw_gid == 0 or
                grp.getgrnam(user).gr_gid != record.pw_gid or
                set(os.getgrouplist(user, record.pw_gid)) != {record.pw_gid}):
            raise Failure(f'{user} exists with an unexpected identity; inspect before continuing.')


def render(template, cfg):
    values = {'DOMAIN': cfg['domain'], 'LAN_IP': cfg['ip'], 'LAN_CIDR': cfg['cidr'],
              'DB_PORT': str(database_settings(cfg['environment'])['port']), 'NODE': cfg['node']}
    for key, value in values.items():
        template = template.replace('@' + key + '@', value)
    if re.search(r'@[A-Z_]+@', template):
        raise Failure('An installation template contains an unresolved setting.')
    return template


def backup(cfg):
    db = database_settings(cfg['environment'])
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    BACKUPS.chmod(0o700)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = BACKUPS / (timestamp + '.dump')
    partial = destination.with_suffix('.partial')
    env = {'PATH': SAFE_PATH, 'PGHOST': db['host'], 'PGPORT': str(db['port']),
           'PGUSER': db['user'], 'PGPASSWORD': db['password'], 'PGDATABASE': db['name'],
           'PGCONNECT_TIMEOUT': '10', 'PGSSLMODE': 'prefer'}
    try:
        run(['pg_dump', '--no-password', '--format=custom', '--file', partial], env=env, quiet=True)
        run(['pg_restore', '--list', partial], env=env, quiet=True)
        partial.chmod(0o600)
        partial.replace(destination)
    except Failure:
        partial.unlink(missing_ok=True)
        raise Failure('PostgreSQL backup failed; no migration or release switch was attempted. Check local database access and pg_dump/server version compatibility.') from None
    print(f'Backup archive created and its directory checked: {destination}', flush=True)
    return destination


def certbot_args():
    return ['certbot', '--config-dir', CONF / 'acme', '--work-dir', '/var/lib/skao-acme',
            '--logs-dir', CONF / 'acme-logs']


def issue_certificate(cfg):
    token_path = CONF / 'cloudflare.ini'
    if not token_path.exists():
        print('Enter a Cloudflare API token with Zone / DNS / Edit for smartkidsacademycenter.com only.')
        token = getpass.getpass('Cloudflare token (hidden; never paste it in chat): ').strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', token):
            raise Failure('The token format is invalid; nothing was saved.')
        secure_write(token_path, 'dns_cloudflare_api_token = ' + token + '\n')
    for folder in (CONF / 'acme', CONF / 'acme-logs', Path('/var/lib/skao-acme')):
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        folder.chmod(0o700)
    args = certbot_args() + ['certonly', '--non-interactive', '--dns-cloudflare',
                            '--dns-cloudflare-credentials', token_path, '--dns-cloudflare-propagation-seconds', '60',
                            '--cert-name', 'skao-app', '-d', cfg['domain'], '--keep-until-expiring',
                            '--server', 'https://acme-v02.api.letsencrypt.org/directory']
    if not any((CONF / 'acme/accounts').rglob('regr.json')):
        print('Certificate issuance requires the Let\'s Encrypt subscriber agreement: https://letsencrypt.org/repository/')
        if input('Agree to the certificate terms? Type yes: ').strip().lower() != 'yes':
            raise Failure('Certificate terms were not accepted; setup stopped before certificate issuance.')
        email = input('Certificate account contact email: ').strip()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise Failure('Enter a valid contact email.')
        args += ['--agree-tos', '--email', email]
    run(args)
    install_certificate()


def install_certificate():
    source = CONF / 'acme/live/skao-app'
    tls = CONF / 'tls'
    tls.mkdir(exist_ok=True, mode=0o750)
    tls.chmod(0o750)
    group = pwd.getpwnam('skao-web').pw_gid
    os.chown(tls, 0, group)
    for name in ('fullchain.pem', 'privkey.pem'):
        secure_write(tls / name, (source / name).read_text(), 0o640)
        os.chown(tls / name, 0, group)
    if active('skao-web.service'):
        systemctl('reload', 'skao-web.service')


def apply_firewall():
    # Delete/recreate ONLY our table in one atomic nft transaction. Never flush ruleset.
    exists = run(['nft', 'list', 'table', 'inet', 'skao_native'], capture=True, check=False).returncode == 0
    rules = ('delete table inet skao_native\n' if exists else '') + (CONF / 'firewall.nft').read_text()
    run(['nft', '-c', '-f', '-'], input=rules)
    run(['nft', '-f', '-'], input=rules)


def allow_existing_ufw(cfg):
    if not shutil.which('ufw'):
        return
    if not run(['ufw', 'status'], capture=True).stdout.startswith('Status: active'):
        return
    for port, proto in [('443', 'tcp'), ('53', 'tcp'), ('53', 'udp')]:
        run(['ufw', 'allow', 'in', 'on', cfg['interface'], 'proto', proto,
             'from', cfg['cidr'], 'to', cfg['ip'], 'port', port, 'comment', 'SKAO-native'])


def copy_release(stage, revision):
    ROOT.mkdir(exist_ok=True, mode=0o755)
    ROOT.chmod(0o755)
    releases = ROOT / 'releases'
    releases.mkdir(parents=True, exist_ok=True, mode=0o755)
    releases.chmod(0o755)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    release = releases / (stamp + '-' + revision)
    shutil.copytree(stage / 'release', release, symlinks=True)
    release.chmod(0o755)
    # Reject dangling/outside symlinks and special files before anything executes.
    for entry in release.rglob('*'):
        if entry.is_symlink():
            if not entry.resolve().is_relative_to(release) or not entry.exists():
                raise Failure('Release contains an unsafe symlink; activation stopped.')
        elif entry.is_dir():
            entry.chmod(0o755)
        elif entry.is_file():
            executable = entry.stat().st_mode & 0o111
            entry.chmod(0o755 if executable else 0o644)
        else:
            raise Failure('Release contains a special file; activation stopped.')
    return release


def migrate(cfg, release):
    user = pwd.getpwnam('skao-api')
    env = {'PATH': SAFE_PATH, 'HOME': '/nonexistent', **server_environment(cfg)}
    # Drop all supplementary groups too. No npm or application code runs as root.
    result = subprocess.run([cfg['node'], 'scripts/database.js', 'migrate'], cwd=release / 'server',
                            env=env, user=user.pw_uid, group=user.pw_gid, extra_groups=[],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise Failure('Database migration failed. Services remain stopped; the previous release and backup are retained. No automatic database rollback was attempted.')
    print('Database migrations completed.', flush=True)


def activate(cfg, release):
    secure_write(CONF / 'activation.pending', str(release) + '\n')
    # Leave local DNS and the sleep inhibitor running during updates, including
    # failed migrations; other devices may depend on this DNS server.
    systemctl('stop', 'skao-web.service', 'skao-api.service')
    # A failed backup or migration cannot fall through to restart/switch.
    backup(cfg)
    migrate(cfg, release)
    link = ROOT / 'next'
    link.unlink(missing_ok=True)
    link.symlink_to(release)
    link.replace(ROOT / 'current')
    (CONF / 'activation.pending').unlink()
    systemctl('daemon-reload')
    systemctl('enable', 'skao.target', 'skao-renew.timer')
    systemctl('restart', 'skao-dns.service', 'skao-awake.service')
    start_services(cfg)


def start_services(cfg):
    if (CONF / 'activation.pending').exists():
        raise Failure('A previous activation stopped before completion. Fix that error and rerun update --local (or setup for a first install) before starting the app.')
    current = lan_address(cfg['ip'])
    if current['cidr'] != cfg['cidr'] or current['interface'] != cfg['interface']:
        raise Failure('The configured LAN address/subnet/interface changed. Restore the deployment host network settings '
                      'or review /etc/skao/native/config.json before starting.')
    listener_preflight(cfg)
    systemctl('restart', 'skao-firewall.service')
    systemctl('reset-failed', *SERVICES, check=False, quiet=True)
    systemctl('start', 'skao.target', *SERVICES)
    systemctl('start', 'skao-renew.timer')
    doctor(cfg, wait=True)


def install(stage):
    check_managed()
    stage = Path(stage).resolve()
    request = json.loads((stage / 'request.json').read_text())
    if request['node'] != node_binary() or not re.fullmatch(r'[a-f0-9]{7,40}', request['revision']):
        raise Failure('Unexpected release metadata.')
    existing = configuration() if (CONF / 'config.json').exists() else None
    if request['operation'] == 'setup':
        cfg = {key: request[key] for key in ('node', 'ip', 'cidr', 'interface', 'domain', 'environment')}
        if cfg['domain'] != DOMAIN or lan_address(cfg['ip']) != {k: cfg[k] for k in ('ip', 'cidr', 'interface')}:
            raise Failure('The selected local address changed during the build.')
        database_settings(cfg['environment'])
        if existing and cfg != existing:
            raise Failure('Setup would change installed settings. Restore the reserved IP or review /etc/skao/native/config.json before proceeding; existing settings were kept.')
    else:
        cfg = existing or configuration()
        if cfg['node'] != request['node']:
            raise Failure('The installed Node path changed; review service settings before updating.')
    listener_preflight(existing or cfg)
    create_accounts()
    release = copy_release(stage, request['revision'])
    HELPER.parent.mkdir(parents=True, exist_ok=True)
    secure_write(HELPER, (stage / 'ubuntu.py').read_text(), 0o644)
    if request['operation'] == 'setup':
        # Persist resumable setup settings before talking to the certificate authority.
        secure_write(CONF / 'config.json', json.dumps(cfg, indent=2) + '\n')
        secure_write(CONF / 'server.env', environment_file(server_environment(cfg)))
        issue_certificate(cfg)
    for template in (stage / 'templates').iterdir():
        destination = UNITS / template.name if template.suffix in ('.service', '.timer', '.target') else CONF / template.name
        secure_write(destination, render(template.read_text(), cfg), 0o644)
    run(['caddy', 'validate', '--config', CONF / 'Caddyfile', '--adapter', 'caddyfile'])
    run(['dnsmasq', '--test', '--conf-file=' + str(CONF / 'dnsmasq.conf')])
    apply_firewall()
    allow_existing_ufw(cfg)
    activate(cfg, release)
    print(f"\nReady: https://{cfg['domain']}\nLocal DNS address for the router/test device: {cfg['ip']}\n"
          f"For the current pilot, set Cloudflare's app A record to {cfg['ip']} with DNS only (gray cloud).\n"
          'Keep the deployment host powered on and the DNS record in sync with its private IP.\n'
          'Local DNS is also available for a centrally managed private network. '
          'Keep Internet port forwarding and public proxy/tunnel access disabled.', flush=True)


def doctor(cfg, wait=False):
    tries = 20 if wait else 1
    for attempt in range(tries):
        states = [active(unit) for unit in SERVICES]
        result = run(['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '5',
                      '--resolve', f"{cfg['domain']}:443:{cfg['ip']}",
                      'https://' + cfg['domain'] + '/api/ready'], capture=True, check=False)
        if all(states) and result.returncode == 0:
            break
        if attempt + 1 < tries:
            time.sleep(1)
    dns = run(['dig', '+time=2', '+tries=1', '+short', '@' + cfg['ip'], cfg['domain'], 'A'], capture=True, check=False)
    asleep = run(['systemd-inhibit', '--list', '--no-pager', '--no-legend'], capture=True, check=False)
    firewall = run(['nft', 'list', 'table', 'inet', 'skao_native'], capture=True, check=False)
    checks = list(zip(SERVICES, states)) + [('HTTPS and database readiness', result.returncode == 0),
              ('Local DNS', dns.returncode == 0 and dns.stdout.strip() == cfg['ip']),
              ('Keep-awake inhibitor', asleep.returncode == 0 and 'SKAO' in asleep.stdout),
              ('Firewall rules', active('skao-firewall.service') and firewall.returncode == 0)]
    for label, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'} {label}")
    if not all(ok for _, ok in checks):
        raise Failure('Some host checks failed. Run bash SKAO.sh logs; do not bypass certificate verification.')
    run(['openssl', 'x509', '-in', CONF / 'tls/fullchain.pem', '-noout', '-enddate'])


def management(command):
    cfg = configuration()
    if command in ('start', 'restart'):
        if command == 'restart':
            systemctl('stop', 'skao.target', *SERVICES)
        start_services(cfg)
    elif command == 'stop':
        systemctl('stop', 'skao.target', *SERVICES)
        print('SKAO stopped; the sleep inhibitor is released. Devices using this host for DNS cannot resolve names until it starts again.')
    elif command == 'status':
        print(f"Address: https://{cfg['domain']}\nLocal DNS: {cfg['ip']}")
        systemctl('--no-pager', '--full', 'status', *SERVICES, 'skao-renew.timer', check=False)
        doctor(cfg)
    elif command == 'logs':
        run(['journalctl', '--no-pager', '-n', '100', *[arg for unit in SERVICES + ['skao-renew.service'] for arg in ('-u', unit)]])
    elif command == 'backup':
        backup(cfg)
    elif command in ('_renew', 'renew-test'):
        args = certbot_args() + ['renew', '--cert-name', 'skao-app', '--non-interactive',
                                '--deploy-hook', '/usr/bin/python3 /usr/local/lib/skao/ubuntu.py _certificate']
        if command == 'renew-test':
            args.append('--dry-run')
        run(args)
    elif command == '_certificate':
        install_certificate()
    elif command == '_preflight':
        listener_preflight(cfg)
        lan_address(cfg['ip'])


def main():
    parser = argparse.ArgumentParser(description='SKAO native Ubuntu setup and maintenance (no Docker).')
    sub = parser.add_subparsers(dest='command', required=True, metavar='COMMAND')
    sub.add_parser('build', help='validate a temporary production build without sudo, host setup, certificates or database access')
    setup = sub.add_parser('setup', help='build/install native HTTPS and local DNS; prompts locally for Cloudflare token')
    setup.add_argument('--ip', help='select the host LAN IPv4 if more than one Ethernet/Wi-Fi/VM address is available')
    update = sub.add_parser('update', help='pull current branch, build, back up, migrate and restart')
    update.add_argument('--local', action='store_true', help='use tracked working-tree files without git pull')
    public = {'start': 'start local services and check HTTPS', 'stop': 'stop local services and release the sleep inhibitor',
              'restart': 'restart local services', 'status': 'check services, local DNS and trusted HTTPS',
              'logs': 'show recent service errors', 'backup': 'save a PostgreSQL archive',
              'repair-ros-key': 'refresh an expired legacy ROS 2 Noble key after checking its fingerprint',
              'renew-test': 'test certificate renewal without installing a test certificate'}
    for name, help_text in public.items():
        sub.add_parser(name, help=help_text)
    for name in ('_packages', '_preflight', '_firewall', '_renew', '_certificate'):
        sub.add_parser(name)
    sub.add_parser('_install').add_argument('stage')
    args = parser.parse_args()
    try:
        if args.command == 'build':
            public_build()
            return
        if args.command in ('setup', 'update'):
            public_deploy(args)
            return
        if os.geteuid() != 0:
            if args.command not in public:
                raise Failure('Internal operation requires the installer.')
            root_call(args.command)
            return
        os.umask(0o077)
        os.environ['PATH'] = SAFE_PATH
        os.environ['LC_ALL'] = 'C'
        check_ubuntu()
        # Renewal starts a deploy hook which obtains this lock independently.
        # The firewall unit also runs while the installer holds the lock.
        if args.command in ('_renew', 'renew-test', '_firewall'):
            if args.command == '_firewall':
                apply_firewall()
            else:
                management(args.command)
            return
        with open('/run/lock/skao-native.lock', 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure('Another SKAO management operation is running; retry after it finishes.') from None
            if args.command == '_packages':
                packages()
            elif args.command == 'repair-ros-key':
                repair_ros_key()
            elif args.command == '_install':
                install(args.stage)
            else:
                management(args.command)
    except (Failure, OSError, ValueError, KeyError) as error:
        # File/JSON errors can contain credentials or token values; suppress them.
        message = str(error) if isinstance(error, Failure) else 'Could not read or apply deployment settings. Check local permissions, configuration and available disk space.'
        print('\nStopped: ' + message + '\nNo automatic database rollback was attempted.', file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print('\nCancelled. No automatic rollback was attempted; rerun setup/update when ready.', file=sys.stderr)
        sys.exit(130)


if __name__ == '__main__':
    main()
