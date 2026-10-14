# SKAO-108 — use real child and staff totals for meal planning

New weeks now start with active child enrollment and active staff-directory
totals. The system counts all pages, including unassigned people. Inactive
records are excluded; sign-in accounts do not add to the employee total.

**For an existing week still showing 20 children and 5 staff, choose Use current
roster counts.** Review the new shopping quantities and Save Menu. This action
changes the two weekly fields in an unsaved draft. The previous saved week stays
intact until Save succeeds.

Manual planned counts and daily attendance overrides remain available. Generating
again preserves those choices. The existing Review today’s attendance count
control lets you apply checked-in children to today's date. Roster totals are
weekly planning defaults, not today's attendance or a future attendance forecast.

A counts request that fails provides retry guidance and keeps the prior draft.
A late response cannot overwrite edits or a different week. New empty rosters
show zero children/zero staff; add active records or enter planned counts with a
positive combined total before calculating and saving. No assumed fallback is
used. Older undated shopping and import paths also use live totals when counts
are omitted, and imports respect the counts chosen in the planner.

## 1. Apply on the correct branch

This follow-up is for your Ubuntu development checkout after the SKAO-108 menu
update and PostgreSQL fixture corrections. Keep the earlier wait-limit result
correction as well. Unzip `SKAO-108-live-counts.zip` into Downloads.

If your earlier work is still on an SKAO-108 feature branch, remain there:

```bash
cd ~/workspace/ska_organizer
git branch --show-current
git status --short
bash ~/Downloads/SKAO-108-live-counts/apply-fix.sh
```

If earlier SKAO-108 work is already merged into development, create a fresh
branch first. This block stops on local changes instead of discarding anything:

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Stop: keep or commit local work before switching branches.' >&2
  git status --short
  exit 1
fi
git fetch origin
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-108-live-counts
BASH
```

Then apply using the command above. Patch mismatches stop before any file is
written. Do not force the patch or reset local work.

## 2. Run checks from the repository root

Stop the normal server/client, keep the existing server/.env and separate
PostgreSQL `_test` database, and run:

```bash
cd ~/workspace/ska_organizer
bash scripts/check-update.sh
```

There are no new dependencies or migrations. The existing check script retains
a backup and stops later steps if a check fails. Do not reset or reseed either
database to apply this change.

A quicker focused native check can be run first if desired:

```bash
(cd server && npm run test:postgres -- --runTestsByPath tests/menuHeadcounts.test.js tests/weeklyPlans.test.js tests/shelf.test.js tests/persistence.postgres.test.js)
```

## 3. Check the behavior

1. Add or confirm active children and employees in Children and Staff. Choose a
   new unsaved week in Meals → Planner. Children and Staff should match those
   active totals, rather than fixed placeholders. Employees are business staff
   records, independent of Accounts. Inactive people do not count.
2. Generate a menu, change planned counts, and set a daily child override. The
   shopping list should use the displayed weekly/daily counts. Save and reload:
   the saved choices and history must remain intact.
3. Change enrollment or staff status. A new week should read the changed totals.
   An existing saved week retains its reviewed counts. In that week, choose
   Use current roster counts: weekly fields update, daily overrides and meal
   selections remain, and shopping recalculates. Save explicitly to update it.
4. Retry a failed counts request; verify the draft is preserved. Manual editing,
   switching weeks or changing tabs while a request is pending must prevent its
   late response from replacing the newer choices.
5. Confirm these controls remain usable on the phone. Read-only accounts can
   calculate drafts and view aggregate counts but cannot save a menu or edit
   records. Printing and saving do not consume inventory.

Use synthetic/disposable records for destructive manual checks; keep facility
records and historical plans.

## 4. Review, commit and push on Ubuntu

The block stages this follow-up list and any earlier SKAO-108 lists still present
in Downloads. If those earlier changes are uncommitted, keep their original
packages unpacked there so their new files are also included. Review the staged
diff before committing:

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
case "$(git branch --show-current)" in
  feature/SKAO-108-menu-generation|feature/SKAO-108-postgres-test-fix|feature/SKAO-108-wait-limit-test-fix|feature/SKAO-108-live-counts|SKAO-108) ;;
  *) printf '%s\n' 'Stop: switch to an SKAO-108 feature branch before staging.' >&2; exit 1 ;;
esac
for package in SKAO-108-menu-generation SKAO-108-postgres-test-fix SKAO-108-wait-limit-test-fix SKAO-108-live-counts; do
  list=~/Downloads/$package/FILES.txt
  [[ -f "$list" ]] || continue
  while IFS= read -r file || [[ -n "$file" ]]; do
    [[ -z "$file" ]] || git add -- "$file"
  done < "$list"
done
git diff --cached --stat
BASH
```

```bash
git diff --cached
git commit -m "SKAO-108 use active roster totals for meal planning"
git push -u origin HEAD
```

Use development as the pull-request base. Merge after checks and manual testing
pass. On the Pi, check for local work, pull the merged development branch, then
run `bash SKAO.sh update` through the existing deployment workflow.

## Verification

- All 725 server tests passed across 47 suites using mock storage. The 15 new
  headcount HTTP cases verify roles, privacy, active/inactive filtering, totals
  beyond pagination, manual counts, failures, imports and saved-history behavior.
  After batching synthetic roster creation into one transaction, all 48 affected
  server tests passed again.
- All 547 client tests passed across 38 files, including 52 planner tests for
  count loading, explicit refresh, failure/retry, preserved overrides, late
  responses, same-tick request guards and legacy import.
- 15 browser checks were verified through the real fixture HTTP server: new
  roster/save/refresh workflows at 320/390px, generation recovery, core screens,
  purchasing, independent saved weeks and catalog corrections. The combined
  run passed 14 cases; the existing long catalog-correction case exceeded its
  30-second budget under concurrent test load, then passed unchanged in 18.9
  seconds when rerun alone.
- Final production build and lint passed (zero lint errors, one existing
  MealsManagement hook-dependency warning). Syntax, whitespace, shell guidance,
  safe patch application and ZIP integrity were checked.

Native PostgreSQL and physical-device verification remain pending. This update
uses the existing Ubuntu/Pi setup without changing network configuration.
