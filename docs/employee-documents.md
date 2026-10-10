# Employee documents and expiration tracking — SKAO-55

Administrators choose **Add employee requirement** on Staff or Registration forms, enter **Certificate or document name**, and save without uploading a template. Employees and **Required for every active employee** are preselected. A blank form is optional; attach one only when available. Choose **Expiration date required** for a certificate that must be renewed. Child/facility templates still require a file. The `expirationRequired` flag applies only to employee requirements and defaults to false for existing templates. Required active employee requirements apply to active staff; an empty catalog remains unconfigured.

On phones, open **More → Staff**. Every directory account can choose **View details** to see the staff member's name, job role, room and active status. Administrators use **Documents & training** for the evidence/checklist; editors retain minimal reminder summaries and read-only users have no employee-document access. Viewing basic details preserves open unsaved document drafts. See [the incremental requirement/mobile update](SKAO-55_REQUIREMENTS_START_HERE.md) for applying this refinement on the SKAO-55 branch.

Staff evidence is stored privately in PostgreSQL `StaffDocuments` / `StaffDocumentRevisions`, linked to stable `StaffMembers` IDs. Immutable revisions retain original file bytes and metadata including issue/expiry dates, issuer/reference, non-expiring choice and warning override. Metadata corrections create byte-preserving revisions; renewals upload new bytes. Both reset current review. A current, reviewed requirement is complete while valid, including its warning window. Missing, unreviewed, outdated, invalid-expiry or expired evidence prevents completion.

The facility setting defaults to 40 days, with a configurable 1–365-day value and a nullable per-document override. Status uses calendar dates in FACILITY_TIME_ZONE, default America/Los_Angeles. Expiry is inclusive through the listed date; the next day is expired. Reminder dates and current statuses are derived during reads rather than queued deliveries, so renewals/settings edits/deactivation/restarts cannot leave obsolete scheduled email reminders.

When an administrator selects an evidence file, the upload form reads it locally and suggests explicitly labelled expiration dates. The administrator must choose a suggested date or enter the date themselves; detection never silently changes saved metadata, derives an expiry from a completion date, or approves evidence. Ambiguous numeric dates and documents without a readable expiration label need manual entry. A renewal starts with its new expiration date unset, while the old date remains in history.

The upload form offers reminder presets and a custom 1–365-day window, shows the calculated calendar date, and retains the override after saving. A blank override follows the facility default. Home/Staff reminders apply to required employee requirements for active staff; unassigned files do not create reminders. Evidence still requires review. These are local in-app reminders, not email or phone push notifications.

PDF text is extracted with the existing bundled PDF.js worker and local font assets. Photos and scanned PDF pages use local-server Tesseract with fixed options and bounded input, output and execution time. The analyzer checks at most the first five PDF pages and identifies partial checks; unreadable, encrypted, unsupported or ambiguous documents fall back to manual entry. Original evidence is uploaded separately and retained unchanged. No OCR text is stored, placed in audit messages or sent to an external service. Existing PDF compatibility limitations remain SKAO-105.

Home and Staff show local reminders to admins/editors. The summary DTO contains only employee/requirement IDs and names, status, expiration date, days remaining and reminder timing; it excludes private document IDs, filenames, issuer/reference, notes, file bytes and reviewer/history details. Read-only accounts cannot access the summary. Files/checklists/history/mutations remain admin-only regardless of legacy document grants.

| API | Access and result |
| --- | --- |
| `GET /api/staff-compliance` | Admin/editor; actionable required employee summaries, totals, facility date/time zone and configuration status |
| `GET /api/staff-compliance/settings` | Admin/editor; default warning days and settings version |
| `PUT /api/staff-compliance/settings` | Admin; warning days plus optimistic settings version |
| `GET /api/staff/:staffId/documents` | Admin; paged document metadata |
| `GET /api/staff/:staffId/documents/checklist` | Admin; employee requirement checklist and private evidence/review details |
| `GET /api/staff/:staffId/documents/:documentId` | Admin; metadata and paged immutable revision history |
| `POST /api/staff/:staffId/documents` | Admin; idempotent initial evidence upload |
| `POST /api/staff/:staffId/documents/expiration-check` | Admin; bounded local OCR of a resized PNG; ephemeral text for date suggestions, no document creation |
| `PUT /api/staff/:staffId/documents/:documentId` | Admin; optimistic metadata correction with a new revision |
| `POST /api/staff/:staffId/documents/:documentId/revisions` | Admin; idempotent renewal/replacement upload |
| `PUT /api/staff/:staffId/documents/:documentId/review` | Admin; review or clear review with optimistic version |
| `GET /api/staff/:staffId/documents/:documentId/revisions/:revisionId/content` | Admin; authorized original bytes, optional `download=1` |

All APIs retain no-store behavior, operational session requirements and origin/CSRF protection for writes. Private reads and mutations have attributed audits; failures roll back within the authentication transaction and do not send private bytes. Files reuse the shared verified PDF/JPG/PNG validation and 5 MiB limit; current files and history are preserved after invalid/stale/audit-failed writes. Limits are 100 documents per employee and 100 revisions per document; an exact upload retry remains safe at the limit.

Migration 020 is additive, including foreign keys, scoped revision references, paired review fields, date/file constraints and the singleton warning setting. Backup format 4 fingerprints the new tables; older formats remain readable. Restore/restart checks now include employee files, immutable dates, reviews and warning settings. Native tests create isolated schemas in a separate `_test` database.

The PWA excludes all API/private content from cache. Session/role changes abort requests and revoke previews/download URLs. There are no public document URLs or outside OCR/notification services. The final device camera/share/printing behavior and actual documents still need local checks. Remaining PDF compatibility is SKAO-105; payroll/time-clock work is SKAO-106.

See [START_HERE](SKAO-55_START_HERE.md) for application, verification and Ubuntu/Pi deployment commands.
