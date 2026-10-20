# SKAO-111 — Teacher attendance and health/emergency access

This update adds a separate Teacher role. Class viewers stay read-only. Teachers can record today's arrivals/departures and read reviewed safety information for active children in their assigned active class. Administrators maintain the safety cards. Contracts, full uploaded medical files, staff, inventory and menu generation stay restricted.

## Apply in your Ubuntu development checkout

Extract the ZIP into Downloads first. Preserve any local work shown by `git status --short`; do not reset or discard it.

Continue on the existing branch; do not create another branch:

```bash
cd ~/workspace/ska_organizer
git status --short
git switch feature/SKAO-111-class-access
bash ~/Downloads/SKAO-111-teacher-access/apply-fix.sh
```

Preserve local edits. The installer checks compatibility before applying and does not reset files. The staff-account follow-up has its own ZIP and START_HERE instructions; apply it after this Teacher update.

No dependency versions change. No commit, push, deployment, router setting or machine security setting is changed by applying the bundle.

## Back up, migrate and check

Stop the normal client/server terminals and run from the checkout root as your normal user:

```bash
bash scripts/check-update.sh --access
```

This backs up and checks the configured application database, applies pending migrations and runs focused permissions, safety, attendance, PostgreSQL, client and browser checks plus build/lint. Keep the application and `_test` database settings separate. Do not reseed or recreate the database. Review `VERIFICATION.md` for what was actually executed while preparing this ZIP.

Migration 025 preserves existing accounts, sessions and child records and does not promote viewers. If migration 024 is still pending, its one-time viewer sign-out still applies. Existing accounts must be explicitly changed to Teacher by an administrator. An existing Editor account retains facility-wide operational editing until its role is changed; review the roles of current teacher accounts.

## Try the feature

1. As administrator, open Children → View profile → Health & emergency → Edit safety card. Enter current allergy, emergency, care and pickup details. Confirm review and save. Keep unconfirmed details marked unknown.
2. In Accounts, create or manage an account, choose Teacher and assign its active class. Changing access signs that account out. Complete any first-login password change.
3. As Teacher, open Children (under More on a phone), then Health & emergency. Confirm the reviewed card is available without administrator assistance, with no edit or document controls.
4. Open Attendance. Check a synthetic child in, refresh, then check them out. Verify only that class appears. Adult signatures remain a separate facility process; these buttons record staff attendance actions.
5. Verify another class's child/safety card is inaccessible. A Class viewer must still have no health or attendance actions. Reassignment must sign the Teacher out and clear the old class. An archived/unassigned class must show no records.
6. As editor, verify safety cards can be read but not edited. Check that normal admin/editor workflows still work. Maintain a protected physical emergency backup for server/power outages.

Run all checks before merging:

```bash
bash scripts/check-update.sh
```

## Review, commit and push from development Ubuntu

```bash
git diff --check
git diff --stat
bash ~/Downloads/SKAO-111-teacher-access/stage-changes.sh
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "SKAO-111 Add scoped teacher attendance and safety cards"
git push -u origin HEAD
```

Review the staged diff before committing, including earlier edits inside those same paths. The staging helper stages task paths only. After merging to development, pull and run the usual `bash SKAO.sh update` on the Pi. Keep development and pushes on your Ubuntu development machine.

Other-class emergency override, multiple simultaneous classes, electronic parent signatures and badge/payroll work are separate follow-ups; they are not silently granted by Teacher access.
