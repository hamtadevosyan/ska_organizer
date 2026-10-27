"""Inspect actual dry-run commands without database access or executing checks."""
import itertools
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'scripts/check-update.sh'


class UpdateCheckSelectionTests(unittest.TestCase):
    def run_check(self, *arguments):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); marker = root / 'must-not-run'
            commands = root / 'commands'; commands.mkdir()
            for name in ('node', 'npm', 'pg_dump', 'pg_restore', 'mktemp', 'tesseract', 'pdfinfo', 'pdftotext', 'pdftoppm', 'pdfimages', 'prlimit', 'python3'):
                command = commands / name
                command.write_text('#!/bin/sh\nprintf called >> "' + str(marker) + '"\nexit 99\n')
                command.chmod(0o700)
            backup = root / 'backup with spaces'
            result = subprocess.run(['bash', str(SCRIPT), *arguments, '--backup-dir', str(backup)],
                                    cwd=root, text=True, capture_output=True, timeout=5,
                                    env={**os.environ, 'PATH': str(commands) + ':' + os.environ['PATH'],
                                         'DATABASE_URL': 'SYNTHETIC-PRIVATE-DO-NOT-READ'})
            self.assertFalse(marker.exists(), 'Dry run or argument rejection executed an external check')
            self.assertFalse(backup.exists(), 'Dry run or argument rejection created a backup directory')
            self.assertNotIn('SYNTHETIC-PRIVATE', result.stdout + result.stderr)
            return result

    def test_ai_selects_real_affected_suites_and_retains_backup_build_and_privacy_steps(self):
        result = self.run_check('--ai', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        for step in ('Database backup: pg_dump', 'pg_restore --list', 'Apply pending database migrations',
                     'Server tests (isolated mock storage)', 'PostgreSQL tests (separate test database)',
                     'Client component tests', 'Client production build', 'Client lint',
                     'Static PWA privacy checks', 'Browser runner tests',
                     'Browser tests (isolated test servers)', 'PWA browser privacy checks (production build)'):
            self.assertIn(step, result.stdout)
        for name in ('localActivityAi.test.js', 'localActivityKnowledge.test.js', 'activityAi.test.js',
                     'activityPlannerGeneration.postgres.test.js', 'workAccess.test.js',
                     'ActivityAiIdeas.test.tsx', 'ActivityAiPlanner.test.tsx', 'Activities.test.tsx', 'ActivityComposer.test.tsx',
                     'WorkAccessGate.test.tsx', 'activity-ai.spec.ts', 'activity-generation.spec.ts',
                     'core-screens.spec.ts'):
            self.assertIn(name, result.stdout)
        for name in ('recipePhotoOcr.test.js', 'tests/payroll.test.js', 'tests/browser/payroll.spec.ts'):
            self.assertNotIn(name, result.stdout)
        for section, output in re.findall(r'  In (server|client): ([^\n]+)', result.stdout):
            for path in re.findall(r'(?:tests|src)/[A-Za-z0-9_./-]+', output):
                self.assertTrue((REPO / section / path).is_file(), path + ' must exist')

    def test_all_focus_modes_remain_mutually_exclusive_before_reading_settings(self):
        for first, second in itertools.combinations(('--inventory', '--access', '--payroll', '--ai', '--billing', '--ccrc'), 2):
            with self.subTest(first=first, second=second):
                result = self.run_check(first, second, '--dry-run')
                self.assertEqual(result.returncode, 2)
                self.assertIn('Choose only one', result.stderr)

    def test_existing_modes_and_default_still_keep_their_scope(self):
        for mode, expected, absent in (
                ('--inventory', 'tests/inventory.test.js', 'tests/workAccess.test.js'),
                ('--access', 'tests/teacherCare.test.js', 'tests/localActivityAi.test.js'),
                ('--payroll', 'tests/payrollRates.test.js', 'tests/localActivityAi.test.js')):
            with self.subTest(mode=mode):
                result = self.run_check(mode, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout); self.assertNotIn(absent, result.stdout)
        result = self.run_check('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('--runTestsByPath', result.stdout)

    def test_ai_postgres_step_includes_the_real_room_fixture_regression(self):
        result = self.run_check('--ai', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        section = result.stdout.split('PostgreSQL tests (separate test database)', 1)[1].split('Client component tests', 1)[0]
        for name in ('tests/localActivityAi.test.js', 'tests/localActivityKnowledge.test.js',
                     'tests/activityAi.test.js', 'tests/activityPlannerGeneration.postgres.test.js',
                     'tests/authenticatedFixture.test.js', 'tests/recipePhoto.test.js',
                     'tests/classroomAccess.test.js', 'tests/authentication.test.js'):
            self.assertIn(name, section)

    def test_billing_selects_persistence_payments_alerts_and_private_ui_checks(self):
        result = self.run_check('--billing', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        postgres = result.stdout.split('PostgreSQL tests (separate test database)', 1)[1].split('Client component tests', 1)[0]
        for name in ('tests/billing.test.js', 'tests/billingMath.test.js', 'tests/billingStorage.test.js',
                     'tests/billingPersistence.postgres.test.js', 'tests/children.test.js', 'tests/workAccess.test.js'):
            self.assertIn(name, postgres)
        for name in ('Billing.test.tsx', 'BillingAlerts.test.tsx', 'tests/browser/billing.spec.ts',
                     'Database backup: pg_dump', 'Apply pending database migrations',
                     'Client production build', 'Static PWA privacy checks',
                     'PWA browser privacy checks (production build)'):
            self.assertIn(name, result.stdout)
        self.assertNotIn('tests/recipePhotoOcr.test.js', result.stdout)
        self.assertNotIn('tests/localActivityAi.test.js', result.stdout)
        for section, output in re.findall(r'  In (server|client): ([^\n]+)', result.stdout):
            for path in re.findall(r'(?:tests|src)/[A-Za-z0-9_./-]+', output):
                self.assertTrue((REPO / section / path).is_file(), path + ' must exist')

    def test_ccrc_selects_extraction_atomic_posting_and_private_source_checks(self):
        result = self.run_check('--ccrc', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        postgres = result.stdout.split('PostgreSQL tests (separate test database)', 1)[1].split('Client component tests', 1)[0]
        for name in ('tests/ccrcStatements.test.js', 'tests/ccrcStatementStorage.test.js',
                     'tests/ccrcStatements.postgres.test.js', 'tests/billingPersistence.postgres.test.js'):
            self.assertIn(name, postgres)
        for name in ('tests/ccrcStatementExtraction.test.js', 'tests/ccrcStatementParser.test.js',
                     'CCRCStatements.test.tsx', 'ccrcStatements.test.ts',
                     'tests/browser/ccrc-statements.spec.ts', 'tests/pwa-browser/ccrc-statement-caching.spec.ts',
                     'Database backup: pg_dump', 'Apply pending database migrations', 'Client production build',
                     'Static PWA privacy checks', 'PWA browser privacy checks (production build)'):
            self.assertIn(name, result.stdout)
        for name in ('tests/localActivityAi.test.js', 'tests/payroll.test.js'):
            self.assertNotIn(name, result.stdout)
        for section, output in re.findall(r'  In (server|client): ([^\n]+)', result.stdout):
            for path in re.findall(r'(?:tests|src)/[A-Za-z0-9_./-]+', output):
                self.assertTrue((REPO / section / path).is_file(), path + ' must exist')


if __name__ == '__main__':
    unittest.main()
