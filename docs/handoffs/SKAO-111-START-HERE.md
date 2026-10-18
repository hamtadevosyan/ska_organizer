# SKAO-111 — Class viewer access

This update gives Class viewers a dedicated assigned-class area and blocks global operational APIs and planning. Accounts can be assigned to one active class. Existing viewers are signed out once during migration and have no inferred assignment. Administrator/editor sessions and operational data are retained.

## Apply on Ubuntu development

Keep local work before switching branches. If `git status --short` shows changes, commit them on their correct branch or otherwise preserve them first. Do not discard unrelated changes.

```bash
cd ~/workspace/ska_organizer
git status --short
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-111-class-access
bash ~/Downloads/SKAO-111-class-access/apply-fix.sh
```

Unzip the download first. Adjust only the Downloads path if your browser extracted it elsewhere. If this feature branch already exists, use `git switch feature/SKAO-111-class-access` instead of the `git switch -c` command. The apply script requires a branch containing `SKAO-111`, checks the entire patch before changing files and refuses conflicts. It supports the completed SKAO-59 base with or without the earlier test-session correction. It does not commit, push, install packages, deploy or change system settings.

## Back up, migrate and test

Stop the normal frontend/backend terminals, then run:

```bash
bash scripts/check-update.sh --access
```

The script uses existing `server/.env` database settings, creates and verifies a backup, applies migration 024 and runs focused API, PostgreSQL, component and browser checks plus build/lint. Both configured databases must remain separate. Run as your normal Ubuntu user. Do not seed or recreate the database. Existing dependencies are sufficient; no dependency versions change in this update.

Migration 024 adds the class assignment and revokes existing viewer sessions once. Passwords, accounts and application records remain. Existing administrator/editor sessions remain. Repeating migrations does not repeat that logout. New role or class changes revoke all sessions for the changed account.

After the focused check, run the full checks before merging:

```bash
bash scripts/check-update.sh
```

If a check fails, later steps stop and the backup is retained. Keep the failure output. No automatic rollback is performed. See `VERIFICATION.md` for checks actually run on this rebuilt package and remaining environment/device checks.

## Test the access behavior

Start your normal development client and server. As administrator, open **Accounts**, create or manage a synthetic account, choose **Class viewer** and select an **Assigned class**. Save and sign into that account in a separate browser context. New/reset accounts must first change their temporary password.

1. Use two classes with different synthetic children and saved weekly activities. Each viewer sees only the assigned class's active children's basic names and saved activities.
2. The meals tab shows saved shared academy meal names. It has no menu generation, stock, editing or saving actions.
3. Old links to Children, Staff, Inventory, Reports, Attendance, Activities or Meals redirect to the class area. Direct legacy API requests return 403.
4. **No class assigned** shows no records. Archiving the assigned class also shows no records. No class is selected automatically.
5. Reassign a viewer from another administrator session. The viewer is signed out; signing in again shows only the new class. Check phone/PWA and desktop layouts.
6. Verify administrator/editor workflows remain available with their existing permissions.

Facility-wide read-only access, time-clock-only accounts and badges are proposed in `docs/staff-access-design.md`; they are not part of this implementation.

## Review, commit and push from development Ubuntu

```bash
git diff --check
git diff --stat
bash ~/Downloads/SKAO-111-class-access/stage-changes.sh
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "SKAO-111 Restrict class viewers to assigned class"
git push -u origin HEAD
```

Review the staged diff before committing. The staging helper adds only paths listed in `FILES.txt`; it cannot distinguish unrelated edits inside those same files, so review them. Create and merge the PR into `development` after your checks. On the Pi, pull the merged development branch and use the existing `bash SKAO.sh update` process. Do not develop or push from the Pi.
