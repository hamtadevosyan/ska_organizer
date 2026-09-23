# Backup, update and recovery

Run these commands in Windows PowerShell from the pilot repository. They use the
settings created by [private pilot installation](private-pilot.md). Keep the
repository checkout and its release images; a database archive alone is not an
application release.

## Create a consistent backup

```powershell
.\scripts\pilot.ps1 backup
```

The command prints a unique `backup-...` folder name. By default the folder is
under `%LOCALAPPDATA%\SKAO\backups`; `PILOT_BACKUP_DIR` records the exact location.
It contains:

- `database.dump`: PostgreSQL custom-format archive, including all public tables,
  constraints and indexes.
- `manifest.json`: release commit, PostgreSQL version, dump checksum, table
  definitions, counts and hashes of row contents from the same database snapshot.
- Later `verify-*.json`/`restore-*.json` files: verification results with counts,
  time and domain coverage, without record contents.

The exported snapshot allows normal work to continue during a backup. Source row
fingerprints and `pg_dump` use the same snapshot, so a concurrent update does not
make their comparisons inconsistent. A folder ending in `.partial` is an
incomplete backup and is never accepted for restore. Fix the failure and create a
new backup; do not rename the partial folder.

Backups contain sensitive records and password hashes. Keep the full folder
private and copy it to a separate encrypted drive/location. A copy on the same
Windows disk does not cover disk loss. Retain at least a recent daily series,
weekly verified copies and the last pre-update copy; do not automatically delete
old copies before a replacement is verified. The helper does not enforce a
retention policy or upload records anywhere.

## Schedule daily backups

```powershell
.\scripts\pilot.ps1 schedule
```

This registers **SKAO pilot daily backup** for 03:00 in Windows Task Scheduler,
with **Start when available**. It runs as your signed-in Windows user without
storing a password. Windows must be awake, you must be signed in, and Docker must
be running. A sleeping/offline computer cannot create an on-time backup.

In Task Scheduler, run the task once and confirm **Last Run Result = 0** and a new
complete backup folder. Check this regularly. Change the trigger there if another
time suits the facility. The script prevents overlapping operations; an overlap
fails visibly and must be retried. Schedule verification as an operator check
at least weekly and after changes; daily backup alone does not prove recovery.

## Verify recovery without changing the live database

Use the exact name printed by `backup`:

```powershell
.\scripts\pilot.ps1 verify -BackupName backup-THE-EXACT-NAME
```

This validates the archive checksum, creates a **new randomly named database**,
restores the archive in one transaction, and compares every public table's schema,
row count and row-content hash with the backup snapshot. A matching count alone
is insufficient. After success the temporary verification database is dropped;
the verification record remains beside the backup. It never drops the live database.

If verification fails, the command exits nonzero and retains the isolated
candidate for diagnosis. An administrator can later remove that candidate only
after checking its printed name against `PILOT_DATABASE`. Never remove the
current database. Do not mark a failed restore successful by editing the manifest.

`coverage` flags distinguish restored empty tables from exercised workflows.
All required tables can compare correctly while `children: false`, for example,
means no child record was present. Before pilot acceptance, use synthetic data
covering all domains and verify again; every coverage flag must be `true`.

## Apply a tested update

First complete all Ubuntu and CI checks for the proposed commit. Arrange a short
pause in use. Keep your current backups and images.

On Windows, bring the **already tested/merged** code into the clean checkout:

```powershell
git status
git switch development
git pull --ff-only
.\scripts\pilot.ps1 update
```

`update` builds the new commit-tagged images while the old release is available,
stops API writes, records a backup tagged with the **old** release, restores and
verifies a separate copy, and applies pending migrations to that copy. It starts
the new version only after health checks. It keeps the
previous settings in `.pilot/previous.env` and does not delete older images.
The prior database and schema remain intact. If migration or startup fails, the
helper stops and keeps both databases for diagnosis. Record the printed pre-update
backup name. Users sign in again after the switch.

After success, sign in and check a saved meal week, attendance, stock/purchases,
activity schedule and reports. Verify a new backup. Reopen use only after those
checks pass. Stop on failures; retrying an uncertain save is a separate UI decision.

## Recover a backup or roll back a failed update

Use the pre-update backup for a rollback. The archive's release images must still
be present. Inspect `status` to see the current database and selected release.

```powershell
.\scripts\pilot.ps1 recover -BackupName backup-THE-EXACT-NAME
```

The command requires you to type the current database name. It stops API writes,
creates a safety backup of the current database, restores and verifies the selected
archive in a separate database, clears old sessions, and selects that new database
with the archive's matching release images. The old database remains intact.
Users must sign in again. Reconcile the recovered records and the recovery point
before letting staff return; later changes are still in the retained prior
copy/safety backup, not automatically merged.

A failed operation leaves the API stopped rather than guessing which database is
correct. Use the recovery command to select a verified copy with matching images;
do not change a database setting without reconciling its records and release.
Do not delete volumes or prune old release images during recovery. Updates retain
one prior database per attempt, so monitor disk usage. Remove an old database only
after checking it is not active and its off-device recovery copy is verified.

If the safety backup cannot be created, recovery stops before switching. Fix
storage availability first. For irreparable source storage or loss of the host,
use the fresh-host procedure below; preserve the damaged source for diagnosis.

## Restore after host/disk loss

1. On a replacement Windows host, install Docker Desktop/Git and check out the exact
   release commit recorded in the trusted backup's `manifest.json`.
2. Follow `private-pilot.md` to initialize a **new** pilot at that commit. It creates
   new database secrets and empty migrated tables. Do not reuse a partial old
   volume with new secrets. Build the release images from that commit.
3. Copy the complete trusted backup folder into this installation's private
   `PILOT_BACKUP_DIR`. Preserve privacy permissions and verify its off-device copy.
4. Run `verify`, then `recover` with its exact name. The initial empty database
   provides a safe current database for this restore; nothing overwrites the lost
   disk. Recovered application passwords come from the database, while the new
   database service uses the new secret files.
5. Trust the replacement CA on authorized clients. Update DNS/bookmarks if needed.
   Sign in, reconcile all domains and create/verify an off-device backup.

Also preserve an encrypted copy of `.pilot` and the hostname/time zone information
for repair of the **same** existing volume. Restoring onto a new database does not
require old database passwords, but reusing an existing PostgreSQL volume does.
CA private keys are not included in a database dump; a new host without those
keys creates a new CA which must be trusted again. Never send private keys to staff.

## Evidence to keep

Record release commit, backup name/checksum, verification file, domain coverage,
recovery duration, the last retained recovery point and the person who checked it.
Use synthetic pilot records in shared screenshots. An operations manifest is not
an encrypted archive and is not a substitute for secure storage.

References: [PostgreSQL dump snapshots](https://www.postgresql.org/docs/17/app-pgdump.html)
and [transactional restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
