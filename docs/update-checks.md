# Back up, migrate and check an update

After applying an update, stop your usual frontend and backend terminals with Ctrl+C. From the Ubuntu checkout, run:

```bash
cd ~/workspace/ska_organizer
bash scripts/check-update.sh
```

This is the reusable command for future updates. It uses the database settings from `server/.env`, with the same exported-environment precedence as the application. There is no need to put your password into the script or enter it again. Keep special characters encoded in `DATABASE_URL` as configured for the working application.

| Order | Action |
|---|---|
| 1 | Check required tools, installed dependencies and separate application/test database settings |
| 2 | Create a dated PostgreSQL custom-format backup in `~/ska_backups` |
| 3 | Check that `pg_restore` can read the archive's table of contents |
| 4 | Apply pending migrations with `npm run db:migrate` |
| 5 | Run all server tests using mock storage |
| 6 | Run the PostgreSQL suites using `TEST_DATABASE_URL` |
| 7 | Run all client component tests |
| 8 | Run the client production build and lint |
| 9 | Run browser tests with their isolated mock backend and Vite test server |

Archive verification checks readability, not a full restore. Each run creates a uniquely named backup and prints its location. Previous backups are retained, including when a migration or test fails.

The script stops at the first failing command and reports the step. Later steps are not executed. It does not automatically roll back migrations or restore a backup. Fix the reported error and rerun the command; already-applied migrations are skipped by the project's migration runner.

## Focused inventory checks

For inventory, groups, purchase receipts and their shopping calculations:

```bash
bash scripts/check-update.sh --inventory
```

This runs the same backup and migration steps, but limits API, PostgreSQL, component and browser suites to inventory, purchasing and the affected weekly-planner/catalog flows. Build and lint still cover the client. Run the default full command before merging.

## Preview or choose a backup directory

Preview the exact test commands without reading credentials, creating backups, migrating or starting tests:

```bash
bash scripts/check-update.sh --inventory --dry-run
```

Choose a different backup location:

```bash
bash scripts/check-update.sh --backup-dir "$HOME/ska_backups"
```

The script finds `client` and `server` relative to its own location. Run it as your normal Ubuntu user, without `sudo`. It does not install packages, change Git, seed data or reset your database.

## First run requirements

Use the existing project setup: Node 20.19+ (22 or 24 supported), npm, PostgreSQL client tools (`pg_dump` and `pg_restore`), installed server/client dependencies, and working `DATABASE_URL` / `TEST_DATABASE_URL` settings. The test database name must end in `_test` and differ from the application database name. Exported settings take precedence over `.env`, so avoid stale shell overrides.

If dependencies are missing or changed, run `npm ci` in the relevant `server` and `client` directories before using the script. If the browser test reports missing Chromium or system libraries, install them once:

```bash
cd ~/workspace/ska_organizer/client
npx playwright install --with-deps chromium
```

Use a `pg_dump` version compatible with your PostgreSQL server. A failed backup or unreadable archive stops execution before migrations. The script uses the URL's database path; connection URLs that override `dbname` or include an `sslpassword` query option are not supported by this helper. The project's normal local PostgreSQL URL is supported, including encoded password characters.

After the script succeeds, start the frontend with `npm run dev` and the backend with `node index.js`, then perform the feature's manual checks in Windows Chrome. Commit, push and merge after reviewing the results. Automated checks do not replace those manual checks.

## PostgreSQL test setup timeouts

A timeout pointing to `beforeEach` in `server/tests/databaseSetup.js` happens while preparing the test, before its assertions run. That hook clears the isolated test tables and signs in a fresh test administrator. It has a 60-second PostgreSQL setup budget; individual PostgreSQL tests retain their 30-second default.

If either setup step takes more than 20 seconds, a warning identifies whether it is clearing tables or creating/signing in the test administrator. This warning does not fail or skip the test. If setup still times out, retain that warning with the failure output to distinguish database cleanup from authentication; the timeout alone cannot establish whether the VM is slow or an operation is blocked.

After a setup correction, rerun the affected suite from `server`, for example:

```bash
npm run test:postgres -- --runTestsByPath tests/activityPlanner.test.js
```

After that passes, rerun the full update script to complete any checks that were stopped by the earlier failure.
