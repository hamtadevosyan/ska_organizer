# Employee time and private payroll (SKAO-106)

Staff records and sign-in accounts remain separate. Link an existing account to an active employee in Accounts; creating an employee does not create an account or grant payroll privileges. Job titles do not grant privileges.

- Every linked active account can open **More → My time**. A classroom assignment is unnecessary for its own work clock. Arrival, departure, paid rest and unpaid meal breaks use server timestamps. Only the applicable action appears. A missing checkout remains unresolved.
- Only administrators can open **More → Staff pay & time**, read or change pay profiles, rates, approvals, corrections, snapshots or payroll files. Editors, teachers and viewers cannot access even their own private pay profile through these routes. They retain their separate operational/class permissions.
- Private profiles contain legal name, payment method/frequency, payroll-provider reference, instructions, masked tax/bank/routing identifiers and required document names. Blank replacement fields keep stored identifiers; clearing requires an explicit checkbox.
- Rates are appended with an effective facility date, reason and actor. Later corrections on the same effective date supersede the earlier rate for new calculations; prior values remain stored. Time corrections retain original clock values and attributed before/after history. Affected daily approvals require review again.
- Daily decisions distinguish actual elapsed time, explicit unpaid breaks and reviewed regular/overtime/double-time hours. Administrators can return a day for correction, add documented premiums/adjustments, and review every change. Scheduled daily minutes never cap actual time. No automatic time rounding or meal deduction is performed.
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

## Verification on Ubuntu

Stop manually running normal client/backend processes, then:

```bash
bash scripts/check-update.sh --payroll
```

This uses the configured separate `_test` PostgreSQL database for synthetic tests, backs up the application database, applies pending migrations, runs the focused server/PostgreSQL/client/browser suites, build, lint and PWA checks. It does not install dependencies, create a production key, commit, push or deploy. `--dry-run` previews commands. Running without a suite flag retains the full project checks. Native tests include encrypted data/file-byte persistence through a new PostgreSQL connection, additive-migration expectations and the existing guarded pg_dump/pg_restore archive round trip extended to cover private profiles, rates, approvals, original clock records, document revisions and calculation snapshots.
