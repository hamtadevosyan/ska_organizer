#!/usr/bin/env bash
# Run after applying an update, with the normal frontend/backend stopped.
# Uses server/.env through the same Node loader as the application, never source/eval.
set -Eeuo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash scripts/check-update.sh [--inventory | --access | --payroll | --ai | --billing | --ccrc] [--dry-run] [--backup-dir DIR]

Back up the configured database, verify the archive, apply pending migrations,
then run server tests, PostgreSQL tests, client tests, build, lint and browser tests.

  --inventory        Run inventory, purchasing and related planner suites.
  --access           Run class access, teacher safety and attendance suites.
  --payroll          Run employee clock, private payroll and related access suites.
  --ai               Run local activity AI, planner and related access suites.
  --billing          Run child tuition, payment, overdue-alert and access suites.
  --ccrc             Run CCRC statement extraction, reviewed posting and privacy suites.
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
access_only=false
payroll_only=false
ai_only=false
billing_only=false
ccrc_only=false
dry_run=false
backup_dir="${HOME}/ska_backups"
while (($#)); do
  case "$1" in
    --inventory) inventory_only=true; shift ;;
    --access) access_only=true; shift ;;
    --payroll) payroll_only=true; shift ;;
    --ai) ai_only=true; shift ;;
    --billing) billing_only=true; shift ;;
    --ccrc) ccrc_only=true; shift ;;
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

selected_modes=0
for selection in "$inventory_only" "$access_only" "$payroll_only" "$ai_only" "$billing_only" "$ccrc_only"; do
  if "$selection"; then ((selected_modes+=1)); fi
done
if ((selected_modes > 1)); then
  printf 'Choose only one of --inventory, --access, --payroll, --ai, --billing or --ccrc.\n' >&2
  exit 2
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
server_tests=(npm test)
postgres_tests=(npm run test:postgres)
client_tests=(npm test)
browser_tests=(npm run test:browser)
if "$inventory_only"; then
  server_tests+=(-- --runTestsByPath tests/inventory.test.js tests/inventoryGroups.test.js tests/inventoryGroupRemoval.test.js tests/inventoryGroupPersistence.test.js tests/inventoryLifecyclePlanning.test.js tests/inventoryStock.test.js tests/purchasing.test.js tests/purchasingListCalculation.test.js tests/purchasingListApi.test.js tests/purchasingPersistence.test.js tests/batchPurchases.test.js tests/batchPurchasePersistence.test.js tests/weeklyPlans.test.js tests/catalogCorrections.test.js)
  postgres_tests+=(-- --runTestsByPath tests/inventory.test.js tests/inventory.postgres.test.js tests/inventoryGroups.test.js tests/inventoryGroups.postgres.test.js tests/inventoryGroupRemoval.test.js tests/inventoryGroupPersistence.test.js tests/inventoryGroupLifecycle.postgres.test.js tests/inventoryLifecyclePlanning.test.js tests/inventoryStock.test.js tests/purchasing.test.js tests/purchasing.postgres.test.js tests/purchasingListCalculation.test.js tests/purchasingListApi.test.js tests/purchasingPersistence.test.js tests/purchasingLists.postgres.test.js tests/batchPurchases.test.js tests/batchPurchasePersistence.test.js tests/batchPurchases.postgres.test.js tests/weeklyPlans.test.js tests/catalogCorrections.test.js)
  client_tests+=(-- src/pages/Inventory.test.tsx src/components/inventory/InventoryGroupRemoval.test.tsx src/pages/InventoryGroupOperation.test.tsx src/pages/Purchasing.test.tsx src/pages/Receiving.test.tsx src/components/inventory/PurchasingReceiptProgress.test.tsx src/components/inventory/Purchasing.test.tsx src/components/meals/MealPlanner.test.tsx)
  browser_tests+=(-- tests/browser/inventory.spec.ts tests/browser/inventory-group-removal.spec.ts tests/browser/purchasing.spec.ts tests/browser/purchasing-list.spec.ts tests/browser/batch-receiving.spec.ts tests/browser/weekly-plans.spec.ts tests/browser/catalog-corrections.spec.ts)
fi
if "$access_only"; then
  server_tests+=(-- --runTestsByPath tests/authentication.test.js tests/rememberedSessions.test.js tests/accountClassAccess.test.js tests/classroomAccess.test.js tests/teacherCare.test.js tests/staffAccountAccess.test.js tests/staff.test.js)
  postgres_tests+=(-- --runTestsByPath tests/authentication.test.js tests/rememberedSessions.test.js tests/accountClassAccess.test.js tests/classroomAccess.test.js tests/classAccountScope.postgres.test.js tests/teacherCare.test.js tests/teacherCare.postgres.test.js tests/authenticationPersistence.postgres.test.js tests/staffAccountAccess.test.js tests/staffAccountLinks.postgres.test.js tests/staff.test.js)
  client_tests+=(-- src/auth/AuthFlow.test.tsx src/auth/transport.test.ts src/components/AppShell.test.tsx src/pages/Accounts.test.tsx src/pages/Staff.test.tsx src/components/staff/StaffAccountAccess.test.tsx src/pages/Classroom.test.tsx src/pages/TeacherCare.test.tsx src/components/children/ChildSafetyCard.test.tsx src/router/index.test.tsx)
  browser_tests+=(-- tests/browser/classroom-access.spec.ts tests/browser/teacher-care.spec.ts tests/browser/staff-account-links.spec.ts tests/browser/authentication.spec.ts tests/browser/remembered-login.spec.ts)
fi

if "$payroll_only"; then
  server_tests+=(-- --runTestsByPath tests/payroll.test.js tests/payrollRates.test.js tests/workAccess.test.js tests/payrollReview.test.js tests/payrollPolicy.test.js tests/payrollMath.test.js tests/payrollLocalCheckout.test.js tests/clockStations.test.js tests/staffAccountAccess.test.js tests/authentication.test.js)
  postgres_tests+=(-- --runTestsByPath tests/payroll.test.js tests/payrollRates.test.js tests/workAccess.test.js tests/payrollReview.test.js tests/payrollPolicy.test.js tests/payrollMath.test.js tests/payrollLocalCheckout.test.js tests/clockStations.test.js tests/clockStations.postgres.test.js tests/payroll.postgres.test.js tests/childDocuments.postgres.test.js tests/staffAccountLinks.postgres.test.js tests/staffAccountAccess.test.js)
  client_tests+=(-- src/App.test.tsx src/auth/AuthFlow.test.tsx src/auth/WorkAccessGate.test.tsx src/auth/transport.test.ts src/pages/MyTime.test.tsx src/pages/TimeClockStation.test.tsx src/components/staff/StaffClock.test.tsx src/components/staff/ClockStationSetup.test.tsx src/pages/Payroll.test.tsx src/components/payroll/ClockSessions.test.tsx src/components/payroll/RateAllocationFields.test.tsx src/pages/WorkTime.test.tsx src/pages/Classroom.test.tsx src/pages/TeacherCare.test.tsx src/pages/Dashboard.test.tsx src/components/AppShell.test.tsx src/router/index.test.tsx)
  browser_tests+=(-- tests/browser/payroll.spec.ts tests/browser/clock-station.spec.ts tests/browser/employee-work-access.spec.ts tests/browser/staff-account-links.spec.ts tests/browser/classroom-access.spec.ts tests/browser/teacher-care.spec.ts)
fi

if "$ai_only"; then
  server_tests+=(-- --runTestsByPath tests/authenticatedFixture.test.js tests/recipePhoto.test.js tests/classroomAccess.test.js tests/localActivityAi.test.js tests/localActivityKnowledge.test.js tests/activityAi.test.js tests/activityPlannerGeneration.test.js tests/activityPlanner.test.js tests/authentication.test.js tests/workAccess.test.js)
  postgres_tests+=(-- --runTestsByPath tests/authenticatedFixture.test.js tests/recipePhoto.test.js tests/classroomAccess.test.js tests/authentication.test.js tests/localActivityAi.test.js tests/localActivityKnowledge.test.js tests/activityAi.test.js tests/activityPlannerGeneration.test.js tests/activityPlannerGeneration.postgres.test.js tests/workAccess.test.js)
  client_tests+=(-- src/components/activities/ActivityAiIdeas.test.tsx src/pages/ActivityAiPlanner.test.tsx src/pages/Activities.test.tsx src/components/activities/ActivityComposer.test.tsx src/components/activities/ActivityGenerate.test.tsx src/auth/WorkAccessGate.test.tsx src/auth/transport.test.ts)
  browser_tests+=(-- tests/browser/activity-ai.spec.ts tests/browser/activity-generation.spec.ts tests/browser/core-screens.spec.ts)
fi

if "$billing_only"; then
  server_tests+=(-- --runTestsByPath tests/billing.test.js tests/billingMath.test.js tests/billingStorage.test.js tests/children.test.js tests/workAccess.test.js)
  postgres_tests+=(-- --runTestsByPath tests/billing.test.js tests/billingMath.test.js tests/billingStorage.test.js tests/billingPersistence.postgres.test.js tests/children.test.js tests/workAccess.test.js)
  client_tests+=(-- src/pages/Billing.test.tsx src/api/billing.test.ts src/components/billing/BillingAlerts.test.tsx src/pages/Children.test.tsx src/components/AppShell.test.tsx src/router/index.test.tsx src/pages/Dashboard.test.tsx src/auth/WorkAccessGate.test.tsx)
  browser_tests+=(-- tests/browser/billing.spec.ts)
fi

if "$ccrc_only"; then
  server_tests+=(-- --runTestsByPath tests/ccrcStatements.test.js tests/ccrcStatementExtraction.test.js tests/ccrcStatementParser.test.js tests/ccrcStatementStorage.test.js tests/billing.test.js tests/billingMath.test.js tests/workAccess.test.js)
  postgres_tests+=(-- --runTestsByPath tests/ccrcStatements.test.js tests/ccrcStatementStorage.test.js tests/ccrcStatements.postgres.test.js tests/billing.test.js tests/billingMath.test.js tests/billingPersistence.postgres.test.js tests/workAccess.test.js)
  client_tests+=(-- src/pages/CCRCStatements.test.tsx src/pages/CCRCStatements.navigation.test.tsx src/api/ccrcStatements.test.ts src/components/billing/ccrcStatementReview.test.ts src/pages/Billing.test.tsx src/components/billing/BillingAlerts.test.tsx src/router/index.test.tsx src/auth/WorkAccessGate.test.tsx)
  browser_tests+=(-- tests/browser/ccrc-statements.spec.ts tests/browser/billing.spec.ts)
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
  if ! "$inventory_only" && ! "$access_only" && ! "$payroll_only" && ! "$ai_only"; then
    if ! command -v tesseract >/dev/null 2>&1 || ! tesseract --list-langs 2>/dev/null | grep -qx 'eng'; then
      if "$ccrc_only" || ((selected_modes == 0)); then
        printf '%s\n' 'Local statement OCR with English data is required. Run: bash scripts/setup-ccrc-ocr.sh' >&2
      else
        printf '%s\n' 'Local recipe OCR is required by the photo-import checks. Run: bash scripts/setup-recipe-ocr.sh' >&2
      fi
      exit 1
    fi
  fi
  if "$ccrc_only" || ((selected_modes == 0)); then
    for tool in pdfinfo pdftotext pdftoppm pdfimages prlimit python3; do
      if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Local statement reading needs %s. Run: bash scripts/setup-ccrc-ocr.sh\n' "$tool" >&2
        exit 1
      fi
    done
    if ! python3 -c 'from PIL import Image, ImageOps' >/dev/null 2>&1; then
      printf '%s\n' 'Local photo orientation support is missing. Run: bash scripts/setup-ccrc-ocr.sh' >&2
      exit 1
    fi
  fi
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
run_in 'Static PWA privacy checks' client npm run test:pwa
run_in 'Browser runner tests' client npm run test:browser:runner
run_in 'Browser tests (isolated test servers)' client env NODE_ENV=test "${browser_tests[@]}"
if ! "$inventory_only"; then
  pwa_browser_tests=(npm run test:browser:pwa)
  if "$access_only"; then pwa_browser_tests+=(-- tests/pwa-browser/teacher-safety-caching.spec.ts); fi
  if "$payroll_only"; then pwa_browser_tests+=(-- tests/pwa-browser/payroll-caching.spec.ts tests/pwa-browser/clock-station-caching.spec.ts tests/pwa-browser/employee-work-access-caching.spec.ts tests/pwa-browser/teacher-safety-caching.spec.ts); fi
  if "$ccrc_only"; then pwa_browser_tests+=(-- tests/pwa-browser/ccrc-statement-caching.spec.ts tests/pwa-browser/billing-caching.spec.ts); fi
  run_in 'PWA browser privacy checks (production build)' client env NODE_ENV=test "${pwa_browser_tests[@]}"
fi

if "$dry_run"; then
  printf '\nDry run complete. Run again without --dry-run to execute these steps.\n'
else
  printf '\nBackup, migrations and all selected checks completed successfully.\n'
  printf 'Backup retained: %s\n' "$backup_file"
  printf 'You can now start the app normally for manual testing.\n'
fi
