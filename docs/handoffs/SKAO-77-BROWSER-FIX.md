# SKAO-77 browser-test follow-up — START HERE

Apply this small follow-up **after the original SKAO-77 patch**. Keep your
current feature branch and existing changes. No package installation, database
migration or Docker update is needed for this test-only correction.

## What the uploaded failures showed

- All four core-screen checks stopped at an old heading: the approved Attendance
  screen says **Who's here today?**. The check now uses that heading, selects its
  synthetic room and waits for the test child before measuring the layout.
- Every API helper call previously signed in again. Failed tests can restart a
  Playwright worker and rerun `beforeAll`, consuming more attempts. The shared
  fixture server allows 20 login attempts per IP in 15 minutes; later tests
  therefore received HTTP 429.
- **Rooms & Classes** still exists in both navigation definitions. Its timeout
  is consistent with the same exhausted login budget. The UI sign-in helper now
  checks the login response directly, so an unsuccessful sign-in is reported at
  sign-in rather than as a missing destination link.

Domain/layout checks now reuse one real administrator session per worker,
held only in memory. Each helper call still validates that session through the
real API and obtains its CSRF token. Authentication scenarios still use real
sign-ins; the mobile sign-out case requests a separate session. Production
authentication, rate limits, permissions and application UI are unchanged.

## Apply on your Linux checkout

1. Extract `SKAO-77-browser-fix.zip` beside the repository. The extracted folder
   should be named `SKAO-77-browser-fix`.
2. From your existing repository, run:

```bash
git status --short
git apply --check ../SKAO-77-browser-fix/SKAO-77-browser-fix.patch
git apply ../SKAO-77-browser-fix/SKAO-77-browser-fix.patch
git diff --check
```

Adjust only the patch path if you extracted elsewhere. Stop if the check fails;
keep the output and your current changes. Do not reapply the original SKAO-77
patch or reset the branch. These commands also work in PowerShell.

## Rerun the checks

Stop any manually launched **browser fixture** servers using ports 3009 or
5179. Playwright starts a fresh isolated fixture for each command and stops it
afterward. This clears the previous run's synthetic data and login-attempt count.

From the repository root:

```bash
cd client
npm run test:browser -- tests/browser/core-screens.spec.ts
npm run test:browser
```

The first command runs the four core-screen widths. After those pass, run the
full suite of **26 tests**. Continue the phone/desktop/print walkthrough from the
original START-HERE instructions; SKAO-77 remains In Progress until validation
and integration are complete.

The follow-up uses `git apply` without staging. After successful testing, return
to the repository root and stage the corrected files before your usual commit:

```bash
cd ..
git add client/tests/browser/auth-helpers.ts client/tests/browser/core-screens.spec.ts client/tests/browser/mobile-navigation.spec.ts docs/handoffs/SKAO-77-BROWSER-FIX.md docs/handoffs/SKAO-77-VERIFICATION.md
git diff --cached --stat
```

Review the complete SKAO-77 changes, then commit, push and merge using your
normal workflow. Nothing has been committed or pushed on your behalf.

## Verification performed for this follow-up

- Strict TypeScript checking passed for all browser test sources.
- Focused ESLint passed for the three changed test files.
- Playwright discovered all 26 tests successfully (`--list`; no browser run).
- An API-only check of the actual compiled helper used Supertest against the
  isolated Express app: 30 independent cookie jars reused one login and could
  make authorized requests, including a CSRF-protected write. A separate session
  then signed out; the shared session remained valid, with two total logins.
- All **17 existing server authentication tests passed**, including account
  throttling, session expiry, CSRF, permissions and session revocation.
- Patch application and resulting file contents are checked against the exact
  original SKAO-77 handoff tree, with ZIP CRC and SHA-256 checksums.

The local browser URL remains blocked in this environment. These results do
**not** claim the browser suite, phone layout or native print rendering passed.
The full browser rerun above is still required.
