# Start here — SKAO-80 app installation

SKAO-79 is closed and merged in PR #19. SKAO-80 is In Progress. This package
adds a home-screen manifest, academy logo icons, installation help and update
notices. It is based on `development` commit
`071c9577555175834890175bdc3f2801df3329ca` and contains only SKAO-80 changes.

Your workflow stays the same: apply, test, then commit and merge. There is no
database migration, dependency change, hardware setup or deployment in this
handoff. Do not reapply the SKAO-79 patch.

## 1. Apply

Extract `SKAO-80-pwa-install.zip` beside your repository. From the repository
root, run `git status --short` and preserve any existing work first. With a clean
checkout:

```bash
git switch development
git pull --ff-only
git switch -c feature/SKAO-80-pwa-install
git apply --check "../SKAO-80-pwa-install/SKAO-80-pwa-install.patch"
git apply --index "../SKAO-80-pwa-install/SKAO-80-pwa-install.patch"
git diff --cached --stat
```

Adjust the patch path if extracted elsewhere. If the check fails, share the
error instead of forcing the patch. The binary patch includes the four icons.
No environment, database, dependency or generated build files are included.

## 2. Automated checks

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

Run commands in order and stop on a failure. On Windows, use `npm.cmd` and
`npx.cmd` if required by PowerShell policy. For missing Linux browser libraries,
follow Playwright's installation guidance.

Expected: 155 client tests, 10 worker/asset checks, 26 existing browser cases
and 4 PWA browser cases. The browser suites share ports 3009/5179, so run them
sequentially after closing old disposable fixtures on those ports. They use
synthetic in-memory data, not the pilot database. Lint has one pre-existing
MealsManagement hooks warning. Vite also reports the main JS chunk just above
500 kB (about 148 kB gzip); the build succeeds.

Browser execution still needs your environment; discovery is not a test pass.
Read `SKAO-80-VERIFICATION.md` for the checks actually executed.

## 3. Try it before committing

Use a production build for this review: the normal development server does
not register a worker or offer installation. In terminal 1, from the repo root:

```bash
node server/tests/fixtures/browserServer.js
```

In terminal 2:

```bash
cd client
VITE_API_BASE_URL=/ npm run build
npm run preview -- --config vite.pwa-test.config.ts --host 127.0.0.1 --port 5179 --strictPort
```

In PowerShell, replace the build line with `$env:VITE_API_BASE_URL = '/'`, then
run `npm.cmd run build`. Open **http://127.0.0.1:5179** on the same computer.
The disposable login is `browser-admin` / `Synthetic browser passphrase 20!`.
Keep this fixture on loopback; it is not a deployment for real records.

Check these changes:

1. Open **App setup** from sign-in. Inspect the academy icon, Android steps and
   iPhone/iPad steps. A native Add to home screen button appears only if the
   browser offers it; manual instructions remain available without it.
2. Sign in. Find App setup in the desktop toolbar. At phone widths 320 and
   390 px, open More > App setup. Confirm the dialog fits, scrolls and closes.
   If a child form was open, its unsaved fields should still be there afterward.
3. In DevTools > Application > Manifest, confirm Smart Kids Academy, the
   normal and maskable icons, `/dashboard` start URL and standalone display.
   A simulated phone viewport cannot prove a real phone installation.
4. Confirm the existing offline connection screen still works. Cache Storage
   should have public HTML/assets only, including the four icons, and no API
   records. Check for updates should explain a failed check while offline.

Stop the two test servers with Ctrl+C when done. If returning to Vite development
on this loopback origin, unregister this fixture's worker and remove only its
`skao-static-v1-...` cache in DevTools. Do not clear the pilot site's data.

## 4. Verify updates in two windows

On the disposable fixture, after finishing the browser suites:

1. Open the production app in two tabs and wait for its worker to activate.
   Enter an unsaved fictional draft in each tab.
2. Change a harmless line of UI copy temporarily and rebuild with
   `VITE_API_BASE_URL=/ npm run build` in another terminal. Keep both tabs open
   and keep the preview server running. Do not use DevTools' Skip waiting or
   Update on reload controls; those bypass the behavior being tested.
3. In App setup, choose Check for updates. Both tabs should show **New version
   ready** after the new worker is installed. Neither tab should reload or lose
   its draft. Opening/closing help must not discard the draft either.
4. Finish or deliberately discard the synthetic drafts. Close both tabs and
   any other academy app windows, then reopen. Confirm the new copy appears and
   only the current static cache remains after activation.
5. Undo only your temporary copy edit and rebuild before committing. Repeat
   closing/reopening as needed; do not include that experimental edit in the PR.

This manual check exercises real waiting/activation across two builds. The
unit tests cover update events and retained form state, but do not replace it.

## 5. Commit, merge and review the HTTPS pilot

```bash
git status --short
git diff --cached --check
git commit -m "SKAO-80: add app installation and safe update guidance"
git push -u origin feature/SKAO-80-pwa-install
```

Open a PR into `development`; require client and pilot deployment CI to pass.
No commit, push, merge or deployment was performed here. After your merge,
update the existing pilot with its normal procedure (`scripts/pilot.ps1 update`),
not a new initialization. See `docs/private-pilot.md` and the backup/update guide.

Use the normal trusted HTTPS LAN address on your test phone. Close old academy
windows once after moving from SKAO-79, then reopen to get the new setup UI.
Check that installation uses the academy crest and launches the app without a
normal browser address bar. Sign in again if the platform uses separate app
storage. Check navigation, keyboard use, logout, connection loss and reopening.

On Android, browser-managed installation can contact a provider's service with
app metadata. It is not a guarantee of zero external traffic. The app itself
adds no external service; fully isolated device installation remains part of
the future device/network work. `docs/pwa-installation.md` explains the boundary.

SKAO-80 stays In Progress until your native browser/device review and integration
are confirmed. The current tracked HTTPS pilot is Caddy; an older untracked
nginx setup has not been tested by this handoff.
