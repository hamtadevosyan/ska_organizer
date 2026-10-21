# SKAO-106 — Staff pay, tax records and time clock

This bundle contains the implementation, migration 027, tests and operating instructions. It requires the completed SKAO-111 changes, including staff/account links. No new npm dependencies are introduced. Applying the bundle does not commit, push, deploy, change system settings or create real employee/payroll data.

## 1. Apply on Ubuntu development

Extract `SKAO-106-staff-payroll.zip` into Downloads. Start from your latest development branch after SKAO-111 has been merged. Preserve any local edits reported by `git status`; do not reset them.

```bash
cd ~/workspace/ska_organizer
git status --short
git switch development
git pull --ff-only
git switch -c feature/SKAO-106-staff-payroll
bash ~/Downloads/SKAO-106-staff-payroll/apply-fix.sh
```

If the SKAO-106 branch already exists, use `git switch feature/SKAO-106-staff-payroll` instead of `git switch -c`. Do not commit this task under SKAO-111. If the patch is incompatible, it stops before applying anything. Do not force it, overwrite files from `files/`, reset or discard local work. `files/` is provided for review, not blind copying over another checkout.

## 2. Back up, migrate and test

Stop the regular client/backend terminals. Ensure server/.env still identifies the application database and a different TEST_DATABASE_URL ending in `_test`; do not use the real database for synthetic tests. Use the existing installed project dependencies, Playwright Chromium and PostgreSQL client tools.

```bash
bash scripts/check-update.sh --payroll
```

The script backs up the configured database, checks the archive, applies pending migrations, runs focused mock/PostgreSQL/client/browser suites, builds, lints and runs PWA privacy checks. It stops at a failed step and keeps the backup. No database reset or automatic rollback is performed. Use `--dry-run` first to inspect the commands. Run without `--payroll` if you want all project checks.

Review VERIFICATION.md for checks run while preparing this package. Native PostgreSQL, real Ubuntu service activation, physical iPhone/iPad and ARM64 checks remain for your environment.

## 3. Initialize a development encryption key

After migration and before entering private payroll data, run as your normal Ubuntu development user:

```bash
node server/scripts/setup-payroll.js
```

This creates a private key outside the checkout and adds PAYROLL_KEY_FILE to server/.env. Restart the backend. An existing key is verified, never overwritten. A new key is refused if encrypted payroll records already exist. Back up the original key to protected offline storage separately from database backups. Never commit it or paste it in chat. A database archive without the matching original key cannot recover the payroll contents.

For manual development startup, use separate terminals from the repository root:

```bash
npm --prefix server start
```

```bash
npm --prefix client run dev
```

## 4. Try the workflow with fictional data

1. As admin, create/select an employee in Staff. Link an existing sign-in account to that employee in Accounts. A cleaner or other employee does not need a classroom to use their own clock. Staff creation alone does not create sign-in access.
2. Sign in as that employee. Open **More → My time**. Check in, start/end a paid rest or unpaid meal break, and check out. Only the applicable action is offered. A duplicate arrival, overlapping session or checkout during an open break is rejected.
3. As admin, open **More → Staff pay & time** and choose that employee. Configure the private profile, payment method/frequency/provider reference, required payroll document names and the verified rule reference. Enter only fictional tax/bank values for testing. Reopened identifiers are masked; blank replacements keep them.
4. Under **Hourly rates**, add an effective rate with a reason. New entries retain old rates. The rate effective on each facility work date is used for new calculations.
5. Under **Time & approvals**, inspect raw work and breaks. Correct erroneous times with a reason if necessary, preserving the originals. Open each workday, review actual paid time, regular/overtime/double-time allocations and any premium/adjustment, then approve or return it. Changed time or policy requires renewed approval. Scheduled minutes never cap actual worked time.
6. Under **Pay preview**, choose the period and calculate. Resolve all blockers before saving a finalized calculation snapshot. Reload and reopen it. A later rate/time correction flags changed source records while retaining the historical calculation unchanged.
7. Under **Payroll documents**, upload a fictional validated PDF/PNG/JPEG, then add a revision to that document. Required names appear missing until a matching uploaded document exists. Download both revisions and verify their contents.
8. Repeat as editor, teacher and viewer: My time is only their own linked employee. Staff pay/tax/bank/files/approvals remain admin-only, including direct URLs and API requests. Existing child safety, classroom and operational permissions remain separate.

The calculator is a reviewed gross-pay preview, not an automatic payroll/tax/payment service. Standard midnight-based California non-exempt USD allocations have tested daily/weekly/seventh-day guardrails. Unsupported rules, mixed-rate overtime, missing/changed approvals, missing checkout/rate, negative adjusted gross and under-approved clocked time block finalization. Confirm the applicable rules with your payroll provider. Taxes, withholding, payment execution, badges and biometrics are not included. See docs/payroll.md for precise boundaries and recovery.

## 5. Review and commit yourself

After your checks and manual review:

```bash
git diff --check
git status --short
git add client server scripts docs
git commit -m "SKAO-106 add private payroll records and employee time clock"
git push -u origin feature/SKAO-106-staff-payroll
```

Review the staged files first if you have unrelated changes. Open the PR to development, verify CI, then merge yourself. No commit, push or merge was performed by this package.

## 6. Update the managed Ubuntu/Pi host after merge

Pull/deploy through the existing updater; no push from the Pi is needed:

```bash
bash SKAO.sh update
bash SKAO.sh payroll-init
```

The explicit payroll-init command uses sudo to verify/create the service key at `/etc/skao/native/payroll.key`, owned by skao-api with mode 400, updates the private service environment and restarts only the API. It does not loosen the service sandbox or change router/phone settings. It refuses to replace an existing key or create a key for existing encrypted data. Keep that host's key separately backed up. Existing updates preserve it; payroll stays locked until initialized. Do not point the managed service at the development user's home key.

If restoring an encrypted database onto another host, restore its original key first; do not create a new one. See docs/payroll.md. The scripts use the same native service setup on Ubuntu ARM64 and x86_64; no Pi-specific hardware API or Docker is required.
