# SKAO-47 — child documents

Based on development commit `4c208738d7522c1b9c0005bd169e8402be3d38ad`
(the merged SKAO-99 change). Test and commit on your Ubuntu development machine.
The Pi continues to pull merged development releases.

## Apply the ZIP

Extract `SKAO-47-child-documents.zip` into Downloads. From your development checkout:

```bash
git switch development
git pull --ff-only origin development
git switch -c feature/SKAO-47-child-documents
bash ~/Downloads/SKAO-47-child-documents/apply-fix.sh
git diff --stat
```

The script checks the patch before applying it, preserves existing work on a
mismatch, and performs no commit, push, deployment or system settings change.
It also accepts a checkout path as its first argument and safely detects a
second application. `files/` contains the changed source files for review.

## Automated checks

Stop the normal development client/server. With the existing Ubuntu database,
server dependencies, Tesseract and Playwright Chromium installed, run from the
repository root. Use Node 20.19 or a supported Node 22/24 version.

```bash
npm --prefix client ci &&
bash scripts/check-update.sh &&
npm --prefix client run test:pwa &&
npm --prefix client run test:browser:pwa
```

The checker backs up the configured application database before migrating and
runs the server, PostgreSQL, client, build, lint and core browser checks. The
last two commands add the PWA checks. It stops before later commands if a check
fails. For a first checkout, install server dependencies with
`npm --prefix server ci`; install Chromium with
`npm --prefix client exec -- playwright install chromium`.

The existing recipe-photo regression tests require the installed local Tesseract
reader. Its deferred OCR improvement story is not part of SKAO-47.

For real database and archive checks, configure `TEST_DATABASE_URL` in
`server/.env` to a **separate** PostgreSQL database whose name ends in `_test`.
Use matching installed `pg_dump`/`pg_restore` tools. The test role only needs
to create and manage its own schemas in that existing test database; it does
not need database creation privileges. The archive rehearsal preserves its
original synthetic schema, restores a copy, compares documents, then returns
the original schema. The checker already runs these archive tests. For the
additional database-restart check:

```bash
npm --prefix server run test:restart:prepare
```

Restart only that test PostgreSQL instance, then:

```bash
npm --prefix server run test:restart:verify
```

## Back up and migrate before running the updated app

For an existing native deployment, `bash SKAO.sh update` already backs up and
applies migrations. The full checker above also backs up before migrating, so
this manual alternative is unnecessary after a successful checker run.
For a development checkout running Node directly, stop
the backend and make a private database backup before migrating:

```bash
cd server && node - <<'NODE' && npm run db:migrate && npm start
require('./config/environment');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateDatabaseUrl } = require('./database/connection');
const url = validateDatabaseUrl(process.env.DATABASE_URL);
const directory = path.join(os.homedir(), 'skao-backups');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Use a regular private backup directory.');
fs.chmodSync(directory, 0o700);
const file = path.join(directory, 'pre-SKAO-47-' + Date.now() + '-' + randomUUID() + '.dump');
fs.closeSync(fs.openSync(file, 'wx', 0o600));
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' };
// The database password goes to the child environment, never its command arguments.
for (const [command, args] of [['pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file=' + file]],
  ['pg_restore', ['--list', file]]]) {
  const result = spawnSync(command, args, { env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.error || result.status !== 0) {
    fs.rmSync(file); throw new Error(command + ' failed. Do not migrate until a backup succeeds.');
  }
}
console.log('Private backup saved: ' + file);
NODE
```

Run these commands in order and stop if a command fails. This uses the configured
development database. Migrations 016–018 add document access, document revisions, registration
blank templates and reviewed-copy mappings. Starting the new backend with pending migrations is rejected.

## Try the workflow with fictional paperwork

1. Sign in as an administrator. Under Children, create a fictional child and
   select **Add documents after saving**. The child must save successfully before
   any file is attached. Cancelling child creation must create no documents.
2. Add PDF, JPG or PNG files, up to 5 MB each. Give each a title/category and,
   optionally, a date and notes. Select a document to preview or download it.
3. On the phone/iPad using your existing HTTPS app address, choose **Take a photo**,
   inspect the preview, retake it, and select **Confirm photo** before saving.
4. Edit document details. Upload a new version with a change note. Check the
   current-version badge, uploader/time and earlier version's original download.
5. Sign in as a teacher/editor and a read-only account. Neither should see
   Documents, registration checklists or registration forms. Direct document
   requests must be denied. Only administrators handle this paperwork.
6. End the fictional child's enrollment, choose inactive children, and reopen
   their profile. Saved documents and history must remain accessible to
   administrators. Restart the app and check the same files again.

Camera availability depends on the browser/device; upload remains available.
Check the actual iPad/iPhone camera and PDF preview before accepting the story.
No phone, Windows, router, domain or hardware configuration change is needed.

Documents and every file version live in PostgreSQL, so existing database
backups include them. Preview bytes stay in memory; document API responses are
not added to the service-worker cache. See [child-documents.md](child-documents.md)
and [backup-recovery.md](backup-recovery.md) for details.

## Commit and merge after your checks

```bash
git status --short
git add .github/workflows/server-tests.yml client server docs
git diff --cached --check
git commit -m "SKAO-47: manage private child documents and revision history"
git push -u origin feature/SKAO-47-child-documents
```

Open a pull request into development and merge after GitHub checks pass. Then,
on the Pi, with a clean development checkout:

```bash
git pull --ff-only origin development
bash SKAO.sh update
```

SKAO-47 stays In Progress until your review and merge are complete.

## Registration packet

Administrators can now manage reusable blank templates in **Registration forms**.
Each child profile shows missing, unreviewed, completed and outdated forms.
See [Registration follow-up instructions](SKAO-47_REGISTRATION_START_HERE.md) for
packet setup, printing/sharing blanks, linking completed copies and template updates.
