# SKAO-96 — approved Bloom design

The owner approved the Bloom v5 direction on September 24, 2026 (America/Los_Angeles), with the option to change it later. This increment integrates it into the React app's shared navigation, sign-in, Home, and Attendance screens. It does not complete the app-wide rollout or usability study.

## What is implemented

- The academy crest, local Plus Jakarta Sans font, white sidebar, colorful icons, four Home action cards, and 3D learning illustration.
- Home uses the existing dashboard API: current attendance/enrollment/staff counts, stock counts, saved meals, every room's activities, and recent changes. Loading/errors hide previous results. Partial failures still have individual recovery actions; uncertain attendance counts still direct staff to review.
- Current counts remain separate from the selected plan date. No sample schedules, children, dates, or room totals were copied from the prototype into operational screens. The learning spotlight is labeled as inspiration and opens the real planner.
- Find a child opens Attendance with search focused. Child cards show the available arrival/departure action; visit details and corrections expand below. Older, incomplete, or multiple open visits remain expanded. Historical dates and viewers do not get live attendance controls. Retry IDs, request locks, record versions, correction history, and facility-time behavior are preserved.
- The phone dock contains Home, Attendance, Activities, Meals, and More. More retains all other modules and account actions. The desktop and phone both call the dashboard Home; routes and existing bookmarks are unchanged.
- Sign-in uses the academy crest and the shared primary button. The inactive language selector was removed from the header because it did not change translations. Existing authentication and server permissions remain unchanged.

## Changing the design later

Start with `client/src/styles/theme.css`: it defines the font, colors, action-card fills, corner radius, buttons, panels, and form controls. Page-specific layout is in `client/src/pages/dashboard.css`, `client/src/pages/attendance.css`, and `client/src/components/app-shell.css`. Do not change API or attendance state logic to make a palette adjustment.

The original crest, generated illustration, and font are bundled under `client/src/assets/brand`. They are served by the application, with no runtime requests to external image/font services. The font license is shipped at `/licenses/PlusJakartaSans-OFL.txt`.

## Verification

- TypeScript/Vite production build passed.
- All 128 client tests passed, including 33 focused Home/Attendance/navigation/authentication tests.
- Full client lint passed with no errors and one pre-existing `react-hooks/exhaustive-deps` warning in `MealsManagement.tsx` (line 91). Changed TypeScript files passed the focused ESLint check.
- Browser test selectors and flows were updated for the new navigation and expandable visit details. Those browser tests were not executed in this environment. No visual, native keyboard/touch, safe-area, or cross-browser verification is claimed.
- Server/database code, schemas, dependencies, and network deployment settings are unchanged. No migration or real-record operation was performed for this UI work.

## Review on the test installation

After applying this commit and rebuilding the installed client:

1. Sign in with a test account. Check the academy logo and Home, then open every phone dock/More destination. On a narrow phone, the dock and child actions should fit without page-wide horizontal scrolling.
2. Open Find a child, search, check a synthetic child in/out, and refresh. Expand Visit details, inspect history, and make a correction only to a synthetic record.
3. Check a viewer and an older attendance date. Neither should offer live check-in/out controls.
4. Change Plan date on Home. Saved meals and activities should change; current counts stay current. Check an empty date and an unavailable connection.
5. Use keyboard navigation, browser Back, portrait/landscape, and reduced-motion settings. Check the bottom of long pages and account dialogs on target tablets/phones.

For an existing Windows pilot installation, use its existing update path after this change is committed locally: `./scripts/pilot.ps1 update`. It builds the selected commit and performs the existing backup/recovery workflow. Do not rerun `init` for an installed pilot.

Remaining SKAO-96 work includes target-device visual review, the other operational screens, and first-time-user usability evaluation. This increment is not a deployment or a completion of SKAO-96.
