# Staff clock and shared PIN station

Employees record their work attendance at a registered station. Administrators and editors can also record an individual employee's arrival or departure under **Staff → Clock in/out**. Personal accounts no longer have a My time action; the old `/api/time-clock` read/write routes reject access. Teachers' classroom attendance and child-safety permissions are unchanged.

The station is a separate device identity. It does not sign in as an administrator, editor or employee, and its credential cannot authorize normal application APIs. Only the employee's name, current checked-in/out status and applicable action are shown after a correct PIN. Hours, rates, work history, employee lists, children and documents are not available on the station.

## Set up

1. Apply migration **028-clock-stations** with the normal backed-up update/check workflow. Keep the existing payroll encryption key; do not replace it. The key is also used to derive a separate PIN-lookup secret.
2. Sign in as administrator and open **Staff → Clock station**. Set a unique six-digit PIN for each active employee. A staff record is sufficient; the employee does not need a sign-in account or classroom assignment. Tell the employee their PIN privately. The app does not display an existing PIN again.
3. Create a pairing code with a station name, such as “Front entrance.”
4. On the dedicated tablet, open `/time-clock` at the normal academy HTTPS address. Enter the pairing code before its ten-minute expiry. A pairing code can be used once.
5. Keep the tablet connected to the academy Wi-Fi. The browser retains a restricted HttpOnly station cookie, valid for at most 90 days. An administrator can revoke it immediately or pair a replacement station. Pairing in a browser that has a personal session signs that account out.

Station setup, PIN changes and device revocation are administrator-only. Editors can clock staff in/out but cannot enroll stations, manage PINs or access private pay records. PINs can be reset or disabled without changing the employee's application password.

## Daily use

Enter the personal PIN, confirm the displayed name, then press the single applicable Check in or Check out button. A confirmation appears and the screen clears for the next person. Cancel returns to the PIN screen. Inactivity or hiding the page clears the employee/PIN state. No worked hours or payment amounts are shown.

Admins/editors use the same single applicable action beside an employee under **Staff → Clock in/out**. The server records the current time and who performed the action. Historical corrections and paid-hour approval remain separate reviewed operations. No break logging, automatic deduction or automatic overtime payment is added.

## Reliability and privacy

All station data is handled by the local application server. No vendor cloud or reader hardware is required. The station needs a live connection: an unavailable server must not display a successful punch or queue an offline time change. Report the actual arrival/departure to a manager if the connection fails.

Writes require an allowed Origin and the station's own CSRF token. Identification yields a short-lived grant bound to that station, employee, PIN version, ledger version and action. Replays cannot create duplicate sessions, and concurrent manager/station changes return a conflict for a fresh review. Revocation, PIN reset and employee deactivation take effect on the server. Audit failures roll back the clock change.

Pairing codes and station credentials are stored as hashes. PINs use salted scrypt verification and a keyed lookup; plaintext PINs are not returned or written to audit logs. Persistent request limits protect pairing and PIN entry. PINs and identified employees are held only in page memory, never in localStorage, sessionStorage, IndexedDB or service-worker caches. Restrict physical access to the tablet; employees must keep their PINs private.

The database backup includes station enrollment, revocation, PIN records and attempt limits. Preserve the original payroll key separately as described in [Payroll](payroll.md). This update changes no router or Windows settings.

## HTTP contracts

All responses use `Cache-Control: no-store`. Normal account writes require account CSRF and an allowed Origin. Station writes require the separate station cookie/CSRF; pairing requires an allowed Origin and an unused code.

- `GET /api/work-time/clock`: admin/editor staff clock projection `{staff, timeZone}`.
- `POST /api/work-time/staff/:id/clock`: `{action, version, requestId}`; admin/editor only.
- `GET /api/clock-stations`: administrator-only station metadata and staff PIN-configured flags.
- `POST /api/clock-stations/pairing`: `{name}`; returns `{code, expiresAt}` once.
- `POST /api/clock-stations/:id/revoke`: administrator revokes a device.
- `POST /api/clock-stations/staff/:id/pin`: `{pin}`; six digits to set/reset, `null` to disable.
- `POST /api/station-clock/pair`: `{code}`; sets the device cookie and returns station metadata/CSRF.
- `GET /api/station-clock/session`: station metadata/CSRF only.
- `POST /api/station-clock/identify`: `{pin}`; returns `{staff, checkedIn, version, clockToken}`.
- `POST /api/station-clock/clock`: `{clockToken, action, version, requestId}`.

The app's `/api/time-clock` endpoint and personal clock service functions are deliberately disabled. Adding a station cookie to an ordinary request does not grant account permissions.
