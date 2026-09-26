# SKAO-77 verification

Base: `b09ebbe` on `development` (PR #17). Local working branch:
`feature/SKAO-77-core-mobile`. No push, merge or deployment performed.

## Passed here

- TypeScript/Vite production build, including the final print visibility rules.
- Existing client suite: **128 tests, 14 files**, all passed. This exercises
  authentication, permissions, record changes, cancellation, drafts, retries,
  inventory behavior and report/print data in a DOM environment.
- Full client ESLint: **zero errors** and one pre-existing hook-dependency
  warning at `MealsManagement.tsx:91`.
- New `core-screens.spec.ts` passes strict TypeScript and focused ESLint checks.
- Source review confirms that changes are limited to client presentation,
  browser regression coverage and documentation. No server/schema, production API helpers,
  state hooks, business arithmetic, dependencies or deployment settings changed.
- Delivery patch is checked against an isolated index at the exact base and
  resulting file contents are compared byte for byte. ZIP CRC and the SHA-256
  file manifest are checked before delivery.

## Not executed here

The browser tool returned `net::ERR_BLOCKED_BY_CLIENT` when opening the isolated
loopback test app. That block was not bypassed using another browser, host or
route. Consequently, the new and existing browser suites, screenshots, native
print rendering and real-device checks are **not claimed as passed**.

The new browser check is for 320, 390, 768 and 1280 px, with synthetic long-name
records, document/main-content overflow measurements, touch-control height
checks, profile/edit forms, Activity Planner materials, Meal Setup and report
print semantics. The existing navigation tests also cover 375 and 430 px. Run
the complete browser suite using START-HERE before committing.

Check iPhone/Android keyboard behavior, screen-reader labels, orientation,
zoom, safe areas, long-record actions, desktop tables and full print output on
the user's test installation. These are material acceptance checks for a
responsive UI; DOM tests do not establish that a screen fits a phone.

The initial presentation increment did not rerun backend/PostgreSQL suites
because no backend or persistence logic changed. No real records were used.

## Follow-up after the owner's browser run

The supplied output reported four stale Attendance heading checks, a Rooms
navigation timeout, and two HTTP 429 login failures. The Attendance assertion
and shared browser-session setup are corrected in the follow-up described in
[SKAO-77-BROWSER-FIX.md](SKAO-77-BROWSER-FIX.md). The Rooms label still exists;
sign-in now reports a rejected login immediately instead of allowing a later
navigation timeout to obscure it.

All browser sources pass strict TypeScript checking; the three changed test
files pass ESLint, and Playwright discovers all 26 tests. An API-only integration
check confirms 30 helper calls reuse one real login, preserve CSRF-protected
writes, and retain that session after signing out a separate session. The
existing server authentication suite was rerun for this follow-up: **17 passed**.
Production rate limits and authentication code are unchanged.

The browser rerun is still pending on the owner's installation. Test discovery
and API-only checks are not browser layout validation.

## Attendance overflow follow-up

The next supplied output reports real Attendance main-content overflow: 533 px
at a 320 px viewport and 544 px at 390 px. A scoped correction to
`client/src/pages/attendance.css` wraps long room/child labels, allows heading
and grid/flex containers to shrink, and stacks the phone filters. See
[SKAO-77-ATTENDANCE-OVERFLOW-FIX.md](SKAO-77-ATTENDANCE-OVERFLOW-FIX.md).

The production build and all **11 Attendance component tests passed** for this
correction. Browser test data, width assertions and tolerances are unchanged.
The patch is verified on top of the original ZIP and browser-test fix. Browser
rendering remains pending on the owner's installation; the earlier browser
access restriction was not bypassed.
