# Employee time and private payroll (SKAO-106)

Staff records and sign-in accounts remain separate. Link an existing account to an active employee in Accounts; creating an employee does not create an account or grant payroll privileges. Job titles do not grant privileges.

- A linked non-administrator employee must be checked in before opening protected account information. Off-clock accounts show the station/administrator check-in message and refresh/sign-out options. Administrators retain clock-management access. See [Employee check-in access](employee-check-in-access.md).
- Employees use the restricted shared PIN station at `/time-clock`. Administrators/editors can clock any active employee under **Staff → Clock in/out**. Personal-account clock actions are disabled. Staff without a sign-in account or classroom can use the station once an administrator assigns a PIN. Clocks use server timestamps; no hours or pay are shown to employees. See [Clock station](time-clock-station.md) for setup, permissions and privacy. No break logging or automatic deduction is added.
- Only administrators can open **More → Staff → Pay & time**, read or change pay profiles, rates, approvals, corrections, snapshots or payroll files. Editors, teachers and viewers cannot access even their own private pay profile through these routes. They retain their separate operational/class permissions.
- Private profiles contain legal name, payment method/frequency, optional employee ID in a payroll service, payday notes, masked employee SSN/bank/routing identifiers and required document names. Payroll policy review controls are under Advanced payroll settings. Blank replacement fields keep stored identifiers; clearing requires an explicit checkbox.
- Rates are appended with an effective facility date, reason and actor. Later corrections on the same effective date supersede the earlier rate for new calculations; prior values remain stored. Time corrections retain original clock values and attributed before/after history. Affected daily approvals require review again.
- Daily decisions keep actual worked time, proposed paid credit, approved paid time and manually chosen rate allocations separate. Administrators explicitly approve decisions and can return a day for correction. Schedules never cap actual work. Original timestamps and completed historical deductions remain intact; no automatic deduction is introduced.
- A period preview lists each day, effective rate, reviewed hours and gross. Missing rates, unapproved/incomplete time, changed policy, underpaid clocked time, negative adjusted gross and unsupported rules block finalization. A saved calculation snapshot is immutable; later source changes are shown when opening it. A snapshot does not execute payment or calculate withholding/net pay.

## Rule boundaries

The gross preview uses the administrator-approved paid time and effective hourly rate. For a reviewed rate change, the administrator enters how many of those paid hours use a chosen multiplier, such as 1× or 1.5×. Remaining paid hours use 1×. The app never chooses 1.5× or allocates overtime hours automatically. It calculates the resulting amount instead of requiring an additional dollar figure. Earlier fixed additional amounts and adjustments remain readable with their original arithmetic until an explicit replacement decision is saved. Daily/weekly/seventh-day review flags and work outside the approved schedule require an explicit administrator overtime decision; an editor confirming that work occurred does not approve its pay.

Completed fractional workdays propose the next whole paid hour: for example, 6 hr 41 min 42 sec proposes 7 paid hours. Exact whole hours remain unchanged and open workdays are not rounded. The administrator can approve the suggestion or enter different paid hours and minutes directly on the day card. **Use full scheduled day** fills the day's saved approved duration, for example 9 hours when an employee was sent home early with full-day pay. Changing the suggestion requires a reason. Paying below recorded time additionally requires explicit confirmation that the clock record is incorrect and the actual hours were verified. No lower amount is applied automatically.

The saved approval records the entered amount, reason, original/proposed time, administrator and current source fingerprint. A clock, schedule, effective rate or applicable rules change requires renewed review. Original clock records and previous decisions remain in history. Incomplete clock records need an actual checkout first; an inline date/time form records missed checkouts in the facility time zone. **Correct checkout time** provides the same form for a completed day with one session. Multiple-session corrections remain in the detailed time section. Daylight-saving ambiguities require an explicit occurrence choice.

Rounding normally shows a review warning. The first short day in the configured workweek is exempt from this rounding warning only when its rounded hours match the captured approved daily window and all recorded work is inside that window. For an approved seven-hour window, a first 6 hr 41 min 42 sec workday proposes 7 paid hours without a rounding warning; a second short day in the same week requires review. The count uses actual worked time, even after paid credit is approved. Earlier duration-only records do not acquire guessed start/end times or this window-based exemption. Other issues and overtime still need their own review.

Potential overtime is identified from actual work, including earlier dates in the configured workweek, rather than from paid credits. Weekly review applies to the day actual cumulative work crosses forty hours and later days; adding a later day does not invalidate an earlier ordinary decision. An actual-time correction or an effective-rate change affecting a reviewed decision requires renewed review. Future rates that do not apply to that workday do not invalidate it. This is a manual gross-pay record, not a payment, withholding calculation or certification of compliance.

California DIR reference for the review threshold: https://www.dir.ca.gov/dlse/faq_overtime.htm. Approved schedule length does not by itself determine whether overtime pay is required. The administrator chooses the reviewed hours, multiplier and reason; the app does not choose a factor.

## Encryption and recovery

Migration **027-employee-payroll** adds `PayrollRecords`. It preserves existing employees, accounts, sessions and operational records. Profile/history, ledger/approvals, complete file revisions and calculation snapshots are AES-256-GCM encrypted before persistence. AAD binds ciphertext to its record ID, staff ID, kind and version. This covers payroll contents in normal PostgreSQL archives. Staff IDs, kinds, versions and timestamps remain database metadata. The key is outside Git and outside the database. The API server must decrypt while serving authorized requests; encryption does not protect against a compromised administrator or server.

For local development, after migration, run from the repository root as the normal Ubuntu user:

```bash
node server/scripts/setup-payroll.js
```

It creates a mode-600 key in `~/.config/skao/payroll.key` and adds `PAYROLL_KEY_FILE` to `server/.env`. It refuses to overwrite a file or generate a replacement for an existing encrypted vault. Restart a manually running backend to pick up the setting. No Windows, router or device settings are changed.

For the managed Ubuntu installation (Pi ARM64 or Ubuntu x86_64), deploy the committed code with the existing updater, then initialize its separate service key:

```bash
bash SKAO.sh update
bash SKAO.sh payroll-init
```

The latter is the explicit privileged initialization/verification command. It checks the migrated database as `skao-api`, creates a key only for an empty vault, stores it at `/etc/skao/native/payroll.key` with mode 400 owned by `skao-api`, updates the root-private service environment and restarts only the API. Home-directory access and the service sandbox remain restricted. An existing key is verified, never rotated or overwritten. Updates retain it. Until configured, payroll returns `PAYROLL_LOCKED`; the rest of the app remains usable.

**Back up the original key to protected offline storage separately from database backups.** A database dump alone cannot recover payroll contents. Do not commit a key, email it, include it in a support bundle or paste it in chat. Do not copy real employee payroll data into development. If deliberately restoring the same encrypted database to a new machine, restore that database's original key too; do not initialize a new key. For a managed host restore the original file to `/etc/skao/native/payroll.key`, set owner `skao-api:skao-api`, mode 400, and run `bash SKAO.sh payroll-init` to verify. Confirm the existing account/profile permissions before reopening access.

Private payroll documents accept validated PDF/PNG/JPEG up to 5 MB per revision. Ten revisions per document and 16 MB plaintext per encrypted aggregate are enforced; a large revision history may reach the aggregate limit earlier. The UI requires explicit downloads; it does not put payroll in offline storage. Downloads and private reads/writes are authorized and audited. The static-only service worker ignores every API route, including payroll and time clock. Badges, biometrics, pay execution, tax filing, automatic schedule enforcement and a self-service pay portal are not included.

## Simple clock and manager extra-time review

Admins/editors open **More → Staff → Work time** to set each employee's approved start and end time in the facility time zone, for example 8:00 AM–5:00 PM. This is a nine-hour window with no inferred deduction. Changes apply today or later to new workdays; an already clocked day retains its captured schedule. Existing hours-only schedules remain readable for older days until start/end times are configured. Dates without a captured window are not assigned guessed times.

On Home, admins/editors see an in-app reminder when a completed workday has work outside its approved start/end times, or exceeds an earlier hours-only allowance. The reminder refreshes at most every 60 seconds while Home is open, and on focus/online. It links to the last 60 days of Work time. It is not an email, SMS or phone push notification. Editors receive a narrow operational projection: staff name, dates, actual arrival/departure, approved schedule, recorded duration, outside time and review decision. Pay rates, identifiers, bank data, payroll documents and finalized pay calculations remain admin-only.

Managers either confirm that the extra time was worked, or correct a verified late clock-out mistake. The latter requires an actual work-end time in the facility time zone, a reason and explicit confirmation that no work was performed after that time. Original clock values and attributed before/after history remain retained; affected paid-hour approval requires renewed review. Same-day tail corrections are supported in this narrow editor flow. Overnight sessions or historical time-zone changes need administrator correction. Ambiguous DST times require selecting an occurrence.

Actual extra work is never removed just because it was not authorized in advance. Confirmed extra time remains in recorded work and still needs an administrator's explicit paid-time and overtime decision. Pending extra-time reviews block finalizing a gross-pay snapshot. An approved daily schedule and an approved paid-hours decision are separate records.

No new SQL migration or encryption key is needed for this follow-up. Work limits/reviews are stored within the existing encrypted ledger; effective work schedules use a separate encrypted profile-kind record. Native archive/reconnect fixtures now include these fields and the schedule record. Physical Ubuntu/PostgreSQL/device verification remains required.


## Verification on Ubuntu

Stop manually running normal client/backend processes, then:

```bash
bash scripts/check-update.sh --payroll
```

This uses the configured separate `_test` PostgreSQL database for synthetic tests, backs up the application database, applies pending migrations, runs the focused server/PostgreSQL/client/browser suites, build, lint and PWA checks. It does not install dependencies, create a production key, commit, push or deploy. `--dry-run` previews commands. Running without a suite flag retains the full project checks. Native tests include encrypted data/file-byte persistence through a new PostgreSQL connection, additive-migration expectations and the existing guarded pg_dump/pg_restore archive round trip extended to cover private profiles, rates, approvals, original clock records, document revisions and calculation snapshots.

### If payroll initialization stops

Run `bash SKAO.sh payroll-check` for a read-only check of the installed release, database and original key as the API service identity. It does not create a key, restart services or change files. Its bracketed diagnostic code distinguishes an outdated/incomplete installed release, missing migrations, database authentication/permissions/connectivity and key access/decryption failures. Raw database errors, credentials and key contents are not printed. A missing original key for existing encrypted records still stops initialization.

`update --local` builds tracked working-tree source files. Newly added SKAO-106 source files must be added to Git before that deployment command can include them; a commit or push is not required for a local deployment. Applying a source patch alone does not change the currently installed release. If the check reports RELEASE_OUTDATED, RELEASE_INCOMPLETE or MIGRATIONS_PENDING, review the tracked SKAO-106 files, run `bash SKAO.sh update --local`, and rerun the check before initialization. For DB or key diagnoses, review the specified local configuration/access issue; never share service configuration files or replace a key for existing data.

## Staff subsections

Staff information, Clock in/out, Work time, and the administrator-only Pay & time and Clock station pages share one Staff entry on desktop and in the phone More menu. Their addresses are `/staff`, `/staff/clock`, `/staff/work-time`, `/staff/payroll`, and `/staff/clock-station`. Existing `/work-time` and `/payroll` bookmarks redirect while preserving the query and fragment. Personal My time actions are disabled; a former `/my-time` bookmark explains using the shared station or a manager. Grouping these screens does not expand account permissions or combine their data requests; private payroll requests remain administrator-only.


## Guided pay calculation

Open **Staff → Pay & time**, then choose an employee. Calculate pay is the default screen:

1. Choose the pay-period start and end dates.
2. If needed, save the hourly rate and its effective date, then explicitly confirm the payroll policy review. Private identifiers and bank fields are optional and are not required to calculate gross pay.
3. Review each day's actual worked time and proposed paid hours. Approve the suggestion or edit the hours/minutes and enter a reason; use **Use full scheduled day** for full-day pay. A verified lower amount requires a clock-error confirmation. Rounding warnings explain actual and proposed amounts directly. The first qualifying short day matching the approved window has no rounding warning; the second and later short days in the workweek require review. For overtime review, enter the hours at the selected rate and its multiplier, then the review reason and explicit confirmation. No overtime factor or allocation is selected automatically. Approved day details collapse to keep the remaining review easy to scan.
4. Choose the single **Calculate pay** button directly below the date fields. It calls the server and brings the result into view below the button. Resolve any server-reported blockers, including any affected earlier workweek dates, pending work-time review or missing administrator overtime decision. Related dates are not included in the selected period's gross amount.
5. Review **Gross pay before taxes**, then choose Save calculation. Actual time is shown as hours, minutes and seconds (for example, `6 hr 41 min 42 sec`); approved paid time shows the rounded amount, for example `7 hr`. Gross pay uses the approved paid hours, saved hourly rate and explicitly selected rate allocation. Existing fixed adjustments remain included and visible. Saved records are under **Saved calculations**. Employee setup remains under **Employee setup & records**, with **Back to pay** to return.

Each daily save refreshes the ledger version before another decision. Chosen pay dates remain selected during daily approval. Changing dates, editing an unsaved form, or entering employee setup clears old results; calculation is disabled until draft changes are saved or discarded. Returning from setup starts a fresh current-week selection and cannot retain an older period's result. Delayed historical-snapshot requests are cancelled when the period changes or setup opens. Server fingerprint checks still reject stale finalization. This is gross-pay calculation and recordkeeping; it does not transfer money or calculate tax withholding.


## Check-in and checkout only

Employees do not log breaks. Employee clock and payroll screens contain no break-entry, break-fix or break-confirmation prompts. Missing checkout is the only unfinished-clock warning. Historical unfinished entries remain unchanged, never block checkout/approval, and never acquire an invented duration or deduction. Completed historical unpaid entries retain their existing arithmetic; paid rest remains paid. No automatic deduction is introduced.

Administrator time corrections omit `breaks` to preserve historical arrays and their metadata byte-for-byte in the ledger. The optional legacy API field remains accepted for compatibility. No record migration or encryption-key change is required. The supported policy/approval, overtime, concurrent-version and snapshot checks remain in place.


## Approved start and end times

New schedules use same-day `HH:mm` start/end times with an end after the start, an effective date, and a reason. The approved window, clocked arrival/departure and manager review are shown separately. A day can need review for work before the start or after the end even when its total is within the approved span. This review threshold never caps recorded work or automatically changes a paid-hours decision.

The encrypted schedule history retains the saved start/end times, derived duration and actor. The ledger captures the effective window on its first clock event for that day. Changing a future schedule cannot erase an older pending review. Duration-only legacy schedules/decisions remain readable; no SQL migration or key change is required. A separate administrator paid-time and overtime review still applies for gross-pay calculation.

## Visible daily pay-review reasons

The pay calculator distinguishes an ordinary day awaiting an administrator's approval from a day with a specific problem. Each day displays its reasons immediately, including missing checkout, missing effective rate, unconfirmed or changed policy, changed clock records, returned decisions, outside-schedule work and overtime allocations. Approved hours with a remaining calculator blocker are shown as needing attention instead of appearing fully ready.

For a straightforward unapproved day, one explicit approval button is visible directly on the card. No adjustment form is needed to understand or approve unchanged recorded time. Overtime still requires an explicit hours/rate decision, reason and confirmation. The selected-rate hours are part of the total approved paid hours, never extra hours added to them. Detailed controls remain available for intentional changes. They never replace an existing decision automatically.

Outside-time actions open Work time with the employee selected and the exact date loaded, including older dates beyond the default recent list. Detailed time actions open the affected day's approval; missing-checkout actions open the relevant unfinished session correction when available. Rate actions prefill the affected date. All summaries are derived from the current authorized response; no review information or new drafts are written to browser storage.


## Repeated short-workday warnings

A completed clocked day counts as short when actual paid time is below that day's captured approved duration. Paid credits do not change this count. The warning begins on the second short day in the configured workweek and lists the actual dates. Each day's rounding warning uses its chronological position, so recording a later second day does not retroactively warn or invalidate the first qualifying day's approval. The count resets at the configured workweek boundary. Incomplete/open days and days without a captured allowance are not treated as completed short days; absence cannot be inferred without attendance records.

Administrators see current-week warnings on Home, relevant workweek warnings in Work time and the private pay view. The Home reminder refreshes while the page is open and on focus, using the existing in-app reminder cycle. It sends no email or phone push. Editors, teachers and viewers do not receive private pay-decision or administrator short-day alert fields. Warnings do not automatically change paid time or impose a deduction.

Earlier saved calculation snapshots remain immutable. An earlier fractional approval below the rounded suggestion needs a new administrator decision before a fresh calculation, unless it already has a current explicit approved-hours override. Old overtime/double-time allocations also require an explicit manual pay decision. Reading a record does not rewrite it. No SQL migration or encryption-key change is required.


## Actual punches and reviewed rate multipliers

Daily cards show each work session in chronological order with the actual check-in and checkout date, time and facility time zone. An overnight session retains its real endpoints; midnight boundaries only explain the portion counted toward the selected day and are never shown as newly recorded punches. Separate sessions stay separate, so gaps are not implied to be worked time. Original records and daily totals are unchanged by this display fix.

A new paid-time decision can allocate part of its approved time to a manually chosen multiplier. For example, 9 approved hours at a $20 hourly rate with 1 hour at 1.5× means 8 hours × $20 + 1 hour × $30 = $190. Choosing 1× means the ordinary hourly rate. The form shows the remaining ordinary hours and resulting gross amount before saving. The rate hours cannot exceed total approved paid time. The server validates the same limits and calculates cents with integer arithmetic.

Previously saved fixed additional-dollar amounts are labeled as earlier decisions. They are not silently converted into a multiplier or discarded when a day is reopened. Replacing such an amount requires an explicit administrator choice and renewed review. Saved calculation snapshots retain their historical figures. A changed clock, schedule, effective rate or applicable rule still requires renewed approval before a fresh final calculation. This follow-up needs no SQL migration, new dependency or encryption-key change.
