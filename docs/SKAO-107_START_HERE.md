# SKAO-107 — activity planner generation

This update adds **Generate week** to Activity Planner. It chooses suitable
activities from your local saved library, lets you review and edit the suggestions,
and applies them to a draft. **Save week** remains a separate action. Existing
activities are kept unless you explicitly select and confirm replacements.

There are no new package dependencies, database migrations, AI-model requirements
or hardware requirements. This update does not change Windows, Ubuntu, router,
DNS, firewall or certificate settings.

## 1. Create the branch before applying the update

Use your Ubuntu development checkout. Stop the regular client and server first.
Unzip `SKAO-107-activity-generation.zip` into Downloads so that
`~/Downloads/SKAO-107-activity-generation/apply-fix.sh` exists.

Run this block. Adjust the checkout path if yours differs. It stops if there is
uncommitted or untracked work; commit or otherwise keep that work before retrying.
It does not discard any files. If the feature branch already exists, the final
command stops; inspect that branch before deciding whether to continue on it.

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Stop: this checkout has local changes. Keep or commit them before applying SKAO-107.' >&2
  git status --short
  exit 1
fi
git fetch origin
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-107-activity-generation
BASH
```

Only after that block succeeds, apply the update:

```bash
cd ~/workspace/ska_organizer
bash ~/Downloads/SKAO-107-activity-generation/apply-fix.sh
git status --short
```

If the patch does not match, stop and keep the checkout intact. Do not force the
patch or reset local work. The apply script does not commit, push or deploy.

## 2. Run all checks from the repository root

Your normal application and test PostgreSQL databases must already be configured
in `server/.env`. `TEST_DATABASE_URL` must use a separate database ending in
`_test`. The usual project tools, local recipe OCR, installed server/client
dependencies and Playwright Chromium are prerequisites for the full script.

No new dependencies are added by this update. If dependencies are already
installed, go straight to the one-command check below. If this is a fresh
checkout, install the locked dependencies and browser once:

```bash
cd ~/workspace/ska_organizer
(cd server && npm ci)
(cd client && npm ci)
(cd client && npx playwright install chromium)
```

With the regular server and client stopped, run:

```bash
cd ~/workspace/ska_organizer
bash scripts/check-update.sh
```

Use the full script without `--inventory`. It creates and checks a database
backup, applies any previously pending migrations, then runs server, separate
PostgreSQL, component and browser tests, production build and lint. It does not
install dependencies, reset databases or change Git branches. A failure stops
later steps and retains the backup; fix the reported issue before retrying.

## 3. Try the workflow

Start the app as usual on Ubuntu. Use synthetic records while testing.

1. Open **Activity Planner**, choose an active room with a valid age range, and
   choose the Monday of a week. In **Saved activities**, make sure several
   activities have suitable ages, a usual duration and any required materials.
2. Choose **Generate week**, select working days and time windows, then choose
   **Preview generated week**. There is one suggestion per window on each day.
3. Change a suggested activity and its times. Expand **Instructions and materials**
   and review **Materials after this change**. Shortages and unit problems must
   remain visible; generation does not consume or reserve stock.
4. Choose **Use generated plan**. Confirm the planner shows unsaved changes.
   Choose **Undo generation** and confirm the prior draft returns. Apply another
   preview, choose **Save week**, then reload and confirm the week persisted.
5. With a small activity library, check the reasons under **Slots that need your
   choice**. Retry selected slots or enable **Allow repeated activities when
   needed**. Other suggestions must remain. Filled suggestions can be applied
   while unfilled slots are completed manually later.
6. Keep a fixed routine in the week and generate around it. If you intend to
   replace it, open **Existing activities are kept**, select it and confirm before
   previewing. If replacement slots cannot all be filled, selected originals
   must remain. Cancel or stop generation and confirm the draft is unchanged.
7. Try a failed/stale preview, read-only account, archived room and two-tab save
   conflict. Failed choices should remain available; stale work must not
   overwrite the saved week. Repeat the main flow on a phone or tablet after
   deployment.

Material quantities are read-only in the generated preview. Change their catalog
definition through **Saved activities** and reopen generation after a library
change. All suggestions remain local; this feature does not require a cloud AI
service or local model installation.

## 4. Commit and push from Ubuntu

Review the diff and confirm the branch before staging:

```bash
cd ~/workspace/ska_organizer
git branch --show-current
git diff --stat
git diff
```

The branch must be `feature/SKAO-107-activity-generation`. Stage only the files
listed in the update's `FILES.txt`, then review and commit:

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
if [[ "$(git branch --show-current)" != feature/SKAO-107-activity-generation ]]; then
  printf '%s\n' 'Stop: switch to the SKAO-107 feature branch before committing.' >&2
  exit 1
fi
while IFS= read -r file || [[ -n "$file" ]]; do
  [[ -z "$file" ]] || git add -- "$file"
done < ~/Downloads/SKAO-107-activity-generation/FILES.txt
git diff --cached --stat
BASH
```

Check that the staged files are only this update, then run:

```bash
git commit -m "SKAO-107 generate editable activity plans from local library"
git push -u origin feature/SKAO-107-activity-generation
```

Open a pull request with base **development**, wait for its checks, and merge it
after your testing passes.

## 5. Update the Pi after the merge

The Pi remains a deployment checkout. Do not commit or push from it. On the Pi,
check that it has no local changes before pulling:

```bash
cd ~/workspace/ska_organizer
git status --short
```

If that lists local changes, stop and review them. If it is clean, run each command
only after the previous one succeeds:

```bash
git switch development
git pull --ff-only origin development
bash SKAO.sh update
```

Confirm the saved week and generation flow from the existing app address on your
phone or tablet. No device, router or certificate change is needed for this update.

## Verification

Verified on 12 October 2026 (UTC):

- 119 API tests passed across generation, manual planning, plan reuse, activities,
  authentication, rooms and inventory stock.
- All 515 client tests passed across 38 files, with two workers to keep the check
  within this environment's resources.
- 9 integrated browser tests passed: generation/edit/cancel/undo/save at 320, 390
  and 1280 pixels; selected-slot retry with a failed response; stale-week handling;
  and core-screen layout at 320, 390, 768 and 1280 pixels. Existing navigation and
  plan copy/move browser scenarios also passed.
- Production build, ESLint (zero errors; one existing meal-page warning), syntax
  and whitespace checks passed. Patch application, repeat application and refusal
  on a wrong branch or conflicting checkout were verified.

The native PostgreSQL regression is included in the ordinary full check script,
including the new room-history query and save/reconnection check. Native
PostgreSQL and physical iPhone/iPad checks remain pending in this execution
environment; run the full script and device checks above before merging/deploying.
