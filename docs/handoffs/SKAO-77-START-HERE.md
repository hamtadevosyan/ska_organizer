# Start here — SKAO-77 phone layouts

This is an application update for the remaining core phone screens. It builds on
your merged mobile navigation and Bloom design. SKAO-66 is closed; its workflow
proposal and AI-related planning work are deferred.

## What you will see

- Children and Staff: labeled phone cards with actions beside each record.
- Inventory and Reports: readable phone records, purchase/history layouts and
  wrapping filters/pagination.
- Meals: compact Bloom header, wrapping tabs/actions, better space for forms,
  and readable shopping quantities on phones.
- Activities: room/week controls, time fields and materials fit narrow screens.
  The current planning workflow is kept.
- Home, Attendance and navigation retain their approved layouts. Desktop and
  print tables are retained.

Build and 128 client tests passed. Browser/device layout verification is still
needed; read `VERIFICATION.md` for the exact limits.

## 1. Extract and apply

Extract `SKAO-77-core-mobile.zip` into a folder beside your normal source
repository. Open PowerShell in the repository. The patch is based on
`development` commit `b09ebbe` after PR #17, your SKAO-66 documentation merge.

Check for existing edits first:

```powershell
git status --short
```

If files are listed, preserve or finish that work before continuing. With a clean
checkout:

```powershell
git switch development
git pull --ff-only
git switch -c feature/SKAO-77-core-mobile
git apply --check "../SKAO-77-core-mobile/SKAO-77-core-mobile.patch"
git apply --index "../SKAO-77-core-mobile/SKAO-77-core-mobile.patch"
git diff --cached --stat
```

Adjust the patch path if the ZIP was extracted elsewhere. If the check fails,
stop and share the exact error instead of forcing the patch. No files from
`node_modules`, `.env`, a database or a build output are included.

## 2. Run the checks

The browser suite uses synthetic data and an isolated in-memory API. It does not
use your pilot records or database. Stop any old test servers on ports 3009/5179
before starting the browser suite.

```powershell
Push-Location server
npm.cmd ci
Pop-Location
Push-Location client
npm.cmd ci
npm.cmd run build
npm.cmd run lint
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:browser
Pop-Location
```

Run the commands in order and stop if any fails. Lint currently has one existing
warning in `MealsManagement.tsx`; no lint errors are expected. The browser suite
includes a new core-screen check at 320, 390, 768 and 1280 px, plus the existing
navigation and business-flow checks. Browser tests have not been executed in
this chat environment, so this is a required review step.

## 3. Try the app before committing

To inspect it in your browser using disposable examples, open two PowerShell
windows. In the first, from the repository root:

```powershell
node server/tests/fixtures/browserServer.js
```

In the second, from the repository root:

```powershell
Set-Location client
$env:VITE_API_BASE_URL = "http://127.0.0.1:3009"
npm.cmd run dev -- --host 127.0.0.1 --port 5179 --strictPort
```

Open **http://127.0.0.1:5179** on that computer. The built-in disposable account is:

- Username: `browser-admin`
- Password: `Synthetic browser passphrase 20!`

These are public test-fixture values, not a production login. Create a fictional
room, child, staff record and inventory item if needed. This fixture resets when
its server stops and stays on loopback; do not expose it to the LAN.

In Chrome or Edge, press F12, then Ctrl+Shift+M for the device toolbar. Try widths
320, 375, 390, 430 and 768, then return to desktop. Check:

1. Children: search, View profile, Edit, Cancel and Save. Actions should stay
   beside their record without sliding the main page sideways.
2. Staff and Inventory: search/filter, open forms, and review history. Try a long
   name or location. Check that the last action is reachable above the phone dock.
3. Meals: generate a sample menu, edit recipes/counts, save/reopen, and inspect
   shopping quantities. Print preview should show a complete table without tabs
   or navigation controls.
4. Activities: add a full day, edit times, check materials and save/reload. Its
   workflow should behave as before; the SKAO-66 prototype is not installed.
5. Reports: inspect populated results, change dates/room, print and export CSV.
   Printed output must contain all records, not just the screen page.
6. Home/Attendance/More: check that the existing approved screens still work.
   Also check an existing viewer/editor account on the test installation.

Close the two test servers with Ctrl+C when done. Browser emulation cannot fully
check a real phone keyboard, rotation or safe areas; repeat the key actions on
your usual test installation after updating it.

## 4. Commit, push and merge

After the checks pass and the layout looks right:

```powershell
git status --short
git diff --cached --check
git commit -m "SKAO-77: finish responsive core-screen layouts"
git push -u origin feature/SKAO-77-core-mobile
```

Open a PR into `development` and merge through your usual workflow. No commit,
push, merge or deployment was performed on your behalf.

## 5. Update the installed pilot

In the existing pilot repository after the PR is merged:

```powershell
git switch development
git pull --ff-only
.\scripts\pilot.ps1 update
.\scripts\pilot.ps1 status
```

Use **update**, not init, for the existing installation. Refresh the browser with
Ctrl+F5, then check the normal local URL on your phone. This package requires no
new database migration, HTTPS/network change, PWA setup or AI service.

SKAO-77 remains In Progress until the browser/phone review and your integration
are confirmed. `COVERAGE.md` explains exactly what was already covered by
SKAO-78/96 and what this update adds.
