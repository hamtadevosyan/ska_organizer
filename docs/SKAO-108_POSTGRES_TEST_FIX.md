# SKAO-108 — PostgreSQL test follow-up

Apply this **after the SKAO-108 menu-generation update** in the Ubuntu development
checkout. It corrects the reported shelf/persistence fixture assertions and makes
permission tests and test database waits easier to diagnose.

## What changed

- Shelf and restart checks identify Oats/Eggs by ingredient ID. Added complete
  recipes can change shopping-row order; PostgreSQL JSONB can also reorder menu
  keys. Exact required, stocked and purchase quantities are still checked. A
  regression explicitly reverses menu keys.
- Each editor/viewer and legacy-grant combination is a separate permission test
  with a real sign-in. All denial, stale-account and operational-access checks
  remain. Test HTTP calls and fixture sign-in have 15-second response and
  20-second total deadlines.
- `npm run test:postgres` gives its child test connections a 10-second lock wait,
  15-second statement limit and 20-second idle-transaction limit. Existing
  `PGOPTIONS` are preserved before these test limits. URL query parameters that
  would override them are rejected with an actionable message. These are session
  settings for the test subprocess; the app and PostgreSQL server configuration
  are not changed.
- Setup failures print the fixture step and SQLSTATE, when available, without
  printing connection strings or SQL. New native tests check effective limits,
  lock cancellation, rollback and subsequent usable queries.

The original log does not show the underlying database error. The permission
test packed four expensive sign-ins into one 30-second body, but the 12,398-second
suite duration could also involve a paused VM or resource pressure. This patch
addresses the fixture timing and prevents ordinary unbounded SQL waits; native
verification is needed to establish whether the original stall is resolved.

No application data migration, dependency or authorization changes are included.

## 1. Stay on the correct feature branch

Stop the normal server/client. Unzip `SKAO-108-postgres-test-fix.zip` into Downloads.
If you are already working on `feature/SKAO-108-menu-generation` or `SKAO-108`,
keep that branch and apply below. The script preserves unrelated local work.

```bash
cd ~/workspace/ska_organizer
git branch --show-current
git status --short
bash ~/Downloads/SKAO-108-postgres-test-fix/apply-fix.sh
```

If SKAO-108 has **already been merged** and you need a separate follow-up branch,
use this block first. It stops on local changes rather than discarding them:

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Stop: keep or commit local changes before switching branches.' >&2
  git status --short
  exit 1
fi
git fetch origin
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-108-postgres-test-fix
BASH
```

Then run the apply command above. A mismatch stops before any file is written.
Do not force the patch or reset local work.

## 2. Run the checks

Keep the existing application database and separate `_test` database settings.
No reset, reinstallation or permanent PostgreSQL setting is required.
If `TEST_DATABASE_URL` contains an `options`, `statement_timeout`, `lock_timeout`
or `idle_in_transaction_session_timeout` query parameter, remove that parameter
from the **test URL only**. Other startup options can be supplied through
`PGOPTIONS`; the runner appends its wait limits to the child environment.

You can first rerun the affected PostgreSQL suites from the repository root:

```bash
cd ~/workspace/ska_organizer
(cd server && npm run test:postgres -- --runTestsByPath tests/childDocumentAccess.test.js tests/persistence.postgres.test.js tests/shelf.test.js tests/testDatabaseLimits.postgres.test.js)
```

Then run your normal complete check with the server/client stopped:

```bash
bash scripts/check-update.sh
```

The complete script retains a fresh backup before migrations and stops on a
failure. Keep the previously retained backup. A future setup error now names its
step and SQLSTATE; save the full output if it fails again. Native PostgreSQL
checks have not been executed in this delivery environment.

## 3. Commit on Ubuntu after checks pass

If the original SKAO-108 work is still uncommitted, keep its original package
unpacked at `~/Downloads/SKAO-108-menu-generation`. The block below stages both
lists when that package is present, using the same branch guard. Otherwise it
stages this follow-up list only:

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
case "$(git branch --show-current)" in
  feature/SKAO-108-menu-generation|feature/SKAO-108-postgres-test-fix|SKAO-108) ;;
  *) printf '%s\n' 'Stop: switch to the SKAO-108 feature branch before staging.' >&2; exit 1 ;;
esac
lists=(~/Downloads/SKAO-108-postgres-test-fix/FILES.txt)
if [[ -f ~/Downloads/SKAO-108-menu-generation/FILES.txt ]]; then
  lists=(~/Downloads/SKAO-108-menu-generation/FILES.txt "${lists[@]}")
fi
for list in "${lists[@]}"; do
  while IFS= read -r file || [[ -n "$file" ]]; do
    [[ -z "$file" ]] || git add -- "$file"
  done < "$list"
done
git diff --cached --stat
BASH
```

Review the staged diff, then commit and push your current branch:

```bash
git diff --cached
git commit -m "SKAO-108 fix PostgreSQL test fixtures and bound test waits"
git push -u origin HEAD
```

Use **development** as the pull-request base. Merge after the full check and CI
pass. On the Pi, pull the merged development branch and run `bash SKAO.sh update`
using your existing deployment workflow.

## Verification

- All 710 server tests passed across 46 suites using mock storage. This includes
  all authorization cases, exact shelf arithmetic, reordered menu keys, menu
  generation and the test-runner isolation/exit-status checks.
- Syntax, whitespace and patch safety checks passed. Wrong-branch and conflicting
  file tests preserved every file; successful application matched all supplied
  files, preserved unrelated work, and a repeat application made no changes.

Native PostgreSQL and physical-device verification remain pending. No frontend
runtime files changed in this follow-up.
