# Employee time and private payroll (SKAO-106)

Staff records and sign-in accounts remain separate. Link an existing account to an active employee in Accounts; creating an employee does not create an account or grant payroll privileges. Job titles do not grant privileges.

- Every linked active account can open **More → My time**. A classroom assignment is unnecessary for its own work clock. Only check-in/check-out status and the applicable clock action are shown; employee pages and their status API omit worked hours, timestamps, session history and pay totals. Clock actions use server timestamps. Missing checkouts remain unresolved. No break logging or break-fix action is required; no automatic meal deduction is performed.
- Only administrators can open **More → Staff → Pay & time**, read or change pay profiles, rates, approvals, corrections, snapshots or payroll files. Editors, teachers and viewers cannot access even their own private pay profile through these routes. They retain their separate operational/class permissions.
- Private profiles contain legal name, payment method/frequency, optional employee ID in a payroll service, payday notes, masked employee SSN/bank/routing identifiers and required document names. Payroll policy review controls are under Advanced payroll settings. Blank replacement fields keep stored identifiers; clearing requires an explicit checkbox.
- Rates are appended with an effective facility date, reason and actor. Later corrections on the same effective date supersede the earlier rate for new calculations; prior values remain stored. Time corrections retain original clock values and attributed before/after history. Affected daily approvals require review again.
- Daily decisions distinguish actual elapsed time, completed historical deductions and reviewed regular/overtime/double-time hours. Administrators can return a day for correction, add documented premiums/adjustments, and review every change. Scheduled daily minutes never cap actual time. No automatic time rounding or meal deduction is performed.
- A period preview lists each day, effective rate, reviewed hours and gross. Missing rates, unapproved/incomplete time, changed policy, underpaid clocked time, negative adjusted gross and unsupported rules block finalization. A saved calculation snapshot is immutable; later source changes are shown when opening it. A snapshot does not execute payment or calculate withholding/net pay.

## Rule boundaries

The supported gross preview is a manually reviewed standard California non-exempt allocation in USD, using midnight-to-midnight workdays in the facility time zone. Choose Other rules and use provider review if the defined workday differs. Its guardrails cover regular hours over eight/day or forty/workweek, double time above twelve/day, and seventh-day allocation. Workweek context includes recorded days outside the selected pay period. Mixed hourly rates with overtime in a workweek require payroll-provider calculation; other classifications/rules explicitly block finalization. Bonuses, weighted regular rates, exemptions, wage-order exceptions, split shifts, unusual schedules, tax withholding and actual payments are outside this calculator. A final snapshot is a reviewed calculation record, not a certification of legal compliance.

An administrator must verify the applicable classification and workday/workweek, breaks, premiums and adjustments and enter a reviewer reference before finalizing. Review each day's actual records, including any missed meal/rest premium or paid on-duty meal; the software does not infer a compliant break from silence. Paid rest remains paid. Do not use an unpaid break unless the employee is relieved of duty.

Primary references checked during implementation:
- California DIR overtime: https://www.dir.ca.gov/dlse/faq_overtime.htm
- Meal periods and on-duty/paid meals: https://www.dir.ca.gov/dlse/FAQ_MealPeriods.htm
- Paid rest periods: https://www.dir.ca.gov/dlse/FAQ_RestPeriods.htm

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

Actual extra work is never removed just because it was not authorized in advance. Confirmed extra time remains in recorded work and still needs administrator payroll approval/overtime allocation. Pending extra-time reviews block finalizing a gross-pay snapshot. An approved daily schedule and an approved paid-hours decision are separate records.

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

Staff information, Work time, and the administrator-only Pay & time page share one Staff entry on desktop and in the phone More menu. Their addresses are `/staff`, `/staff/work-time`, and `/staff/payroll`. Existing `/work-time` and `/payroll` bookmarks redirect while preserving the query and fragment. Employee My time stays separate. Grouping these screens does not expand account permissions or combine their data requests; private payroll requests remain administrator-only.


## Guided pay calculation

Open **Staff → Pay & time**, then choose an employee. Calculate pay is the default screen:

1. Choose the pay-period start and end dates.
2. If needed, save the hourly rate and its effective date, then explicitly confirm the payroll policy review. Private identifiers and bank fields are optional and are not required to calculate gross pay.
3. Review each recorded day. For an ordinary completed day, confirm the hours/overtime review and choose Approve recorded hours. Exact recorded milliseconds are retained; schedules do not cap paid time. The simplified approval is unavailable for apparent daily/weekly/seventh-day overtime or an existing adjustment. Those cases open the existing detailed review instead.
4. Choose Calculate gross pay. Resolve any server-reported blockers, including related workweek days outside the selected dates or pending extra-time reviews in Work time. Related dates are not included in the selected period's gross amount.
5. Review **Gross pay before taxes**, then choose Save calculation. The result remains visible and is available in saved snapshots.

Each daily save refreshes the ledger version before another decision. Chosen pay dates remain selected. Changing dates or editing an unsaved form clears old results; calculation is disabled until draft changes are saved or discarded. Delayed historical-snapshot requests are cancelled when the period changes. Server fingerprint checks still reject stale finalization. This is gross-pay calculation and recordkeeping; it does not transfer money or calculate tax withholding.


## Check-in and checkout only

Employees do not log breaks. Employee clock and payroll screens contain no break-entry, break-fix or break-confirmation prompts. Missing checkout is the only unfinished-clock warning. Historical unfinished entries remain unchanged, never block checkout/approval, and never acquire an invented duration or deduction. Completed historical unpaid entries retain their existing arithmetic; paid rest remains paid. No automatic deduction is introduced.

Administrator time corrections omit `breaks` to preserve historical arrays and their metadata byte-for-byte in the ledger. The optional legacy API field remains accepted for compatibility. No record migration or encryption-key change is required. The supported policy/approval, overtime, concurrent-version and snapshot checks remain in place.


## Approved start and end times

New schedules use same-day `HH:mm` start/end times with an end after the start, an effective date, and a reason. The approved window, clocked arrival/departure and manager review are shown separately. A day can need review for work before the start or after the end even when its total is within the approved span. This review threshold never caps recorded work or automatically changes a paid-hours decision.

The encrypted schedule history retains the saved start/end times, derived duration and actor. The ledger captures the effective window on its first clock event for that day. Changing a future schedule cannot erase an older pending review. Duration-only legacy schedules/decisions remain readable; no SQL migration or key change is required. A separate administrator paid-hours review still applies for gross-pay calculation and overtime.

## Visible daily pay-review reasons

The pay calculator distinguishes an ordinary day awaiting an administrator's approval from a day with a specific problem. Each day displays its reasons immediately, including missing checkout, missing effective rate, unconfirmed or changed policy, changed clock records, returned decisions, outside-schedule work and overtime allocations. Approved hours with a remaining calculator blocker are shown as needing attention instead of appearing fully ready.

For a straightforward unapproved day, the confirmation checkbox and approval button are visible directly on the card. No adjustment form is needed to understand or approve unchanged recorded time. Detailed allocation and adjustment controls remain available for intentional changes. They never replace an existing decision automatically.

Outside-time actions open Work time with the employee selected and the exact date loaded, including older dates beyond the default recent list. Detailed time actions open the affected day's approval; missing-checkout actions open the relevant unfinished session correction when available. Rate actions prefill the affected date. All summaries are derived from the current authorized response; no review information or new drafts are written to browser storage.
