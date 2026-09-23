# Private pilot on Windows

The pilot runs production images in Docker Desktop on Windows. Ubuntu VMware stays
as the development/test environment. Staff use one HTTPS address in Chrome; they
never start Node, choose an adapter, or manage a database.

This is a candidate deployment. Complete [pilot acceptance](pilot-checklist.md)
before operational use. Runtime checks are not implied by a successful build.

## Before installing

- Use Docker Desktop with Linux containers/WSL 2, Git and Windows PowerShell 5.1 or 7.
- Use a clean checkout of the exact tested and committed release, including these
  deployment files. Keep the Ubuntu checkout for development.
- Enable Docker Desktop **Start Docker Desktop when you sign in**. Keep Windows
  powered on and awake during service hours. After a Windows restart, sign in and
  wait for Docker. Desktop startup is tied to sign-in; this is not an unattended
  Windows service or a guarantee of continuous availability.
- Choose the facility's IANA time zone before installation. The helper defaults
  to `America/Los_Angeles`; this affects dates used for attendance and reports.
- Reserve enough space for the database, release images and retained backups.
- Keep the existing HTTP Docker setup and `skao_postgres_data` volume until the
  replacement has been reconciled. The new stack is `skao-pilot`, with separate
  `skao_pilot_*` volumes and port 8443. It never rewrites the old compose files.

After the tested change is merged, use a separate clean clone for the new pilot.
This also avoids moving the earlier installation's untracked Docker files. From
Windows PowerShell (adjust the parent directory):

```powershell
cd C:\skao
git clone --branch development https://github.com/hamtadevosyan/ska_organizer.git ska_organizer-pilot
cd C:\skao\ska_organizer-pilot
git status
git rev-parse HEAD
```

If Windows blocks the downloaded helper, inspect it, then unblock that file only:

```powershell
Unblock-File .\scripts\pilot.ps1
```

Do not relax the machine-wide execution policy. On a managed computer, follow its
PowerShell policy.

## Install on this Windows computer

```powershell
.\scripts\pilot.ps1 init
.\scripts\pilot.ps1 trust
.\scripts\pilot.ps1 admin
.\scripts\pilot.ps1 status
```

Open **https://localhost:8443** in Chrome. `admin` asks for a new administrator
username, display name and hidden password; there is no default password. It
refuses to overwrite existing accounts. Create teacher/editor/viewer accounts
through account administration after signing in.

`init` creates random database secrets and a dedicated backup folder, builds
commit-tagged images, initializes a new PostgreSQL volume, applies migrations,
and waits for API and HTTPS readiness. Production startup never seeds sample
records. Add synthetic examples through the UI for pilot verification; an empty
catalog cannot generate meals.

If the initial build or startup fails, read the error, correct it and resume from
the same clean commit:

```powershell
.\scripts\pilot.ps1 resume-install
```

Do not delete `.pilot` or change its secrets to retry. If initialization stopped
before `.pilot/runtime.env` was created, preserve the directory and diagnose the
filesystem/permission failure before proceeding. Existing pilot volumes require
their matching settings and passwords.

## Allow selected computers on the private LAN

Choose the Windows host's fixed/private IPv4 address, not the Ubuntu VM address.
For example, on a **new installation**, replace the sample IP with your actual
reserved Windows address:

```powershell
.\scripts\pilot.ps1 init -PilotHost 192.168.1.50 -BindAddress 192.168.1.50 -TimeZone America/Los_Angeles
.\scripts\pilot.ps1 trust
.\scripts\pilot.ps1 admin
```

Use **https://192.168.1.50:8443** everywhere for this example. A private DNS name
can replace `PilotHost` if all client devices resolve it to that address.
`localhost` on a different computer points to that computer, not the server.

Run only the firewall command in an elevated PowerShell session:

```powershell
.\scripts\pilot.ps1 firewall
```

The rule permits port 8443 from the local subnet on the **Private** Windows
network profile and chosen local IP. It does not expose PostgreSQL or Node.
Do not forward this port on the router. Review/remove the earlier HTTP 8080 rule
when retiring the old installation.

On every authorized Windows client, copy only `.pilot/root.crt` using a trusted
path, compare its SHA-256 with the host's `Get-FileHash .pilot/root.crt`, and import
it into **Current User / Trusted Root Certification Authorities**. Restart
Chrome and confirm it trusts the certificate. Never bypass a certificate warning
or copy the CA's private key to clients. Caddy's private CA keys stay in its Docker
volume. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https).

For a later host/address change: pause use, run a backup, stop the pilot, edit the
single-quoted `PILOT_HOST` and `PILOT_BIND` values in `.pilot/runtime.env`, then run
`start`. Update DNS, firewall and bookmarks together. Caddy issues the new local
certificate; browser origins must match the new address exactly.

## Everyday operation

```powershell
.\scripts\pilot.ps1 status
.\scripts\pilot.ps1 logs
.\scripts\pilot.ps1 stop
.\scripts\pilot.ps1 start
.\scripts\pilot.ps1 restart
```

Containers use `restart: unless-stopped`, so Docker restarts running services after
its own restart. A deliberately stopped stack stays stopped until `start`.
Database and certificates remain in named volumes. An unhealthy container is
reported as unhealthy; a health check itself does not force a restart.

`/api/health` reports the Node process. `/api/ready` verifies storage and returns
only `ready` or `unavailable`. Other operational endpoints still require a session.
A storage outage returns a retryable message and does not clear a valid session.
Logs use generated request IDs and error categories, without raw request data or
SQL. Match the browser response's `X-Request-Id` to the API log when diagnosing a
failed request. `logs` displays only the latest 100 lines per service; Docker
rotates each service log at 10 MB, retaining three files.

## Configuration and secrets

| Setting/file | Purpose |
|---|---|
| `.pilot/runtime.env` | Non-secret host, bind address, time zone, active database, release commit and backup directory |
| `.pilot/secrets/app-password` | Random password for the non-superuser application role |
| `.pilot/secrets/db-admin-password` | Database administration password; not mounted in the API container |
| `.pilot/root.crt` | Public CA certificate to trust on authorized client devices |
| `skao_pilot_database` | PostgreSQL 17 data volume |
| `skao_pilot_certificates` | Persistent local CA and certificate keys |
| `skao_pilot_web_config` | Persistent Caddy configuration data |

The helper restricts its private directory and backup directory to the current
Windows user and SYSTEM. Preserve these ACLs and use an encrypted device for
copies. Neither `.pilot`, dumps nor backups belong in Git or chat.

Compose mounts secret files under `/run/secrets`. The server derives its encoded
connection URL internally. Regular Ubuntu development continues using
`server/.env` and `DATABASE_URL`; do not configure both a URL and a password file.
The frontend is built with `VITE_API_BASE_URL=/`, because its API functions append
`/api`. The browser uses the same HTTPS origin as the page.

## Bring data from the old installation

1. Pause users on the old site. Make a trusted custom-format PostgreSQL dump using
   its existing backup command. Preserve the old settings, secrets, volume and
   release. Never run the earlier restore command against the live database.
2. Install the new pilot, then import your dump:

   ```powershell
   .\scripts\pilot.ps1 import -ImportFile C:\private-backups\old-organizer.dump
   ```

3. The command restores into a new database, applies current migrations there and
   makes a new fingerprinted backup. It prints a backup name and leaves the active
   pilot unchanged. An old dump has no source fingerprints, so this is **not proof
   that it contained every source record**.
4. Run `recover -BackupName THE_PRINTED_NAME` using the recovery guide. It retains
   the initial pilot database and clears restored sign-in sessions.
5. Compare accounts, meals, plans, children, visits, stock, receipts and activities
   with the old site while both are paused. Resolve differences before allowing
   writes on the new site. Do not run two writable copies of the same records.
6. Stop the old stack only after reconciliation. Keep its volume and backup until
   the new pilot's backup and recovery exercise has passed.

Only restore dumps from your own trusted installation: a PostgreSQL dump can
execute SQL during restore.

## Update or recover

Follow [Backup, update and recovery](backup-recovery.md), then record the exact
release and results in [Pilot acceptance](pilot-checklist.md). The
[API index](api.md) links the maintained feature contracts.
