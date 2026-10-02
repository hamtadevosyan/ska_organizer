"""Isolated tests: no real services, DNS changes, certificates or customer data."""

import copy
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

MODULE = Path(__file__).resolve().parents[1] / 'ubuntu.py'
spec = importlib.util.spec_from_file_location('ubuntu', MODULE)
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
TEMPLATES = MODULE.parents[1] / 'deploy/ubuntu'
CFG = {'node': '/usr/bin/node', 'ip': '192.168.50.20', 'cidr': '192.168.50.0/24',
       'interface': 'eth0', 'domain': u.DOMAIN,
       'environment': {'DATABASE_URL': 'postgresql://ska:synthetic%21@127.0.0.1:5432/ska_test',
                       'DB_SCHEMA': 'public', 'FACILITY_TIME_ZONE': 'America/Los_Angeles'}}


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.contexts = ExitStack()
        self.addCleanup(self.contexts.close)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        for name, path in [('ROOT', self.base / 'opt'), ('CONF', self.base / 'conf'),
                           ('BACKUPS', self.base / 'backups')]:
            self.contexts.enter_context(patch.object(u, name, path))
            path.mkdir()
        (u.CONF / 'owner').write_text(u.MARKER)
        self.cfg = copy.deepcopy(CFG)

    def test_rfc1918_addresses_only_and_subnet_cannot_include_public_addresses(self):
        self.assertEqual(u.validate_network('192.168.50.20', 24, 'eth0')['cidr'], '192.168.50.0/24')
        for address, prefix in [('8.8.8.8', 24), ('127.0.0.1', 8), ('169.254.3.2', 16),
                                ('100.64.1.1', 10), ('10.0.1.2', 7), ('192.168.50.0', 24)]:
            with self.subTest(address=address), self.assertRaises(u.Failure):
                u.validate_network(address, prefix, 'eth0')

    def network_device(self, name='ens33', ip='192.168.50.20', kind=None, **address_flags):
        device = {'ifname': name, 'link_type': 'ether',
                  'addr_info': [{'local': ip, 'prefixlen': 24, 'scope': 'global', **address_flags}]}
        if kind:
            device['linkinfo'] = {'info_kind': kind}
        return device

    def discover_network(self, devices, requested=None):
        with patch.object(u, 'run', return_value=Mock(stdout=json.dumps(devices))) as command:
            result = u.lan_address(requested)
        self.assertEqual(command.call_args.args[0], ['ip', '-j', '-d', '-4', 'address', 'show', 'up'])
        return result

    def test_lan_selection_accepts_pi_pc_and_vm_guest_ethernet_without_sysfs_hardware_gate(self):
        for interface in ('wlan0', 'eth0', 'enp3s0', 'ens33', 'enp0s3', 'enp0s8'):
            with self.subTest(interface=interface):
                self.assertEqual(self.discover_network([self.network_device(interface)]),
                                 {'ip': '192.168.50.20', 'cidr': '192.168.50.0/24', 'interface': interface})

    def test_vm_nat_private_address_is_accepted_without_claiming_phone_reachability(self):
        self.assertEqual(self.discover_network([self.network_device(ip='10.0.2.15')])['ip'], '10.0.2.15')

    def test_explicit_ip_selects_one_of_multiple_guest_adapters(self):
        devices = [self.network_device('ens33'), self.network_device('ens34', '192.168.60.20')]
        with patch.object(u, 'run', return_value=Mock(stdout=json.dumps(devices))):
            with self.assertRaisesRegex(u.Failure, 'multiple addresses'):
                u.lan_address()
        self.assertEqual(self.discover_network(devices, '192.168.60.20')['interface'], 'ens34')

    def test_tunnels_container_links_and_bridges_cannot_be_selected_even_explicitly(self):
        for kind in ('veth', 'bridge', 'tun', 'wireguard', 'vxlan', 'dummy'):
            device = self.network_device(kind=kind)
            with self.subTest(kind=kind), patch.object(u, 'run', return_value=Mock(stdout=json.dumps([device]))):
                with self.assertRaises(u.Failure):
                    u.lan_address('192.168.50.20')
        loopback = self.network_device('lo', '127.0.0.1')
        loopback['link_type'] = 'loopback'
        with patch.object(u, 'run', return_value=Mock(stdout=json.dumps([loopback]))):
            with self.assertRaises(u.Failure):
                u.lan_address()

    def test_unready_and_public_addresses_are_not_selected(self):
        for options in ({'tentative': True}, {'dadfailed': True}, {'scope': 'host'}):
            with self.subTest(options=options), patch.object(u, 'run', return_value=Mock(
                    stdout=json.dumps([self.network_device(**options)]))):
                with self.assertRaises(u.Failure):
                    u.lan_address()
        with patch.object(u, 'run', return_value=Mock(stdout=json.dumps([self.network_device(ip='8.8.8.8')]))):
            with self.assertRaises(u.Failure):
                u.lan_address()

    def test_build_uses_temporary_release_without_host_database_or_certificate_setup(self):
        stages = []
        with patch.object(u.sys, 'argv', ['ubuntu.py', 'build']), patch.object(u.os, 'geteuid', return_value=1000), \
                patch.object(u, 'node_binary') as node, \
                patch.object(u, 'build_release', side_effect=lambda repo, stage: stages.append(stage)), \
                patch.object(u, 'check_ubuntu') as host, patch.object(u, 'root_call') as root, \
                patch.object(u, 'read_source_environment') as environment:
            u.main()
        node.assert_called_once_with(service=False)
        host.assert_not_called()
        root.assert_not_called()
        environment.assert_not_called()
        self.assertEqual(len(stages), 1)
        self.assertFalse(stages[0].exists())

    def test_user_node_is_allowed_for_build_but_not_for_boot_services(self):
        with patch.object(u.shutil, 'which', side_effect=lambda name: '/tmp/user-node/' + name), \
                patch.object(u, 'run', return_value=Mock(stdout='v24.0.0')):
            self.assertEqual(u.node_binary(service=False), '/tmp/user-node/node')
            with self.assertRaisesRegex(u.Failure, 'system-wide'):
                u.node_binary()

    def test_native_host_validation_accepts_ubuntu_quoted_or_unquoted_version(self):
        for release in ('ID=ubuntu\nVERSION_ID="24.04"\n', 'ID="ubuntu"\nVERSION_ID=24.04\n'):
            with self.subTest(release=release), patch.object(u.Path, 'read_text', return_value=release), \
                    patch.object(u.Path, 'is_dir', return_value=True):
                u.check_ubuntu()

    def test_other_os_or_container_has_an_actionable_error_without_hardware_assumptions(self):
        with patch.object(u.Path, 'read_text', return_value='ID=ubuntu\nVERSION_ID="22.04"\n'):
            with self.assertRaisesRegex(u.Failure, 'detected ubuntu 22.04.*SKAO.sh build'):
                u.check_ubuntu()
        with patch.object(u.Path, 'read_text', return_value='ID=ubuntu\nVERSION_ID="24.04"\n'), \
                patch.object(u.Path, 'is_dir', return_value=False):
            with self.assertRaisesRegex(u.Failure, 'systemd'):
                u.check_ubuntu()

    def test_build_refuses_root_before_running_dependency_install_scripts(self):
        with patch.object(u.os, 'geteuid', return_value=0), patch.object(u, 'build_release') as build:
            with self.assertRaisesRegex(u.Failure, 'normal user'):
                u.public_build()
            build.assert_not_called()

    def test_db_validation_never_discloses_url_or_accepts_remote_database(self):
        for url in ['mysql://ska:TOP_SECRET@localhost/db', 'postgresql://ska:TOP_SECRET@example.com/db',
                    'postgresql://ska:TOP_SECRET@localhost/db?host=example.com',
                    'postgresql://ska:TOP_SECRET@localhost:3001/db']:
            with self.subTest(url=url):
                with self.assertRaises(u.Failure) as caught:
                    u.database_settings({'DATABASE_URL': url})
                self.assertNotIn('TOP_SECRET', str(caught.exception))

    def test_preserve_database_and_timezone_force_production_and_same_origin(self):
        env = u.server_environment(self.cfg)
        self.assertEqual(env['DATABASE_URL'], CFG['environment']['DATABASE_URL'])
        self.assertEqual(env['FACILITY_TIME_ZONE'], 'America/Los_Angeles')
        self.assertEqual(env['APP_ORIGINS'], 'https://' + u.DOMAIN)
        self.assertEqual(env['BIND_HOST'], '127.0.0.1')
        self.assertEqual(env['DB_ADAPTER'], 'sequelize')
        self.assertEqual(env['NODE_ENV'], 'production')

    def test_secret_files_are_private_even_with_permissive_umask(self):
        before = os.umask(0)
        try:
            u.secure_write(u.CONF / 'test.env', 'synthetic')
        finally:
            os.umask(before)
        self.assertEqual((u.CONF / 'test.env').stat().st_mode & 0o777, 0o600)

    def test_environment_values_cannot_inject_another_setting(self):
        with self.assertRaises(u.Failure):
            u.environment_file({'DATABASE_URL': 'example\nNODE_ENV=test'})
        self.assertEqual(u.environment_file({'VALUE': 'a"b\\c$`'}), 'VALUE="a\\"b\\\\c\\$\\`"\n')

    def test_backup_uses_environment_for_credentials_and_checks_archive(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == 'pg_dump':
                Path(args[-1]).write_bytes(b'synthetic archive')
            return subprocess.CompletedProcess(args, 0)

        with patch.object(u, 'run', side_effect=fake_run):
            result = u.backup(self.cfg)
        self.assertTrue(result.is_file())
        self.assertEqual(result.stat().st_mode & 0o777, 0o600)
        self.assertEqual([c[0][0] for c in calls], ['pg_dump', 'pg_restore'])
        for args, options in calls:
            self.assertNotIn('synthetic', ' '.join(map(str, args)))
            self.assertEqual(options['env']['PGPASSWORD'], 'synthetic!')
            self.assertTrue(options['quiet'])

    def activation_fixture(self, fail_at=None):
        old = u.ROOT / 'old'
        old.mkdir()
        (u.ROOT / 'current').symlink_to(old)
        new = u.ROOT / 'new'
        new.mkdir()
        events = []

        def operation(label):
            def apply(*args, **kwargs):
                events.append(label)
                if fail_at == label:
                    raise u.Failure('Synthetic failure')
            return apply

        self.contexts.enter_context(patch.object(u, 'systemctl', side_effect=lambda *a, **k: events.append(a)))
        for name in ('backup', 'migrate', 'start_services'):
            self.contexts.enter_context(patch.object(u, name, side_effect=operation(name)))
        return old, new, events

    def test_failed_backup_cannot_migrate_switch_or_start(self):
        old, new, events = self.activation_fixture('backup')
        with self.assertRaises(u.Failure):
            u.activate(self.cfg, new)
        self.assertEqual((u.ROOT / 'current').resolve(), old)
        self.assertNotIn('migrate', events)
        self.assertNotIn('start_services', events)
        self.assertTrue((u.CONF / 'activation.pending').exists())

    def test_failed_migration_keeps_previous_release_and_does_not_stop_lan_dns(self):
        old, new, events = self.activation_fixture('migrate')
        with self.assertRaises(u.Failure):
            u.activate(self.cfg, new)
        self.assertEqual((u.ROOT / 'current').resolve(), old)
        self.assertLess(events.index('backup'), events.index('migrate'))
        self.assertNotIn('start_services', events)
        self.assertEqual(events[0], ('stop', 'skao-web.service', 'skao-api.service'))

    def test_successful_activation_switches_only_after_backup_and_migration(self):
        old, new, events = self.activation_fixture()
        u.activate(self.cfg, new)
        self.assertTrue(old.exists())
        self.assertEqual((u.ROOT / 'current').resolve(), new)
        self.assertFalse((u.CONF / 'activation.pending').exists())
        self.assertLess(events.index('backup'), events.index('migrate'))
        self.assertLess(events.index('migrate'), events.index('start_services'))

    def test_start_refuses_an_incomplete_activation(self):
        (u.CONF / 'activation.pending').write_text('incomplete')
        with patch.object(u, 'systemctl') as ctl, self.assertRaises(u.Failure):
            u.start_services(self.cfg)
        ctl.assert_not_called()

    def test_migrations_drop_root_and_supplementary_groups(self):
        identity = Mock(pw_uid=991, pw_gid=992)
        with patch.object(u.pwd, 'getpwnam', return_value=identity), \
                patch.object(u.subprocess, 'run', return_value=Mock(returncode=0)) as call:
            u.migrate(self.cfg, u.ROOT / 'new')
        args, kwargs = call.call_args
        self.assertEqual(args[0][-1], 'migrate')
        self.assertEqual((kwargs['user'], kwargs['group'], kwargs['extra_groups']), (991, 992, []))
        self.assertNotIn('DATABASE_URL', ' '.join(args[0]))

    def test_existing_service_account_cannot_inherit_privileged_group_membership(self):
        identity = Mock(pw_uid=991, pw_gid=992, pw_shell='/usr/sbin/nologin')
        with patch.object(u.pwd, 'getpwnam', return_value=identity), \
                patch.object(u.grp, 'getgrnam', return_value=Mock(gr_gid=992)), \
                patch.object(u.os, 'getgrouplist', return_value=[992, 27]), \
                self.assertRaises(u.Failure):
            u.create_accounts()

    def test_boot_services_fail_closed_after_interrupted_migration(self):
        for name in ('skao-api.service', 'skao-web.service'):
            self.assertIn('ExecStartPre=/usr/bin/test ! -e /etc/skao/native/activation.pending',
                          (TEMPLATES / name).read_text())

    def test_listener_preflight_rejects_public_db_and_manual_backend(self):
        for output in ['LISTEN 0 128 0.0.0.0:5432 0.0.0.0:*',
                       'LISTEN 0 128 127.0.0.1:3001 0.0.0.0:* users:(("node",pid=124,fd=3))']:
            with patch.object(u, 'run', return_value=Mock(stdout=output)), self.assertRaises(u.Failure):
                u.listener_preflight()

    def test_system_resolver_loopback_does_not_conflict(self):
        for endpoint in ('127.0.0.53:53', '127.0.0.53%lo:53', '127.0.0.54%lo:53',
                         '127.0.0.1:53', '127.0.1.1%lo:53', '[::1]:53', '[::1%lo]:53'):
            for state in ('UNCONN', 'LISTEN'):
                line = f'{state} 0 0 {endpoint} 0.0.0.0:* users:(("systemd-resolve",pid=650,fd=17))'
                with self.subTest(endpoint=endpoint, state=state), \
                        patch.object(u, 'run', return_value=Mock(stdout=line)):
                    u.listener_preflight()

    def test_wildcard_and_lan_dns_conflicts_still_stop_setup(self):
        for endpoint in ('0.0.0.0:53', '0.0.0.0%wlan0:53', '*:53', '[::]:53',
                         '[::%wlan0]:53', '192.168.50.20:53', '192.168.50.20%wlan0:53'):
            line = f'UNCONN 0 0 {endpoint} 0.0.0.0:* users:(("dnsmasq",pid=700,fd=5))'
            with self.subTest(endpoint=endpoint), \
                    patch.object(u, 'run', return_value=Mock(stdout=line)), \
                    self.assertRaises(u.Failure) as caught:
                u.listener_preflight()
            self.assertIn('DNS port 53', str(caught.exception))
            self.assertIn(endpoint, str(caught.exception))
            self.assertNotIn('Vite', str(caught.exception))

    def test_compatible_resolver_does_not_hide_a_real_dns_conflict(self):
        lines = ('UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n'
                 'UNCONN 0 0 0.0.0.0:53 0.0.0.0:*')
        with patch.object(u, 'run', return_value=Mock(stdout=lines)), self.assertRaises(u.Failure):
            u.listener_preflight()

    def test_managed_lan_dns_still_requires_the_service_process(self):
        for pid in ('700', '701'):
            line = f'UNCONN 0 0 192.168.50.20%eth0:53 0.0.0.0:* users:(("dnsmasq",pid={pid},fd=5))'
            with self.subTest(pid=pid), patch.object(u, 'systemctl', return_value=Mock(stdout='700')), \
                    patch.object(u, 'run', return_value=Mock(stdout=line)):
                if pid == '700':
                    u.listener_preflight(self.cfg)
                else:
                    with self.assertRaises(u.Failure):
                        u.listener_preflight(self.cfg)

    def test_repository_failure_stops_before_any_package_install(self):
        events = []

        def failed_update(args, **kwargs):
            events.append(args)
            raise u.Failure('apt-get failed (exit 100); later steps were not run.')

        with patch.object(u, 'check_managed'), patch.object(u, 'listener_preflight'), \
                patch.object(u, 'systemctl'), patch.object(u, 'run', side_effect=failed_update), \
                self.assertRaisesRegex(u.Failure, 'Package indexes were not refreshed'):
            u.packages()
        self.assertEqual(len(events), 1)
        self.assertIn('update', events[0])
        self.assertIn('--error-on=any', events[0])

    def test_package_install_failure_reports_safe_recovery_and_keeps_existing_files(self):
        def failed_install(args, **kwargs):
            if 'install' in args:
                raise u.Failure('apt-get failed (exit 100); later steps were not run.')
            return subprocess.CompletedProcess(args, 0)

        (u.CONF / 'server.env').write_text('original settings')
        with patch.object(u, 'check_managed'), patch.object(u, 'listener_preflight'), \
                patch.object(u, 'systemctl'), patch.object(u, 'run', side_effect=failed_install), \
                self.assertRaises(u.Failure) as caught:
            u.packages()
        self.assertIn('exit 100', str(caught.exception))
        self.assertIn('Do not delete lock files', str(caught.exception))
        self.assertEqual((u.CONF / 'server.env').read_text(), 'original settings')

    def ros_key_fixture(self, *, fingerprint=None, expires=4102444800, download_fails=False, owned=False):
        apt = self.base / 'apt'
        (apt / 'sources.list.d').mkdir(parents=True)
        key = self.base / 'ros-archive-keyring.gpg'
        key.write_bytes(b'original key')
        source = apt / 'sources.list.d/ros2.list'
        source.write_text(f'deb [arch=arm64 signed-by={key}] http://packages.ros.org/ros2/ubuntu noble main\n')
        self.contexts.enter_context(patch.object(u, 'APT_SOURCES', apt))
        self.contexts.enter_context(patch.object(u, 'ROS_KEY', key))
        self.contexts.enter_context(patch.object(u.shutil, 'which', return_value='/synthetic/tool'))

        def fake_run(args, **kwargs):
            if args[0] == 'dpkg-query':
                return subprocess.CompletedProcess(args, 0 if owned else 1, stdout='')
            if args[0] == 'curl':
                if download_fails:
                    raise u.Failure('Synthetic download failure')
                Path(args[-1]).write_bytes(b'refreshed key')
                return subprocess.CompletedProcess(args, 0)
            if args[0] == 'gpg':
                old = Path(args[-1]) == key
                fpr = u.ROS_FINGERPRINT if old else (fingerprint or u.ROS_FINGERPRINT)
                expiry = 100 if old else expires
                return subprocess.CompletedProcess(args, 0, stdout=f'pub:-:4096:1:example:1:{expiry}:::\nfpr:::::::::{fpr}:\n')
            raise AssertionError(f'Unexpected command: {args[0]}')

        calls = self.contexts.enter_context(patch.object(u, 'run', side_effect=fake_run))
        return key, source, calls

    def test_ros_repair_replaces_only_the_verified_key_and_preserves_backup_and_sources(self):
        key, source, calls = self.ros_key_fixture()
        source_before = source.read_bytes()
        u.repair_ros_key()
        self.assertEqual(key.read_bytes(), b'refreshed key')
        self.assertEqual(key.stat().st_mode & 0o777, 0o644)
        backups = list(key.parent.glob(key.name + '.before-skao-*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), b'original key')
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(source.read_bytes(), source_before)
        self.assertNotIn('apt-get', [c.args[0][0] for c in calls.call_args_list])

    def test_ros_repair_rejects_an_unexpected_fingerprint_without_writing(self):
        key, source, calls = self.ros_key_fixture(fingerprint='1234567890')
        with self.assertRaisesRegex(u.Failure, 'fingerprint'):
            u.repair_ros_key()
        self.assertEqual(key.read_bytes(), b'original key')
        self.assertFalse(list(key.parent.glob('*.bak')))

    def test_ros_repair_rejects_an_expired_download_without_writing(self):
        key, source, calls = self.ros_key_fixture(expires=100)
        with self.assertRaisesRegex(u.Failure, 'expired'):
            u.repair_ros_key()
        self.assertEqual(key.read_bytes(), b'original key')
        self.assertFalse(list(key.parent.glob('*.bak')))

    def test_ros_repair_download_failure_preserves_original_key(self):
        key, source, calls = self.ros_key_fixture(download_fails=True)
        with self.assertRaises(u.Failure):
            u.repair_ros_key()
        self.assertEqual(key.read_bytes(), b'original key')
        self.assertFalse(list(key.parent.glob('*.bak')))

    def test_ros_repair_refuses_package_managed_key_before_download(self):
        key, source, calls = self.ros_key_fixture(owned=True)
        with self.assertRaisesRegex(u.Failure, 'package-managed'):
            u.repair_ros_key()
        self.assertEqual(key.read_bytes(), b'original key')
        self.assertEqual([c.args[0][0] for c in calls.call_args_list], ['dpkg-query'])

    def test_ros_repair_refuses_custom_sources_before_download(self):
        key, source, calls = self.ros_key_fixture()
        source.write_text('deb [signed-by=/custom/ros.gpg] http://packages.ros.org/ros2/ubuntu noble main\n')
        with self.assertRaisesRegex(u.Failure, 'different layout'):
            u.repair_ros_key()
        calls.assert_not_called()
        self.assertEqual(key.read_bytes(), b'original key')

    def test_ros_repair_is_idempotent(self):
        key, source, calls = self.ros_key_fixture()
        key.write_bytes(b'refreshed key')
        u.repair_ros_key()
        self.assertFalse(list(key.parent.glob('*.bak')))

    def test_firewall_changes_only_its_own_table_in_one_transaction(self):
        (u.CONF / 'firewall.nft').write_text(u.render((TEMPLATES / 'firewall.nft').read_text(), self.cfg))
        with patch.object(u, 'run', return_value=Mock(returncode=0)) as call:
            u.apply_firewall()
        validate = call.call_args_list[1]
        apply = call.call_args_list[2]
        self.assertEqual(validate.args[0], ['nft', '-c', '-f', '-'])
        self.assertEqual(validate.kwargs['input'], apply.kwargs['input'])
        text = apply.kwargs['input']
        self.assertTrue(text.startswith('delete table inet skao_native\n'))
        self.assertNotIn('flush ruleset', text)
        self.assertIn('tcp dport { 3001, 5432 } drop', text)

    def test_tls_renewal_copies_root_only_key_with_web_group_access(self):
        source = u.CONF / 'acme/live/skao-app'
        source.mkdir(parents=True)
        for name in ('privkey.pem', 'fullchain.pem'):
            (source / name).write_text('synthetic')
        with patch.object(u.pwd, 'getpwnam', return_value=Mock(pw_gid=42)), \
                patch.object(u.os, 'chown'), patch.object(u, 'active', return_value=True), \
                patch.object(u, 'systemctl') as ctl:
            u.install_certificate()
        self.assertEqual((u.CONF / 'tls').stat().st_mode & 0o777, 0o750)
        self.assertEqual((u.CONF / 'tls/privkey.pem').stat().st_mode & 0o777, 0o640)
        ctl.assert_called_once_with('reload', 'skao-web.service')

    def test_renewal_dry_run_does_not_install_untrusted_staging_certificate(self):
        with patch.object(u, 'configuration', return_value=self.cfg), patch.object(u, 'run') as call:
            u.management('renew-test')
        args = call.call_args.args[0]
        self.assertIn('--dry-run', args)
        self.assertNotIn('--run-deploy-hooks', args)
        self.assertIn('--deploy-hook', args)

    def test_release_copy_rejects_outside_symlink(self):
        stage = self.base / 'stage'
        (stage / 'release/server').mkdir(parents=True)
        (stage / 'release/server/bad').symlink_to('/etc/passwd')
        with self.assertRaises(u.Failure):
            u.copy_release(stage, 'abcdef12')

    def test_services_cannot_read_database_or_cloudflare_credentials_as_root(self):
        for name, user in [('skao-api.service', 'skao-api'), ('skao-web.service', 'skao-web'), ('skao-dns.service', 'skao-dns')]:
            unit = u.render((TEMPLATES / name).read_text(), self.cfg)
            self.assertIn('User=' + user, unit)
            self.assertIn('ProtectSystem=strict', unit)
            self.assertNotIn('cloudflare.ini', unit)
        awake = (TEMPLATES / 'skao-awake.service').read_text()
        self.assertIn('--what=sleep:idle', awake)
        self.assertIn('PartOf=skao.target', awake)
        self.assertNotIn('--what=shutdown', awake)


if __name__ == '__main__':
    unittest.main()
