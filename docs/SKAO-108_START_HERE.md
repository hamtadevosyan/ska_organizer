# SKAO-108 — restore menu generation and explain recipe setup problems

**Generate Menu** now chooses active meals with complete recipes. When a meal
period has no usable recipe, the planner names that period and shows how to fix
it in **Meal Setup**. Incomplete recipes are skipped when another complete recipe
is available. Generation failures and shopping calculation failures have separate
messages and retry actions.

Generation uses your facility's local saved recipes. It does not create new
recipes, save the week, reserve stock or consume inventory. A successful result
is an editable draft; **Save Menu** remains a separate action. Cancellation and
failed generation keep the previous menu, counts, daily attendance overrides and
shopping preview. Your saved week changes only after a successful save.

There are no new dependencies or database migrations for this update. It works
with the existing Ubuntu development and native deployment setup, including the
Pi. Keep the current databases and configuration.

## 1. Create the correct branch before applying

Use your Ubuntu development checkout. Stop the regular client and server.
Unzip `SKAO-108-menu-generation.zip` into Downloads so that
`~/Downloads/SKAO-108-menu-generation/apply-fix.sh` exists.

SKAO-107 must already be merged into **development**. Run this block before
applying SKAO-108. It stops if there is any local work and does not discard files.
If the SKAO-108 branch already exists, the final command stops; review that branch
before continuing instead of applying this work on the SKAO-107 branch.

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Stop: keep or commit the local work before applying SKAO-108.' >&2
  git status --short
  exit 1
fi
git fetch origin
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-108-menu-generation
BASH
```

Only after the block succeeds, apply the update:

```bash
cd ~/workspace/ska_organizer
bash ~/Downloads/SKAO-108-menu-generation/apply-fix.sh
git status --short
```

The apply script requires `feature/SKAO-108-menu-generation` and does not commit,
push or deploy. If it reports a patch conflict, stop and review the checkout;
do not force the patch or remove local work.

## 2. Run the full checks from the repository root

Use your existing `server/.env` and separate application/test PostgreSQL
databases. `TEST_DATABASE_URL` must name a different database ending in `_test`.
Node, PostgreSQL client tools, the existing server/client dependencies, local
recipe OCR and Playwright Chromium are prerequisites for the full check script.

No dependency changes are included. If the dependencies and Chromium are already
installed, go directly to the full check. For a fresh checkout, install the locked
dependencies and browser first:

```bash
cd ~/workspace/ska_organizer
(cd server && npm ci)
(cd client && npm ci)
(cd client && npx playwright install --with-deps chromium)
```

With the normal client and server stopped, run as your normal Ubuntu user:

```bash
cd ~/workspace/ska_organizer
bash scripts/check-update.sh
```

Use the default full command, without `--inventory`. It retains a database
backup, checks its readability, applies any previously pending migrations, and
runs server, separate PostgreSQL, client and browser tests plus build and lint.
It does not install dependencies, change Git branches, seed or reset databases.
A failure stops later checks and retains the backup; fix the reported failure
and rerun the command.

## 3. Try menu generation and recovery

Start the app normally on Ubuntu. Use synthetic records or a disposable test
database for checks that archive or alter catalog entries. Do not remove working
recipes from the facility database merely to reproduce an empty catalog.

1. Open **Meals → Planner** and choose a new week. With an empty catalog, choose
   **Generate Menu**. The message should name Breakfast, Morning snack, Lunch and
   Afternoon snack, rather than showing an unexplained server error.
2. Choose **Open Meal Setup**. Add one active meal for each of those four periods,
   with at least one active ingredient and a positive quantity per person. The
   **Browse meal ideas** choices can help create complete recipes; selecting an
   idea alone does not save it.
3. Return to Planner and choose **Retry generation** or **Generate Menu**. Review
   the five-day editable menu and shopping quantities. Change a meal and counts,
   choose **Save Menu**, then reload and confirm the saved result.
4. In the test catalog, make Morning snack unavailable: archive its only meal,
   remove its last recipe ingredient, or archive a referenced ingredient. Try
   generation again. The planner should name Morning snack and the affected
   recipe, offer **Edit recipe for …** where applicable, and retain the previous
   menu and counts. Repair or restore the recipe and retry.
5. Add a second complete meal for that period while keeping the incomplete meal.
   Generation should use a complete recipe and report **Some recipes were
   skipped**, with a route to repair the incomplete active recipe.
6. In an existing draft, record distinct child/staff counts and, when applicable,
   a daily attendance count. Start replacement generation and choose
   **Cancel generation** while it is pending. Also try a failed generation
   response. Both cases must preserve the prior menu, counts, daily overrides and
   shopping preview. Declining the replacement confirmation must change nothing.
7. Test a failed shopping recalculation separately. **Shopping list could not
   update** and **Retry calculation** should appear, rather than a generation
   error. Keep the menu draft, correct the reported ingredient/unit/stock issue,
   then retry. Package sizes and incompatible units must not be guessed.
8. Generate, save and reopen another week, then return to the first week.
   Confirm their saved menus remain independent and inventory counts are
   unchanged. A read-only account must not receive catalog editing actions;
   administrators and editors can open Meal Setup and repair recipes.

Successful regeneration keeps the selected week's headcounts and daily overrides.
It replaces the draft's menu only after the generation response succeeds and
then calculates shopping against current recipes and stock. Review that new
calculation before saving. Generation is not a check that the menu satisfies
every dietary or program requirement.

## 4. Review, commit and push from Ubuntu

Review the changes before staging:

```bash
cd ~/workspace/ska_organizer
git branch --show-current
git diff --stat
git diff
```

The branch must be `feature/SKAO-108-menu-generation`. Stage only the supplied
`FILES.txt` list with this guarded block:

```bash
bash <<'BASH'
set -euo pipefail
cd ~/workspace/ska_organizer
if [[ "$(git branch --show-current)" != feature/SKAO-108-menu-generation ]]; then
  printf '%s\n' 'Stop: switch to the SKAO-108 feature branch before committing.' >&2
  exit 1
fi
while IFS= read -r file || [[ -n "$file" ]]; do
  [[ -z "$file" ]] || git add -- "$file"
done < ~/Downloads/SKAO-108-menu-generation/FILES.txt
git diff --cached --stat
BASH
```

Confirm that the staged changes contain only this update, then run:

```bash
git commit -m "SKAO-108 fix menu generation and recipe setup recovery"
git push -u origin feature/SKAO-108-menu-generation
```

Open a pull request with base **development**. Merge after your checks, manual
testing and CI pass. This delivery does not commit or push on your behalf.

## 5. Pull the merged code on the Pi

Use the Pi only as the deployment checkout. Check for local work first:

```bash
cd ~/workspace/ska_organizer
git status --short
```

If any files are listed, stop and review them. With a clean checkout, run each
command only after the previous one succeeds:

```bash
git switch development
git pull --ff-only origin development
bash SKAO.sh update
```

Then repeat generation, recovery, save and reload from the existing app address
on your phone or tablet.

## Verification

The reproduced server paths are an empty catalog, a missing meal period,
archived recipes and incomplete current recipes. They explain known failures;
the exact catalog state behind the originally reported failure has not been
confirmed.

Verification on 12 October 2026:

- 151 API tests passed across 12 suites, including 19 generation HTTP cases,
  dated previews, recipe/stock corrections, shopping, purchasing and authentication.
- All 527 client tests passed across 38 files with two workers. This includes
  32 planner tests for failure/retry, cancellation, late responses, counts,
  explicit save and a delayed save while opening Meal Setup.
- 13 browser checks passed together through the real fixture HTTP server:
  menu generation and repair at 320/390/1280 pixels, preserved drafts and saved
  history, canceled requests, core screens, catalog correction, purchasing and
  existing saved-week workflows. The new browser file pauses and restores the
  shared catalog rather than assuming earlier tests left it empty.
- Production build, lint (zero errors; one existing meal-management warning),
  syntax and whitespace checks passed. Patch application, repeat application,
  wrong-branch refusal and conflicting-checkout preservation were verified.

An existing recipe-photo component test now waits for its asynchronous focus
change before checking the same expected field focus. No photo-import behavior
was changed.

A prior full browser run had a separate attendance-correction typing failure in
this environment, including when run alone. This update does not change that
attendance test or claim a full browser-suite pass here. Run the full check
script on your Ubuntu checkout before merging.

Native PostgreSQL and physical Pi/iPhone/iPad checks remain pending in this
execution environment; complete the full checks and manual workflow above
before merge and deployment.
