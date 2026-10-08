# SKAO-47 browser fixture session fix

This follow-up changes the browser-test fixture and adds a lifecycle regression. Apply after the SKAO-47 template-groups update, from the repository root:

```bash
bash ~/Downloads/SKAO-47-browser-session-fix/apply-fix.sh
bash scripts/check-update.sh
```

The existing retained database backup is kept. This patch changes no application authentication policy, document permissions, dependencies, database schema, deployment or system settings.

The layout-test helper transfers only its cached synthetic cookie as a browser-session cookie, avoiding an absolute expiration timestamp from another context's clock. The real backend still validates the original session, expiry, revocation and CSRF token. A 401 fails; the helper never silently logs in again. A missing cookie is reported separately from a server-rejected session. Remembered-login tests still verify the actual ordinary and remembered cookie lifetimes.

The new isolated browser regression simulates old exported cookie metadata, authenticates through the real API in another browser context, then logs out on the backend and proves cached replay is rejected without another login. Its cache is separate from screen tests.

Use your usual review, commit, push and merge workflow on Ubuntu after all checks pass. The Pi only needs to pull the merged development branch and run `bash SKAO.sh update`.
