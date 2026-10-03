# Sign-in and account administration (SKAO-20)

The organizer now requires an explicitly authorized account. PostgreSQL stores accounts, password hashes, revocable sessions, sign-in attempt counters and audit events. Existing meals, recipes and saved weeks remain intact. Staff records do not create accounts, and there is no public registration or parent portal.

## One-time setup on Ubuntu VMware

Run these steps from your checkout when setting up sign-in for the first time. Keep your current `server/.env`, database password and data. Use your normal database backup procedure before applying the migration; do not reseed or recreate the database. For later updates, use the shared [backup, migration and checks procedure](update-checks.md).

1. Stop the backend (`Ctrl+C`).
2. Edit `server/.env` and add `APP_ORIGINS` using the frontend **Network** URL that Windows Chrome opens. Include its scheme and port, with no trailing slash. For example, **only if these match your VM**:

   ```dotenv
   APP_ORIGINS=http://192.168.33.132:5173,http://localhost:5173
   ```

   Keep `DB_ADAPTER=sequelize`, your existing `DATABASE_URL`, `PORT=3001` and `NODE_ENV=development`.

3. Check that `client/.env` uses the **same VM IP and scheme** for the API. Different ports are expected:

   ```dotenv
   VITE_API_BASE_URL=http://192.168.33.132:3001
   ```

4. Apply the additive migration and create your first administrator:

   ```bash
   cd ~/workspace/ska_organizer/server
   npm run db:migrate
   npm run admin:create
   ```

   Enter your chosen username, display name and password at the prompts. Password input is hidden. Use 15–128 characters; spaces are allowed. The command refuses to create another bootstrap account after any account exists. It never installs a default password or test account.

5. Start the backend as usual:

   ```bash
   node index.js
   ```

6. In the second Ubuntu terminal:

   ```bash
   cd ~/workspace/ska_organizer/client
   npm run dev
   ```

7. Open the **Network** URL in Windows Chrome and sign in. Restart the frontend after editing its environment file and the backend after editing its environment file. If Vite changes from 5173 to 5174, add that exact frontend origin to `APP_ORIGINS` and restart the backend.

For automation, the bootstrap command also accepts `--password-stdin`, with the non-secret identity in `ADMIN_USERNAME` and `ADMIN_DISPLAY_NAME`. Supply the password through a protected input stream. Never put it in a command-line argument, commit it, or paste it into chat.

## Account roles

| Role | Operational data | Account administration and audit |
|---|---|---|
| Administrator | Read and write | Create accounts, change access, disable/re-enable, reset passwords, read audit |
| Editor | Read and write | No access |
| Read only | View, calculate draft shopping quantities, print | No access |

Read-only accounts cannot save a menu, edit recipes, change stock, record attendance or mutate other operational data. The API enforces this even for direct requests. The Meals screen disables Save Menu and Meal Setup for these accounts. Draft calculations do not write a saved menu.

Administrators open **Accounts** in the sidebar. Creating or resetting another account requires a temporary password, which is not shown again. Give it directly to the authorized person; they must choose a different password on first sign-in. Resetting a password revokes all existing sessions. Disabling an account revokes all sessions, and re-enabling does not restore them. Role changes also revoke sessions. Accounts are retained for audit attribution rather than deleted.

Use **Change password** in the header for your own password. It requires the current password, revokes your other sessions and rotates the current session. Administrators cannot disable themselves or remove their own administrator role. At least one enabled administrator must remain. Maintain a second explicitly authorized administrator if recovery is needed; this phase does not include email recovery or an unauthenticated recovery endpoint.

## Session behavior

- The browser receives a host-only, HttpOnly, SameSite=Strict cookie scoped to `/api`. The cookie is Secure in production.
- The server stores only a SHA-256 digest of the random 256-bit session credential. Passwords use salted Node `scrypt` with N=131072, r=8, p=1 and a 64-byte derived key.
- **Keep me signed in** is optional and unchecked by default. Use it only on a trusted device; anyone using an unlocked signed-in device can use that account.
- Without the checkbox, the existing policy remains: a cookie valid for up to eight hours, with server expiry after 30 minutes without operational API activity. Closing the browser is not a guaranteed sign-out; use **Sign out** on a shared device.
- With the checkbox, the cookie and server session last up to 30 days, with expiry after seven days without operational API activity. Reopening a browser or installed PWA restores access only after a live server authorization check. Background checks never extend idle expiry, and operational activity never extends the absolute deadline.
- Remembered sessions use the same hashed credentials, CSRF protection, roles, revocation and no-store responses. Sign-out, account disabling, role changes and administrator password resets revoke them. Changing your own password revokes old credentials and rotates the current credential while retaining its remembered/ordinary policy.
- Browser and installed PWA cookie stores may be separate; select the option when signing in in each. Private browsing, clearing website data, browser storage eviction or explicit sign-out can remove remembered access. This feature does not provide remote access or offline access to protected records.
- Sign out revokes the current session in PostgreSQL; replaying a copied cookie fails. Other devices remain signed in unless the password, role or enabled status changes.
- Expiry clears the protected screen and unsaved component state, then asks the user to sign in again. Unsaved drafts do not survive sign-out or expiry; save the menu before leaving it.
- Credentials are not kept in localStorage. A non-secret localStorage event refreshes other open tabs after sign-in, sign-out or password changes. A background check also detects cookie changes.
- Mutations require an allowed browser Origin and a session-specific `X-CSRF-Token`. The frontend sends it automatically. CORS allows credentials only for the exact configured origins. GET/HEAD requests may be used by non-browser clients with a valid cookie.
- Sign-in is limited to five attempts per username and twenty attempts per direct client IP per 15-minute window. A successful login resets that username's counter but does not reset the IP counter. Limits are stored in PostgreSQL and return HTTP 429 with `Retry-After`.

Use HTTPS for both frontend and API in production, set `NODE_ENV=production`, and configure explicit HTTPS `APP_ORIGINS`. The frontend and API must be on the same site for SameSite=Strict cookies. The documented VM development setup uses the same hostname/IP and scheme. Express does not trust forwarded IP headers by default; behind a proxy the IP limit is shared by clients behind that proxy until a trusted-proxy deployment configuration is reviewed. TLS deployment, MFA, account recovery and the private-pilot gate are separate work.

## Remembered-session configuration (SKAO-102)

The defaults are 30 days total and seven days idle. Optional settings:

```dotenv
REMEMBER_SESSION_ABSOLUTE_DAYS=30
REMEMBER_SESSION_IDLE_DAYS=7
```

Both must be whole numbers from 1 to 90 and idle cannot exceed total. Invalid settings stop startup. Reducing the total limit also caps existing remembered sessions by their original creation time; changing settings cannot revive an expired or revoked credential. Ordinary session limits remain unchanged.

For a directly run development/server installation, set these in `server/.env` and restart the server. For the existing native Ubuntu deployment, an administrator can set them in the root-only `/etc/skao/native/server.env` and run `bash SKAO.sh restart`. Do not paste that file into chat: it also contains database credentials. Normal native `update` preserves this installed environment file; rerunning `setup` can regenerate it. The defaults work without any configuration edit.

## API reference

All responses containing authentication state have `Cache-Control: no-store`. No password or password hash is included in account responses.

| Method and path | Access and behavior |
|---|---|
| `GET /api/health` | Public, status only |
| `POST /api/auth/login` | Allowed Origin + JSON `{username,password,rememberMe?}` (optional boolean, default false); sets session cookie; returns `{account,csrfToken}` |
| `GET /api/auth/session` | Session cookie; returns account and CSRF token; does not extend idle time |
| `POST /api/auth/logout` | Cookie + CSRF + allowed Origin; revokes session; 204 |
| `POST /api/auth/password` | Cookie + CSRF + allowed Origin; `{currentPassword,password}`; rotates session |
| `GET /api/admin/accounts` | Administrator; sanitized account list |
| `POST /api/admin/accounts` | Administrator + CSRF; `{username,displayName,role,password}`; 201 |
| `PUT /api/admin/accounts/:id` | Administrator + CSRF; `{displayName,role,disabled}` |
| `POST /api/admin/accounts/:id/password` | Administrator + CSRF; `{password}`; 204 |
| `GET /api/admin/audit?limit=25&offset=0` | Administrator; newest events first; maximum 100 per page |
| All other `/api/*` endpoints | Authenticated account that has changed its temporary password; writes require editor or administrator |

Errors use `{error:{message,code}}` where applicable: HTTP 401 for missing/expired sessions, HTTP 403 for insufficient permission or invalid Origin/CSRF, HTTP 429 for sign-in limits. A temporary-password account receives `PASSWORD_CHANGE_REQUIRED` until its password is changed. Domain validation errors retain their existing field details. Internal failures return a generic message without database or credential details.

## Audit and developer notes

Successful account changes, sign-in/out and operational mutations record the actor's account ID, username snapshot, action, record ID where available, and timestamp. Passwords, request bodies, cookies and CSRF/session tokens are excluded. The attendance `recordedBy` field is assigned from the authenticated account, rather than a caller-supplied value.

Operational route handlers use `audited(action, controller)`. This rechecks the session and write permission under the authentication lock, buffers the controller response, and commits the mutation and audit insert in one transaction. If audit insertion fails, the mutation rolls back and returns no success response. Nested catalog and saved-menu operations reuse that transaction. A concurrent disable, password reset or role change cannot pass between this permission check and the write commit. New mutating routes must use the wrapper; do not send a response before committing audit data.

Migration `014-remembered-sessions` adds a non-null `remembered` boolean with default false to existing sessions. It preserves existing accounts, session expiry and operational records; it does not opt anyone in automatically. Apply it with the normal backup/migration process before running the new backend.

Migration `004-accounts-and-sessions` adds `Accounts`, `Sessions`, `LoginAttempts` and `AuditEvents`. It does not modify or seed operational data. The normal application requires migrations before startup. The isolated browser-test fixture is the only executable fixture that installs a known synthetic login, and it explicitly uses an in-memory test adapter.

## Verification

From `server`:

```bash
npm test -- --silent
npm run test:postgres -- --silent
```

From `client`:

```bash
npm run build
npm run lint
npm test
npm run test:browser
```

PostgreSQL tests require the existing separate `TEST_DATABASE_URL` ending in `_test`; they use disposable schemas. The browser suite starts its own isolated backend and frontend on 3009/5179 and uses synthetic accounts. It does not use the development database. Install Chromium with the existing Playwright setup if needed.

The API suite covers unauthenticated routes, read/write roles, account administration, password rotation, CSRF/Origin restrictions, throttling, expiry, logout/replay, and audit rollback. The PostgreSQL suite also reconnects and checks persistent accounts, sessions, audit, counters and revocation. Existing saved-menu restart checks now authenticate their direct API calls. Browser scenarios cover account creation, forced password change, read-only restrictions, logout/replay, account disabling and the previous meal workflows.

For manual verification, create a synthetic account, complete its required first-sign-in password change, verify its role restrictions, then disable it from another administrator session and confirm its access is revoked. Sign out and sign in again with an enabled account. Record results against the tested commit in the pull request or Jira issue.

## Troubleshooting

- **Allowed application address error:** add the exact Windows Chrome frontend origin (scheme, VM IP and Vite port) to `server/.env`, then restart the backend. Do not add a wildcard.
- **Sign-in succeeds but the session is missing:** check the frontend/API use the same VM hostname/IP and scheme, with the correct API port. `localhost` on Windows is not the Ubuntu VM. Production cookies require HTTPS.
- **Security token missing/out of date:** reload the page. Custom API clients must read the token from login/session and send `X-CSRF-Token` with writes, along with the cookie and configured Origin.
- **Too many attempts:** wait for the `Retry-After` period. Restarting the backend does not clear counters.
- **Migrations pending:** stop the backend, run `npm run db:migrate` in `server`, and restart it.
- **No account yet:** run `npm run admin:create` in the Ubuntu terminal after migrating. The empty login screen does not create accounts automatically.

Design references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Remembered-login acceptance on actual devices

Use a synthetic account on the trusted LAN. Browser automation does not replace these actual iPhone/iPad/PWA checks:

1. Sign out, sign in with the checkbox selected, close the browser or installed app fully, and reopen it. Verify that private screens appear only after the server checks the session.
2. Reopen after more than 30 minutes of inactivity. Remembered login should still work. On a test installation, shorten the configured policy or use synthetic test records to verify idle/absolute expiry; never change production records to accelerate a test.
3. Restart the native app services, reopen, and confirm the valid remembered session still works. For restart durability, use PostgreSQL, not the in-memory browser fixture.
4. Sign out, close/reopen and confirm the login screen returns. Sign in as another synthetic user and verify the previous user's unsaved drafts are gone.
5. Disable/change the user's access or reset its password from a separate administrator session; reopen and confirm another login is required. A forced temporary-password change retains the selected policy after choosing the new password.
6. Leave the checkbox unchecked and confirm the previous eight-hour/30-minute policy still applies. Use explicit sign-out when finished.
7. Try reopening while the Pi is unavailable: show the connection screen; do not bypass authentication. Restore the connection and verify the live session or sign-in screen, as appropriate.

Automated checks: `npm test -- --silent` in server, `npm run test:postgres -- --silent` against the separate test database, and `npm run test:browser -- remembered-login.spec.ts` in client. The browser scenario uses a temporary real Chromium profile, closes/reopens it and removes it afterward. It contains only synthetic account data and must never be reused with real accounts. PostgreSQL scenarios cover additive migration, reconnect, a new Node process, and revocation across restarts.
