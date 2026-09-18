#!/usr/bin/env bash
# Run after applying an update, with the normal frontend/backend stopped.
# Uses server/.env through the same Node loader as the application, never source/eval.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash scripts/check-update.sh [--inventory] [--dry-run] [--backup-dir DIR]

Back up the configured database, verify the archive, apply pending migrations,
then run server tests, PostgreSQL tests, client tests, build, lint and browser tests.

  --inventory        Run inventory, purchasing and related planner suites.
  --dry-run          Print the steps without reading credentials or running them.
  --backup-dir DIR   Backup directory (default: ~/ska_backups).
  --help             Show this help.

Run as your normal Ubuntu user, after stopping the regular client/server terminals.
Install project dependencies and Playwright Chromium before the first real run.
Each run creates a fresh backup. Failures stop the script; no automatic rollback,
Git changes, dependency installation, seeding or database reset is performed.
HELP
}

inventory_only=false
dry_run=false
backup_dir="${HOME}/ska_backups"
while (($#)); do
  case "$1" in
    --inventory) inventory_only=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    --backup-dir)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
        printf 'Provide a directory after --backup-dir.\n' >&2; exit 2
      fi
      backup_dir="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
server_tests=(npm test)
postgres_tests=(npm run test:postgres)
client_tests=(npm test)
browser_tests=(npm run test:browser)
if "$inventory_only"; then
  server_tests+=(-- --runTestsByPath tests/inventory.test.js tests/inventoryGroups.test.js tests/inventoryStock.test.js tests/purchasing.test.js tests/weeklyPlans.test.js tests/catalogCorrections.test.js)
  postgres_tests+=(-- --runTestsByPath tests/inventory.test.js tests/inventory.postgres.test.js tests/inventoryGroups.test.js tests/inventoryGroups.postgres.test.js tests/inventoryStock.test.js tests/purchasing.test.js tests/purchasing.postgres.test.js tests/weeklyPlans.test.js tests/catalogCorrections.test.js)
  client_tests+=(-- src/pages/Inventory.test.tsx src/components/inventory/Purchasing.test.tsx src/components/meals/MealPlanner.test.tsx)
  browser_tests+=(-- tests/browser/inventory.spec.ts tests/browser/purchasing.spec.ts tests/browser/weekly-plans.spec.ts tests/browser/catalog-corrections.spec.ts)
fi

current_step='Preflight'
backup_partial=''
backup_file=''
finish() {
  local status=$?
  trap - EXIT
  if [[ -n "$backup_partial" && -f "$backup_partial" ]]; then
    rm -f -- "$backup_partial"
  fi
  if ((status != 0)); then
    printf '\nStopped during: %s (exit %s). Later steps were not run.\n' "$current_step" "$status" >&2
    if [[ -n "$backup_file" ]]; then printf 'Backup retained: %s\n' "$backup_file" >&2; fi
    printf 'Fix the reported error and rerun this command. No automatic rollback was attempted.\n' >&2
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_in() {
  local label=$1 directory=$2
  shift 2
  current_step="$label"
  printf '\n%s\n' "$label"
  if "$dry_run"; then
    printf '  In %s: ' "$directory"
    printf '%q ' "$@"
    printf '\n'
  else
    (cd -- "$project_dir/$directory"; "$@")
  fi
}

# The Node subprocess keeps the URL password out of shell evaluation and argv.
# An encoded password such as %25 or %2F is decoded once for PostgreSQL.
database_step() {
  NODE_ENV=development node - "$project_dir" "$1" "${2:-}" <<'NODE'
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [root, action, destination] = process.argv.slice(2);
let live;
try {
  if (typeof process.loadEnvFile !== 'function') throw new Error('unsupported Node');
  require(path.join(root, 'server/config/environment.js'));
  const { validateDatabaseUrl } = require(path.join(root, 'server/database/connection.js'));
  live = validateDatabaseUrl(process.env.DATABASE_URL);
  const test = validateDatabaseUrl(process.env.TEST_DATABASE_URL);
  const liveName = decodeURIComponent(live.pathname.slice(1));
  const testName = decodeURIComponent(test.pathname.slice(1));
  // Require different names even if the URLs use different aliases for one host.
  if (!testName.endsWith('_test') || liveName === testName) {
    console.error('TEST_DATABASE_URL must use a separate database ending in _test, different from DATABASE_URL.');
    process.exit(1);
  }
  if (live.searchParams.has('dbname') || test.searchParams.has('dbname') || live.searchParams.has('sslpassword')) {
    console.error('Use the URL path for the database name. This helper does not support dbname or sslpassword URL options.');
    process.exit(1);
  }
  // Check decoding before any migration or dump is attempted.
  decodeURIComponent(live.password);
} catch {
  console.error('Check server/.env, installed server dependencies, and Node 20.19+ (22 or 24 supported). Both database URLs must be valid PostgreSQL URLs.');
  process.exit(1);
}
if (action === 'check') {
  console.log('Database settings checked; the application and test database names differ.');
  process.exit(0);
}
const password = live.searchParams.get('password') ?? decodeURIComponent(live.password);
live.password = '';
live.searchParams.delete('password');
const dump = spawnSync('pg_dump', ['--dbname', live.toString(), '--no-password', '--format=custom', '--file', destination], {
  stdio: 'inherit', env: { ...process.env, PGPASSWORD: password },
});
if (dump.error) console.error('Could not start pg_dump. Check your PostgreSQL client installation.');
process.exit(dump.status ?? 1);
NODE
}

if "$dry_run"; then
  printf 'Dry run: no settings read, backup created, migration applied or tests executed.\n'
  printf 'Backup destination: %s (unique, dated .dump file)\n' "$backup_dir"
  printf '\nPreflight: tools, dependencies and separate application/test database settings.\n'
  printf 'Database backup: pg_dump in custom format, then pg_restore --list to check the archive.\n'
else
  for tool in node npm pg_dump pg_restore mktemp; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'Required command is missing: %s\n' "$tool" >&2
      exit 1
    fi
  done
  for directory in client server; do
    if [[ ! -f "$project_dir/$directory/package.json" || ! -d "$project_dir/$directory/node_modules" ]]; then
      printf 'Install the %s dependencies first: cd %q && npm ci\n' "$directory" "$project_dir/$directory" >&2
      exit 1
    fi
  done
  printf 'Checking update prerequisites. Run with the normal client/server stopped.\n'
  database_step check
  current_step='Database backup'
  mkdir -p -- "$backup_dir"
  backup_dir="$(cd -- "$backup_dir" && pwd -P)"
  backup_partial="$(mktemp "$backup_dir/ska_organizer-before-update-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump.partial")"
  printf '\nBacking up the database configured in server/.env...\n'
  database_step backup "$backup_partial"
  current_step='Backup archive verification'
  pg_restore --list "$backup_partial" >/dev/null
  backup_file="${backup_partial%.partial}"
  mv -- "$backup_partial" "$backup_file"
  backup_partial=''
  printf 'Backup saved: %s\n' "$backup_file"
fi

run_in 'Apply pending database migrations' server env NODE_ENV=development npm run db:migrate
run_in 'Server tests (isolated mock storage)' server env NODE_ENV=test DB_ADAPTER=mock "${server_tests[@]}"
run_in 'PostgreSQL tests (separate test database)' server env NODE_ENV=development "${postgres_tests[@]}"
run_in 'Client component tests' client env NODE_ENV=test "${client_tests[@]}"
run_in 'Client production build' client env NODE_ENV=production npm run build
run_in 'Client lint' client npm run lint
run_in 'Browser tests (isolated test servers)' client env NODE_ENV=test "${browser_tests[@]}"

if "$dry_run"; then
  printf '\nDry run complete. Run again without --dry-run to execute these steps.\n'
else
  printf '\nBackup, migrations and all selected checks completed successfully.\n'
  printf 'Backup retained: %s\n' "$backup_file"
  printf 'You can now start the app normally for manual testing.\n'
fi
