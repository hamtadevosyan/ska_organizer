#!/usr/bin/env python3
"""Real Ubuntu-package config/loopback checks using synthetic data and test TLS.

Runs no apt commands and does not install services or modify host firewalls.
CI additionally validates firewall syntax with nft --check as root.
"""

from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import grp
import pwd
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ubuntu', REPO / 'scripts/ubuntu.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
CFG = {'node': '/usr/bin/node', 'ip': '192.168.50.20', 'cidr': '192.168.50.0/24',
       'domain': u.DOMAIN, 'interface': 'eth0',
       'environment': {'DATABASE_URL': 'postgresql://test:synthetic@127.0.0.1:5432/ska_test'}}


def command(args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, text=True, capture_output=True, **kwargs).stdout


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


class API(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'path': self.path}).encode()
        self.send_response(401 if self.path == '/api/rooms' else 200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def dns_query(port_number, record_type):
    question = b''.join(bytes([len(label)]) + label.encode() for label in u.DOMAIN.split('.')) + b'\0'
    packet = struct.pack('!6H', 451, 256, 1, 0, 0, 0) + question + struct.pack('!2H', record_type, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        sock.sendto(packet, ('127.0.0.1', port_number))
        return sock.recv(2048)


def main():
    caddy = os.environ.get('CADDY_BIN') or shutil.which('caddy')
    dnsmasq = os.environ.get('DNSMASQ_BIN') or shutil.which('dnsmasq')
    assert caddy and dnsmasq, 'Install the Ubuntu caddy and dnsmasq-base test packages.'
    with tempfile.TemporaryDirectory(prefix='skao-config-') as directory, ExitStack() as stack:
        base = Path(directory)
        rendered = {}
        for source in (REPO / 'deploy/ubuntu').iterdir():
            rendered[source.name] = u.render(source.read_text(), CFG)
            (base / source.name).write_text(rendered[source.name])
        adapted = json.loads(command([caddy, 'adapt', '--config', base / 'Caddyfile', '--adapter', 'caddyfile']))
        listeners = [a for s in adapted['apps']['http']['servers'].values() for a in s['listen']]
        assert set(listeners) == {'192.168.50.20:443', '127.0.0.1:443'}, listeners
        assert adapted['admin']['listen'] == 'unix//run/skao-web/admin.sock'
        assert 'tls internal' not in rendered['Caddyfile']
        command([dnsmasq, '--test', '--conf-file=' + str(base / 'dnsmasq.conf')])
        print('PASS Real Caddy/dnsmasq parse: LAN HTTPS only, no HTTP/IPv6/public admin listener')

        if os.environ.get('SKAO_CHECK_NFT') == '1':
            command(['nft', '--check', '--file', base / 'firewall.nft'])
            print('PASS nftables syntax checked without applying rules')

        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                 '-subj', '/CN=' + u.DOMAIN, '-addext', 'subjectAltName=DNS:' + u.DOMAIN,
                 '-keyout', base / 'key.pem', '-out', base / 'cert.pem'])
        for path, contents in [('index.html', 'synthetic SPA'), ('sw.js', '// synthetic worker'),
                               ('manifest.webmanifest', '{"name":"synthetic"}'), ('assets/test.js', '// asset')]:
            file = base / 'site' / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(contents)
        api = HTTPServer(('127.0.0.1', 0), API)
        threading.Thread(target=api.serve_forever, daemon=True).start()
        stack.callback(api.server_close)
        stack.callback(api.shutdown)
        https_port = port()
        config = rendered['Caddyfile'].replace('https://' + u.DOMAIN, f'https://{u.DOMAIN}:{https_port}')
        for original, replacement in [
            ('bind 192.168.50.20 127.0.0.1', 'bind 127.0.0.1'),
            ('/etc/skao/native/tls/fullchain.pem', str(base / 'cert.pem')),
            ('/etc/skao/native/tls/privkey.pem', str(base / 'key.pem')),
            ('/run/skao-web/admin.sock', str(base / 'admin.sock')),
            ('/opt/skao/current/client/dist', str(base / 'site')),
            ('127.0.0.1:3001', f'127.0.0.1:{api.server_port}')]:
            config = config.replace(original, replacement)
        restricted_sandbox = os.environ.get('SKAO_TEST_NO_UNIX') == '1'
        if restricted_sandbox:
            # Some execution sandboxes prohibit Unix sockets. Disabling the admin
            # API is the safer local test fallback; CI exercises the real socket.
            config = config.replace('admin unix/' + str(base / 'admin.sock'), 'admin off')
        (base / 'Caddyfile').write_text(config)
        command([caddy, 'validate', '--config', base / 'Caddyfile', '--adapter', 'caddyfile'])
        log = stack.enter_context(open(base / 'caddy.log', 'w+'))
        process = subprocess.Popen([caddy, 'run', '--config', str(base / 'Caddyfile'), '--adapter', 'caddyfile'],
                                   env={**os.environ, 'XDG_DATA_HOME': str(base), 'XDG_CONFIG_HOME': str(base)},
                                   stdout=log, stderr=log)
        stack.callback(stop, process)
        for _ in range(60):
            try:
                with socket.create_connection(('127.0.0.1', https_port), timeout=0.2):
                    break
            except OSError:
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError(log.read())
                time.sleep(0.1)
        curl = ['curl', '--silent', '--show-error', '--noproxy', '*', '--max-time', '5',
                '--cacert', base / 'cert.pem', '--resolve', f'{u.DOMAIN}:{https_port}:127.0.0.1']
        for path, expected in [('/api/ready', '200'), ('/api/rooms', '401'), ('/dashboard', '200'),
                               ('/sw.js', '200'), ('/manifest.webmanifest', '200'), ('/assets/missing.js', '503')]:
            code = command([*curl, '-D', base / 'headers', '-o', base / 'body', '-w', '%{http_code}',
                            f'https://{u.DOMAIN}:{https_port}{path}'])
            assert code == expected, (path, code)
            headers = (base / 'headers').read_text().lower()
            body = (base / 'body').read_text()
            assert 'x-content-type-options: nosniff' in headers, (path, headers)
            if path.startswith('/api'):
                assert json.loads(body)['path'] == path  # /api is preserved by proxy
            if path in ('/sw.js', '/manifest.webmanifest') or path.startswith('/api'):
                assert 'no-store' in headers
            if path == '/dashboard':
                assert body == 'synthetic SPA'
        # Restart/reload path uses the actual Unix admin socket and preserves TLS.
        if not restricted_sandbox:
            command([caddy, 'reload', '--config', base / 'Caddyfile', '--adapter', 'caddyfile',
                     '--address', 'unix/' + str(base / 'admin.sock'), '--force'])
            print('PASS Unix-socket reload')
        print('PASS Trusted test TLS, SPA, API paths/status and PWA cache headers')

        if restricted_sandbox:
            print('SKIP Live DNS and Unix reload: restricted sandbox lacks netlink/Unix sockets; CI exercises both.')
            return

        dns_port = port()
        # An unreachable upstream proves the local A/AAAA responses do not need it.
        config = rendered['dnsmasq.conf'].replace('port=53', f'port={dns_port}')
        config = config.replace('listen-address=192.168.50.20', 'listen-address=127.0.0.1')
        config = config.replace('server=1.1.1.1', 'server=127.0.0.1#9').replace('server=1.0.0.1\n', '')
        (base / 'dnsmasq.conf').write_text(config)
        dns_log = stack.enter_context(open(base / 'dnsmasq.log', 'w+'))
        mode = '--no-daemon' if restricted_sandbox else '--keep-in-foreground'
        dns = subprocess.Popen([dnsmasq, mode, '--user=' + pwd.getpwuid(os.geteuid()).pw_name,
                                '--group=' + grp.getgrgid(os.getegid()).gr_name, '--conf-file=' + str(base / 'dnsmasq.conf')],
                               stdout=dns_log, stderr=dns_log)
        stack.callback(stop, dns)
        for _ in range(30):
            try:
                answer = dns_query(dns_port, 1)
                break
            except OSError:
                if dns.poll() is not None:
                    dns_log.seek(0)
                    raise AssertionError(dns_log.read())
                time.sleep(0.1)
        else:
            raise AssertionError('Synthetic DNS listener did not start.')
        assert socket.inet_ntoa(answer[-4:]) == CFG['ip']
        answer6 = dns_query(dns_port, 28)
        header = struct.unpack('!6H', answer6[:12])
        assert header[3] == 0, 'No IPv6 app address should be published'
        print('PASS Local DNS A/AAAA works without any public DNS record or upstream connection')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stdout)
        print(error.stderr)
        raise
