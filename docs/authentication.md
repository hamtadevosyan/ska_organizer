# Sign-in and account administration (SKAO-20)

The organizer now requires an explicitly authorized account. PostgreSQL stores accounts, password hashes, revocable sessions, sign-in attempt counters and audit events. Existing meals, recipes and saved weeks remain intact. Staff records do not create accounts, and there is no public registration or parent portal.

## One-time setup on Ubuntu VMware

Run these steps from your existing checkout after importing the SKAO-20 branch. Keep your current `server/.env`, database password and data. Use your normal database backup procedure before applying the migration; do not reseed or recreate the database.

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
- Sessions expire after 30 minutes without operational API activity or after eight hours in total. Background session checks do not extend the idle timeout.
- Sign out revokes the current session in PostgreSQL; replaying a copied cookie fails. Other devices remain signed in unless the password, role or enabled status changes.
- Expiry clears the protected screen and unsaved component state, then asks the user to sign in again. Unsaved drafts do not survive sign-out or expiry; save the menu before leaving it.
- Credentials are not kept in localStorage. A non-secret localStorage event refreshes other open tabs after sign-in, sign-out or password changes. A background check also detects cookie changes.
- Mutations require an allowed browser Origin and a session-specific `X-CSRF-Token`. The frontend sends it automatically. CORS allows credentials only for the exact configured origins. GET/HEAD requests may be used by non-browser clients with a valid cookie.
- Sign-in is limited to five attempts per username and twenty attempts per direct client IP per 15-minute window. A successful login resets that username's counter but does not reset the IP counter. Limits are stored in PostgreSQL and return HTTP 429 with `Retry-After`.

Use HTTPS for both frontend and API in production, set `NODE_ENV=production`, and configure explicit HTTPS `APP_ORIGINS`. The frontend and API must be on the same site for SameSite=Strict cookies. The documented VM development setup uses the same hostname/IP and scheme. Express does not trust forwarded IP headers by default; behind a proxy the IP limit is shared by clients behind that proxy until a trusted-proxy deployment configuration is reviewed. TLS deployment, MFA, account recovery and the private-pilot gate are separate work.

## API reference

All responses containing authentication state have `Cache-Control: no-store`. No password or password hash is included in account responses.

| Method and path | Access and behavior |
|---|---|
| `GET /api/health` | Public, status only |
| `POST /api/auth/login` | Allowed Origin + JSON `{username,password}`; sets session cookie; returns `{account,csrfToken}` |
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

Use synthetic child/staff data until this story and the private-pilot release gate are verified and merged. Keep SKAO-20 in Review until native PostgreSQL, actual Chromium execution and the PR merge are complete. See `docs/skao-20-verification.md` for the handoff's measured results and remaining checks.

## Troubleshooting

- **Allowed application address error:** add the exact Windows Chrome frontend origin (scheme, VM IP and Vite port) to `server/.env`, then restart the backend. Do not add a wildcard.
- **Sign-in succeeds but the session is missing:** check the frontend/API use the same VM hostname/IP and scheme, with the correct API port. `localhost` on Windows is not the Ubuntu VM. Production cookies require HTTPS.
- **Security token missing/out of date:** reload the page. Custom API clients must read the token from login/session and send `X-CSRF-Token` with writes, along with the cookie and configured Origin.
- **Too many attempts:** wait for the `Retry-After` period. Restarting the backend does not clear counters.
- **Migrations pending:** stop the backend, run `npm run db:migrate` in `server`, and restart it.
- **No account yet:** run `npm run admin:create` in the Ubuntu terminal after migrating. The empty login screen does not create accounts automatically.

Design references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
