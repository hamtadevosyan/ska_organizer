# SKAO-77 Attendance overflow correction — START HERE

Apply this follow-up on the branch that already contains the original SKAO-77
changes and the browser-test fix. Your latest output reaches the corrected
Attendance check and exposes a real layout problem at 320 and 390 px.

## What changes

The reported main-content widths were 533 px at a 320 px viewport and 544 px at
390 px. Source review found long room names in the heading and summary without
wrapping constraints, plus grid/flex sizing that could exceed narrow columns.

The correction is confined to `client/src/pages/attendance.css`:

- Long room/child labels wrap within Attendance, including summaries and visit
  details. The room heading can wrap, and its child count can move below it.
- Filter, child-list and visit-list grid columns can shrink to their available
  width. The child name's flex container can shrink too.
- Date, room and search filters stack below 768 px, with inputs constrained to
  the available width.

The long synthetic names and existing document/main-content width assertions
are retained unchanged. No clipping rule or wider test tolerance is added.

## Apply

Extract `SKAO-77-attendance-overflow-fix.zip` beside the repository. From the
repository root on your current feature branch, run:

```bash
git status --short
git apply --check ../SKAO-77-attendance-overflow-fix/SKAO-77-attendance-overflow-fix.patch
git apply ../SKAO-77-attendance-overflow-fix/SKAO-77-attendance-overflow-fix.patch
git diff --check
```

Adjust the patch path if extracted elsewhere. Stop if `--check` fails and keep
the output. Keep your existing changes; the earlier patches are not reapplied.
No dependency installation, migration or server configuration change is needed.

## Retest

From the repository root:

```bash
cd client
npm run test:browser -- tests/browser/core-screens.spec.ts
```

This repeats all four widths: **320, 390, 768 and 1280 px**. After it passes:

```bash
npm run test:browser
```

Also check Attendance with a long room/child name on your test installation:
filters, room heading, summary, check-in/out button and expanded visit details
should remain readable without moving the page sideways.

After validation, return to the repository root and stage this follow-up before
your normal commit, push and merge:

```bash
cd ..
git add client/src/pages/attendance.css docs/handoffs/SKAO-77-ATTENDANCE-OVERFLOW-FIX.md docs/handoffs/SKAO-77-VERIFICATION.md docs/mobile-core-screens.md
git diff --cached --stat
```

## Verification performed here

- Production TypeScript/Vite build passed.
- All **11 Attendance component tests passed**. These check behavior; they do
  not measure browser layout.
- The browser test sources are unchanged from the previous follow-up.
- Patch application is verified after both earlier ZIPs, resulting file contents
  are compared to the working files, and ZIP CRC/SHA-256 checksums are verified.

The local app URL remains blocked by the available browser, so the corrected
phone layout is **not yet claimed as browser-verified**. The rerun above remains
required. No commit, push, merge or deployment was performed on your behalf.
