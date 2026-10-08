# Child documents

Authorized staff can keep PDF, JPG/JPEG and PNG paperwork on the child's saved
profile. Each file must be no larger than 5 MB. A scanner export can be uploaded
like any other supported file. The upload contains the document itself; this
feature does not extract text or ingredients from it.

## Grant access

Administrators have document editing access. Other accounts initially have
**No access**, even when they can view or edit the child roster. In **Accounts**,
an administrator can grant document viewing or editing separately from the
account's general role. A viewer can receive viewing access; document editing
also requires an editor role. Changes to account access require a fresh sign-in.

These permissions apply to document lists, metadata, every historical revision,
previews, downloads and writes. Knowing a child or file ID does not grant access.

## Add paperwork

1. Open **Children**, view a child's profile, and open **Documents**. When creating
   a child, the optional document step opens after the child saves successfully.
   Cancelling or failing child creation does not upload or associate files.
2. Choose a PDF or image file. On a supported camera-enabled browser, take a
   photo, review it, and either retake it or confirm it before saving.
3. Enter a title and choose **Medical record**, **Contract**, **Consent form** or
   **Other**. Document date and notes are optional.
4. Save the document. The list shows the title, category and last update time.
   Select it to preview or download it and inspect its version history.

PDF previews render pages locally with Previous/Next controls. The renderer and
worker are bundled with the app; document bytes are not sent to a cloud reader.
PDF scripts, links and interactive form layers are not activated in the preview.
If a PDF cannot be rendered, the original file remains available through Download.

Camera behavior depends on the browser and device. Use the facility's existing
trusted HTTPS app address. File upload remains available if a browser does not
offer camera capture. No phone configuration or new hardware is required.

## Update a document

Edit metadata to correct its title, category, date or notes. To replace the file,
upload or capture a new revision, optionally explain the change, and save it.
The newest revision is clearly identified. Older files remain available to
authorized staff with the uploader, time and change note.

A failed upload leaves the saved current file unchanged. A conflicting edit
asks the user to reload the saved document before trying again. Retry an
uncertain upload using the retained draft instead of opening another upload;
the request identity prevents the same upload from being saved twice.

Ending enrollment preserves the child's ID and its documents. There is no
document deletion or retention-policy automation in this change.

## Storage and backups

Document metadata, immutable file revisions and actor references are stored in
PostgreSQL. File bytes are stored as `BYTEA`; there is no public upload directory
or external document storage service. Content is served through authenticated,
permission-checked API requests with caching disabled. Preview URLs are temporary
and are released when the preview closes.

The existing Ubuntu command includes all document versions:

```bash
bash SKAO.sh backup
```

It produces a private PostgreSQL archive under `/var/backups/skao/`. The existing
update command backs up before migrating. Keep protected off-device copies;
metadata alone is not a complete document backup. Archive listing checks the
archive directory, while a restore rehearsal is needed to prove recovery.

The Docker pilot's new format 2 manifest requires both document tables and
reports document coverage. It still accepts and verifies format 1 backups from
before this feature; migrate the isolated recovered database before using it
with the newer application. See [backup and recovery](backup-recovery.md).

## Verification using fictional paperwork

Use a separate PostgreSQL database whose name ends in `_test` and a test role
that can create and manage its own test schemas. Database creation privileges
are not required. Set `TEST_DATABASE_URL` in `server/.env`,
install server dependencies, and run:

```bash
cd server
npm run test:postgres -- --runTestsByPath tests/childDocuments.postgres.test.js
npm run test:restart:prepare
```

Restart **only that test PostgreSQL instance**, then run:

```bash
npm run test:restart:verify
```

The document suite checks database constraints, reconnects to stored revisions,
and performs an actual `pg_dump`/`pg_restore` inside its randomly named test
schema. It temporarily renames the original synthetic schema, restores a copy
from the archive, and returns the original schema after comparison. It also
checks recovery after a deliberately corrupted archive. It compares every
original and revised file byte, checksum, actor and
ended-enrollment link. Native tests use installed PostgreSQL client tools;
`SKAO_TEST_PG_BIN` can identify a matching PostgreSQL binaries directory. CI can
instead set `SKAO_TEST_PG_CONTAINER` to its PostgreSQL service container so the
client and server versions match. Restored copies and test archives are removed
afterward. If schema repair fails, the test reports the retained original schema
and archive instead of hiding the cleanup failure. The application database and
its `public` schema are never used for this rehearsal.

The restart check saves meals and fictional child paperwork in a separate test
schema, closes all Node connections, and compares the same records after the
database restarts. API and browser suites separately cover permissions, upload
failures, revisions and the mobile workflow. Never use real children's paperwork
as a test fixture or put it in Git, shared screenshots or the handoff ZIP.
