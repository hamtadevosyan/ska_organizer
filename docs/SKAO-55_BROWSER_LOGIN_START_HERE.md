# SKAO-55 — Browser login-limit fix

The full browser suite reached the real server's limit of 20 login attempts per direct IP in 15 minutes. Successful logins clear their username counter but retain the IP counter. The staff editor login became attempt 21 and received HTTP 429; the failed worker's replacement then hit the same limit in the next tests.

Four activity-navigation checks and two room-age checks unnecessarily requested disposable sessions even though they never sign out or revoke their sessions. They now reuse the existing valid fixture session. Logout, remembered-login and permission scenarios still perform their own real logins. Production authentication code, rate limits, session validation and application data are unchanged. No retries, delays, reset endpoint or automatic reauthentication were added.

## Apply on your existing SKAO-55 checkout

Extract SKAO-55-browser-login-fix.zip into Downloads. Run from your ska_organizer checkout with the normal development client/server stopped:

```bash
bash ~/Downloads/SKAO-55-browser-login-fix/apply-fix.sh
npm --prefix client run test:browser
```

The apply script checks every change before writing, preserves conflicting edits and safely recognizes an already applied patch. It does not install dependencies, change settings, migrate a database or commit/push anything.

This patch only changes tests and these instructions. Because your previous check-update run reached Browser tests, its database backup/migrations and earlier checks have already run. The browser command starts the existing isolated mock test servers and leaves the real database alone. Keep the backup reported by your previous run.

To rerun the complete update verification instead, use the existing command:

```bash
bash scripts/check-update.sh
```

That full script creates another backup, verifies it, applies any pending migrations and runs all configured checks. Use your normal Ubuntu test/commit/push/merge workflow after the checks pass; the Pi continues to pull merged development code.

## Verification

The full 66-case browser run passed the staff permissions, staff directory and weekly-plan tests that previously received 429. Overall it passed 65 cases; an unrelated attendance check could not retain its typed correction reason in the local Chromium 138 runtime and also failed when rechecked separately. Its cause is unconfirmed, and that test remains unchanged. Your reported run had passed that attendance case. Run your installed Playwright Chromium and report it separately if it fails there too.

All 18 server authentication checks passed. The new regression verifies that 20 valid sign-ins across different accounts still exhaust the IP budget, the next login receives 429 without a session cookie, and an already signed-in session remains valid. Its scoped timeout allows the real password-verification work to complete on slower hardware. See VALIDATION.md for the results.
