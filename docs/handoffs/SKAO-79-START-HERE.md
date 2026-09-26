# Start here — SKAO-79 safe caching

SKAO-77 is closed and is already merged into `development` in PR #18.
SKAO-79 is In Progress. This package adds static-only caching and a clear
connection screen. Installation buttons, a manifest and home-screen icons are
follow-up work in SKAO-80.

The package is based on `development` commit
`e987440d8477803fa9bbadc7bd75e0da09cbddfb`. It includes only SKAO-79 changes;
do not reapply the older SKAO-77 patches. No database migration, dependency
addition or hardware setup is required.

## 1. Apply the patch

Extract `SKAO-79-safe-caching.zip` beside your source repository. From the
repository root, check for uncommitted work:

```bash
git status --short
```

Preserve or finish any existing edits first. With a clean checkout:

```bash
git switch development
git pull --ff-only
git switch -c feature/SKAO-79-safe-caching
git apply --check "../SKAO-79-safe-caching/SKAO-79-safe-caching.patch"
git apply --index "../SKAO-79-safe-caching/SKAO-79-safe-caching.patch"
git diff --cached --stat
```

Adjust the patch path if extracted elsewhere. If the check fails, share the
error instead of forcing the patch. The package contains no dependencies,
generated build output, database files or environment files.

## 2. Run the checks

Use Node 24. From the repository root on Linux:

```bash
cd server
npm ci
cd ../client
npm ci
npm run build
npm run test:pwa
npm run lint
npm test
npx playwright install chromium
npm run test:browser
npm run test:browser:pwa
cd ..
```

Run each command in order and stop on a failure. On Windows PowerShell the same
commands work with `npm.cmd` and `npx.cmd` if script execution policy requires it.
On Linux, Playwright may prompt for missing system browser dependencies; follow
its installation guidance if Chromium cannot launch.

Expected: 142 client unit/component tests, 8 worker-policy tests, 26 existing
browser cases and 2 new PWA browser cases. The build creates `client/dist/sw.js`.
Lint has one pre-existing warning in `MealsManagement.tsx`, with no errors.
The two browser suites share ports 3009 and 5179; run them sequentially and
close old disposable test servers on those ports first. Both use synthetic
in-memory records, not your pilot database or `server/.env`.

Build, client tests and worker-policy tests passed in this workspace. The browser
cases still need your execution; test discovery is not a browser pass. Read
`SKAO-79-VERIFICATION.md` for the exact validation limits.

## 3. Try the production build locally

This review needs a production build: the normal Vite development server does
not register a service worker. Use the disposable fixture, not real records.
In terminal 1, from the repository root:

```bash
node server/tests/fixtures/browserServer.js
```

In terminal 2, from the repository root on Linux:

```bash
cd client
VITE_API_BASE_URL=/ npm run build
npm run preview -- --config vite.pwa-test.config.ts --host 127.0.0.1 --port 5179 --strictPort
```

For PowerShell, replace the build line with:

```powershell
$env:VITE_API_BASE_URL = '/'
npm.cmd run build
```

Open **http://127.0.0.1:5179** on that computer. The disposable login is
`browser-admin` / `Synthetic browser passphrase 20!`. These are public test
fixture values, not production credentials. Keep this fixture on loopback.

In Chrome or Edge DevTools, inspect Application > Service Workers and wait for
`/sw.js` to become active. Leave “Bypass for network” and “Update on reload” off
while checking normal behavior. Application > Cache Storage should contain a
`skao-static-v1-...` cache with public HTML and `/assets/` files only.

1. Create a fictional child. Open its screen and inspect the cache again:
   there must be no `/api` responses, records or search-query URLs in it.
2. Enable DevTools' offline network simulation and reload. Expect **We can't
   reach the academy computer**, a **Try again** button and no child records.
3. Restore the network. The app checks the server automatically, or use **Try
   again**. A valid session should open the live app again; an expired session
   should show sign-in.
4. While online, open Add child and type a fictional draft without saving. Go
   offline and use **Try again** once the connection warning appears (the
   visible-page check runs every 30 seconds). Expect **Connection interrupted**
   and the same open draft. Return online and check that the draft remains.
   No save should run automatically.
5. After reconnecting, save a synthetic edit and confirm it on a normal reload.
   If a save failed during an outage, inspect the latest server record before
   attempting it again. Reloading clears unsaved drafts.
6. Check the connection screen and warning at phone widths 320 and 390 px.
   Confirm the text and button fit and are easy to use.

Stop both test servers with Ctrl+C when finished. In DevTools for this loopback
test origin, unregister its worker and remove its `skao-static-v1-...` cache when
returning to regular development on the same origin. Do not clear your pilot
site's data as part of this fixture cleanup.

## 4. Commit, push and merge after review

```bash
git status --short
git diff --cached --check
git commit -m "SKAO-79: cache public shell and handle local server outages"
git push -u origin feature/SKAO-79-safe-caching
```

Open a PR into `development`. Require the existing client and pilot deployment
workflows to pass, including the new PWA browser and served-worker checks.
No commit, push, merge or deployment has been performed on your behalf.

## 5. Check the existing HTTPS pilot after merge

Use the existing update procedure in `docs/private-pilot.md` and
`docs/backup-recovery.md`; do not initialize a replacement pilot. The Caddy
configuration and built worker are part of the normal web image update.

On the test device, use the normal **trusted HTTPS** local address. A plain HTTP
LAN IP cannot register this worker; loopback's development exception does not
apply to tablets. Confirm the root certificate is trusted without warnings.
Repeat startup, connection loss and recovery with synthetic records on the
test installation. When ready, close all app tabs and reopen to activate a
waiting update; the worker does not force-reload an open form.

`docs/pwa-caching.md` explains the policy and limitations. SKAO-79 stays In
Progress pending your browser/deployment review and integration.
