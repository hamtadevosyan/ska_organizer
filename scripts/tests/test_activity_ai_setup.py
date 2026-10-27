"""Read-only AI diagnostics and installer configuration tests with synthetic data."""
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('ubuntu_ai', REPO / 'scripts/ubuntu.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class ActivityAiEnvironmentTests(unittest.TestCase):
    def test_no_settings_preserves_existing_installed_configuration(self):
        old = {'DATABASE_URL': 'synthetic-private-database', 'FACILITY_TIME_ZONE': 'America/Los_Angeles',
               'SKAO_AI_MODEL': 'reviewed-model:v1', 'SKAO_AI_TIMEOUT_MS': '60000'}
        self.assertEqual(u.merge_activity_ai_environment(old, {}), old)
        updated = u.merge_activity_ai_environment(old, {'SKAO_AI_MODEL': 'reviewed-model:v2',
                                                       'DATABASE_URL': 'must-not-replace', 'NODE_ENV': 'test'})
        self.assertEqual(updated, {**old, 'SKAO_AI_MODEL': 'reviewed-model:v2'})
        self.assertEqual(old['SKAO_AI_MODEL'], 'reviewed-model:v1')

    def test_explicit_empty_model_disables_ai_without_resetting_other_settings(self):
        old = {'DATABASE_URL': 'synthetic', 'SKAO_AI_MODEL': 'reviewed-model:v1',
               'SKAO_AI_SOURCES_FILE': '/etc/skao/ai/references.json'}
        self.assertEqual(u.merge_activity_ai_environment(old, {'SKAO_AI_MODEL': ''}),
                         {**old, 'SKAO_AI_MODEL': ''})

    def test_only_literal_loopback_runtime_and_bounded_local_model_settings_are_accepted(self):
        for url in ('http://127.0.0.1:11434', 'http://[::1]:11434/'):
            values = {'SKAO_AI_URL': url, 'SKAO_AI_MODEL': 'local/model:v1',
                      'SKAO_AI_TIMEOUT_MS': '300000', 'SKAO_AI_SOURCES_FILE': '/etc/skao/ai/references.json'}
            self.assertEqual(u.activity_ai_environment(values), values)
        invalid = [('SKAO_AI_MODEL', 'model:cloud'), ('SKAO_AI_MODEL', 'remote-model'),
                   ('SKAO_AI_MODEL', 'http://example.test/model'), ('SKAO_AI_MODEL', 'a' * 129),
                   ('SKAO_AI_MODEL', 'model:v1:extra'), ('SKAO_AI_MODEL', 'model\nSECRET=private'),
                   ('SKAO_AI_URL', 'http://localhost:11434'), ('SKAO_AI_URL', 'https://127.0.0.1:11434'),
                   ('SKAO_AI_URL', 'http://192.168.1.2:11434'), ('SKAO_AI_URL', 'http://127.0.0.1:11434/api'),
                   ('SKAO_AI_URL', 'http://secret:password@127.0.0.1:11434'),
                   ('SKAO_AI_URL', 'http://127.0.0.1:11434/?secret=private'),
                   ('SKAO_AI_TIMEOUT_MS', '999'), ('SKAO_AI_TIMEOUT_MS', '300001'),
                   ('SKAO_AI_TIMEOUT_MS', '1.5'), ('SKAO_AI_TIMEOUT_MS', 'NaN')]
        for key, value in invalid:
            with self.subTest(key=key, value=value):
                with self.assertRaises(u.Failure) as caught:
                    u.activity_ai_environment({key: value})
                self.assertNotIn('password', str(caught.exception))
                self.assertNotIn('SECRET', str(caught.exception))

    def test_private_ai_host_requires_https_opt_in_and_token(self):
        values = {'SKAO_AI_URL': 'https://192.168.1.50:8443', 'SKAO_AI_LAN': '1',
                  'SKAO_AI_TOKEN': 'x' * 48, 'SKAO_AI_CA_FILE': '/etc/skao/ai/ca.pem'}
        self.assertEqual(u.activity_ai_environment(values), values)
        for changes in ({'SKAO_AI_LAN': '0'}, {'SKAO_AI_TOKEN': ''}, {'SKAO_AI_URL': 'http://192.168.1.50'},
                        {'SKAO_AI_URL': 'https://8.8.8.8'}, {'SKAO_AI_URL': 'https://ai.example.test'},
                        {'SKAO_AI_CA_FILE': '/home/user/private.pem'}):
            with self.subTest(changes=changes), self.assertRaises(u.Failure):
                u.activity_ai_environment({**values, **changes})
        old = {'DATABASE_URL': 'private', **values}
        self.assertEqual(u.merge_activity_ai_environment(old, {'SKAO_AI_MODEL': 'local:v2'}),
                         {**old, 'SKAO_AI_MODEL': 'local:v2'})
        self.assertEqual(u.merge_activity_ai_environment(old, {'SKAO_AI_URL': 'https://192.168.1.60'}),
                         {**old, 'SKAO_AI_URL': 'https://192.168.1.60'})

    def test_native_source_path_stays_outside_home_checkout_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / 'checkout'; repo.mkdir()
            link = Path(directory) / 'linked-home'; link.symlink_to('/home')
            for path in ('references.json', '/root/references.json', '/home/user/references.json',
                         '/run/user/1000/references.json', '/opt/skao/current/references.json',
                         str(repo / 'references.json'), str(link / 'references.json')):
                with self.subTest(path=path), self.assertRaises(u.Failure):
                    u.activity_ai_environment({'SKAO_AI_SOURCES_FILE': path}, repo=repo)

    def test_source_dotenv_parser_does_not_source_shell_or_copy_database_changes_during_update(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory); (repo / 'server').mkdir()
            self.assertEqual(u.read_activity_ai_environment(repo, node), {})
            (repo / 'server/.env').write_text('DATABASE_URL=postgresql://ska:synthetic@127.0.0.1/app\n'
                                            'SKAO_AI_MODEL=local-model:v1\nSKAO_AI_TIMEOUT_MS="120000"\n'
                                            'SKAO_AI_SOURCES_FILE=/etc/skao/ai/references.json\n')
            self.assertEqual(u.read_activity_ai_environment(repo, node), {
                'SKAO_AI_MODEL': 'local-model:v1', 'SKAO_AI_TIMEOUT_MS': '120000',
                'SKAO_AI_SOURCES_FILE': '/etc/skao/ai/references.json'})
            self.assertEqual(u.read_source_environment(repo, node)['SKAO_AI_MODEL'], 'local-model:v1')


class ActivityAiDiagnosticTests(unittest.TestCase):
    def run_check(self, body, *args):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            for name in ('scripts', 'server/scripts', 'server/services', 'server/config'):
                (repo / name).mkdir(parents=True, exist_ok=True)
            for name in ('SKAO.sh', 'scripts/activity-ai-check.sh', 'server/scripts/check-activity-ai.js'):
                shutil.copyfile(REPO / name, repo / name)
            (repo / 'server/config/environment.js').write_text('// synthetic environment only\n')
            (repo / 'server/services/localActivityAi.js').write_text(body)
            before = sorted(str(path.relative_to(repo)) for path in repo.rglob('*'))
            result = subprocess.run(['bash', str(repo / 'SKAO.sh'), 'ai-check', *args],
                                    text=True, capture_output=True, timeout=10, cwd='/')
            self.assertEqual(sorted(str(path.relative_to(repo)) for path in repo.rglob('*')), before)
            return result

    def test_actual_root_command_calls_only_status_and_never_installs_or_loads_a_model(self):
        result = self.run_check('exports.status=async()=>({enabled:true,available:true,model:"local:v1",'
                                'sourceCount:2,message:"Ready for reviewed activity drafts."});\n'
                                'exports.generate=()=>{throw Error("must not run")};\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Local activity AI: ready', result.stdout)
        self.assertIn('Configured model: local:v1', result.stdout)
        self.assertIn('Reviewed reference excerpts: 2', result.stdout)
        self.assertRegex(result.stdout, r'Host: [a-z0-9_]+, [0-9]+ logical CPUs')
        self.assertRegex(result.stdout, r'Memory: [0-9.]+ GiB total, [0-9.]+ GiB free')

    def test_unconfigured_runtime_gives_an_actionable_message_without_sudo(self):
        result = self.run_check('exports.status=async()=>({enabled:false,available:false,model:null,sourceCount:0,message:"Choose a local model."});')
        self.assertEqual(result.returncode, 1)
        self.assertIn('not configured', result.stdout)
        self.assertIn('OLLAMA_NO_CLOUD=1', result.stdout)
        self.assertIn('does not install software', result.stdout)

    def test_private_exception_details_are_not_printed(self):
        result = self.run_check('exports.status=async()=>{throw Error("SYNTHETIC_PRIVATE_SECRET /private/path")};')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('SYNTHETIC_PRIVATE_SECRET', result.stdout + result.stderr)
        self.assertNotIn('/private/path', result.stdout + result.stderr)

    def test_extra_arguments_cannot_change_the_runtime_or_execute_another_command(self):
        result = self.run_check('throw Error("status must not be required")', '--install')
        self.assertEqual(result.returncode, 2)
        self.assertIn('Usage:', result.stderr)


if __name__ == '__main__':
    unittest.main()
