# SKAO-55 — Employee documents and training renewals

This patch adds employee paperwork, certificate/training checklists and local expiration reminders. Pay/tax profiles, teacher check-in/check-out and approved-hours payroll are a separate story: [SKAO-106](https://ska-organizer.atlassian.net/browse/SKAO-106).

Apply this on the checkout containing the completed SKAO-47 changes, including its final Share / Print follow-up. The patch checks every change before writing and keeps conflicting local edits intact. No dependencies changed.

## Apply and check on Ubuntu

Extract the ZIP into Downloads. Stop your normal client/server development processes, then run these commands from your ska_organizer checkout:

```bash
bash ~/Downloads/SKAO-55-employee-documents/apply-fix.sh
bash scripts/check-update.sh
```

The check-update script uses your existing server/.env, backs up the real database and verifies the archive, then applies pending migrations before running the tests, build, lint and browser checks. Keep the backup. Native PostgreSQL tests use the separate test database; do not change TEST_DATABASE_URL to your real application database.

Migration 020 adds employee documents, immutable file/date revisions and the reminder setting, and allows employee requirements without blank files. Existing staff IDs, room assignments, child documents and login accounts are preserved. Backup format 4 includes employee documents/settings and retains support for earlier backup manifests.

## Set up the required list

1. As an administrator, open **Registration forms**, add a form/requirement and choose **Employees**.
2. Enter a clear name such as CPR certificate or Required training. Mark it required if every active employee must provide it. Select **Expiration date required** when it must be renewed.
3. A blank file is optional for employee requirements. For an externally issued certificate, save the requirement without uploading a placeholder. Child/facility templates still need their blank files.
4. Open **Staff**, then **Documents & training** for the employee. Attach the completed document to its checklist item, enter its issue/expiration dates and save.
5. Review the uploaded file and its dates, check the confirmation and choose **Mark reviewed**. Merely uploading a file does not complete a required item.

The checklist follows the required active employee items you configure. All active employees use that list. Optional items do not prevent completion. An empty required list remains unconfigured rather than reporting 100% completion. Inactive employees keep their history and are excluded from facility reminders.

## Expiration reminders

The default is **40 calendar days**. In the employee documents panel, administrators can change the facility default to 30 days or another whole number from 1–365. A document's optional reminder override uses the same range; leave it empty to use the facility default.

Home and Staff show missing, expired, expiring, outdated and awaiting-review requirements. Staff reminders can be searched, filtered and paged. The most urgent expired/expiring items appear first. Select an employee's reminder to open the appropriate record and request the employee to provide the missing paperwork or renewed training.

Dates use the server's facility time zone. A certificate is valid through its listed expiration date: it shows **Expires today** on that date and **Expired** the following day. The warning includes the day exactly 40 days before expiry. A non-expiring document requires an explicit **Does not expire** choice; that choice cannot satisfy an expiration-required item.

These are local application alerts, not email, SMS or operating-system push notifications. Opening Home/Staff checks current records. Successful local changes refresh the overview; open pages also refresh on focus and periodically. Changes from another device appear on refresh/focus. The server derives status from current records, so restarting it catches up without a reminder queue.

## Renewals, access and files

Use **Upload new version** to renew a certificate. Enter the new dates and upload its evidence. Previous bytes and dates remain in version history; the new version requires review before it completes the requirement. Correcting metadata also creates an attributed revision and clears review. Stale saves preserve the draft and require reloading the latest record.

Administrators manage and view private files, notes, issuer/reference details and history. Editors see only employee/requirement names, status and dates needed for follow-up. Read-only accounts have no compliance or employee-document access. Staff records remain separate from sign-in accounts.

Files stay in PostgreSQL and use the existing local PDF/image preview. Supported evidence is PDF/JPG/PNG up to 5 MiB. Supported phone cameras offer photo confirmation and an upload fallback. Each employee can retain up to 100 documents and each document up to 100 revisions. The app does not send these files outside the local server or cache its API responses in the PWA.

Remaining selective PDF upload failures are tracked separately in [SKAO-105](https://ska-organizer.atlassian.net/browse/SKAO-105). This patch reuses that validator and does not claim to solve every PDF compatibility issue. Multi-page camera composition and external reminder delivery remain future work.

## Quick manual test

Use synthetic records/files first:

1. Create a required employee certificate with no blank file. A newly created employee should show its missing document immediately.
2. Upload evidence expiring in 40 days. Check its file/dates, mark it reviewed, and verify the renewal warning on Home and Staff. An expiry 41 days away should not warn with the default setting.
3. Renew it with a later expiry, review the new copy, and verify the old file/date history remains while the warning clears. Correct a date and verify review is required again.
4. Test an expired file, an explicitly non-expiring document, a 30-day default, and a per-document override.
5. Verify an editor sees safe reminders but cannot open private files, and a read-only account sees no compliance area. Sign out with a preview open and confirm it clears.
6. Restart PostgreSQL/server and verify employee evidence, history, reviews and reminder settings persist. The native PostgreSQL migration/archive/restart checks still need to run in your Ubuntu environment.

After reviewing and passing your checks, commit, push and merge from Ubuntu using your normal workflow. Then pull development on the Pi and run:

```bash
bash SKAO.sh update
```

No commit, push, merge, deployment, router/device/system-setting change or real database migration was performed while preparing this bundle.
