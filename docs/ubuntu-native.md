# SKAO on Ubuntu: PC, VM or Raspberry Pi

Run the app at **https://app.smartkidsacademycenter.com** on the trusted local
network. The main domain remains available for the facility's future public
website. This installation uses native Ubuntu services and the existing local
PostgreSQL database.

## Development machine versus deployment host

The native deployment supports **Ubuntu 24.04 on AMD64 or ARM64**, including
physical PCs, VMware/VirtualBox/Hyper-V/KVM guest VMs, and Raspberry Pi. It uses
Ubuntu packages and network link capabilities; there is no Pi model, GPIO, CPU
vendor or physical-adapter requirement. Deployment needs systemd and a usable
private IPv4 address. Containers and VPN/container interfaces are not deployment
LANs. Other Ubuntu versions can be used for development builds but are not
validated for this production service installation.

Develop and commit on the Ubuntu VM. To validate a production build without
installing services, requesting sudo, reading server/.env, accessing a database,
or configuring DNS/HTTPS, run:

```bash
bash SKAO.sh build
```

This installs locked dependencies and builds the client in a temporary directory
as your normal user. Node may be installed per-user for this command. Newly
created application source files must first be added to Git's index, because
release builds use git ls-files. Build files are removed afterward. For ordinary
interactive development, use the existing client/server npm commands and your
development database; build does not start either server.

Push the source branch from the development VM, review CI and merge it. On the
Pi or another production host, pull/build/deploy using SKAO.sh update. Native
node_modules are rebuilt on each host, never copied between AMD64 and ARM64.

For phone access to a **deployed VM**, select a bridged/external virtual adapter
connected to the trusted LAN. A NAT-only adapter can support development builds,
but its private address is normally unreachable from phones on the surrounding
Wi-Fi. The installer cannot prove reachability from a different device, so a
second-device test remains necessary. Do not disable host/hypervisor firewalls
or expose public ports to work around that distinction.

## First setup

Use your normal Ubuntu account from the repository root:

```bash
cd ~/workspace/ska_organizer
bash SKAO.sh setup
```

The helper requests `sudo` for host installation. It builds Node dependencies and
the frontend as your normal user. Do not run the whole command with `sudo`.

Before running it:

1. Keep the existing `server/.env` with its working local PostgreSQL
   `DATABASE_URL`. Special characters in URL credentials must be percent encoded.
   PostgreSQL must listen only on localhost. Existing accounts, records, schema
   and facility time zone are retained; this installer does not seed sample data.
2. Use system-wide Node 24 and npm. The helper also accepts Node 20.19+ and
   22.12+. Per-user nvm installations are not supported by these boot services.
3. Stop the manually started `npm run dev` / `node index.js` terminals with
   Ctrl+C. Keep PostgreSQL running.
4. Keep the deployment host's private IPv4 stable and its DNS record in sync.
   A DHCP reservation is one option; it is not required to test the current
   public-DNS pilot. The helper detects Ethernet/Wi-Fi and VM guest Ethernet
   adapters. If more than one address is available, use
   `bash SKAO.sh setup --ip YOUR_LAN_IP`.
5. In [Cloudflare API tokens](https://dash.cloudflare.com/profile/api-tokens),
   create a token with **Zone → DNS → Edit**, limited to the specific zone
   **smartkidsacademycenter.com**. Enter it only at the script's hidden local
   prompt. The token is stored root-only on the host; it is not committed to Git.
   The prompt also asks you to accept Let's Encrypt's certificate terms and
   enter a certificate account contact email, which is shared with that CA.

Setup installs Ubuntu's Caddy, Certbot/Cloudflare plugin, dnsmasq-base, nftables,
PostgreSQL client and build tools. It then builds the production app, issues the
certificate through DNS verification, creates a database backup, applies pending
migrations and starts the services. Certificate issuance can take several minutes.

If setup stops, read the first error. Fix it and rerun the same command. Existing
deployment settings cannot be silently replaced by rerunning setup with another
IP or database. The original repository `server/.env` is preserved. The installed
copy has production mode, the exact HTTPS origin and a loopback-only API address.

## Package troubleshooting

If `unattended-upgr` or another package operation holds the **dpkg install lock**,
setup allows APT to wait up to 10 minutes. Let Ubuntu finish its updates. If the
wait expires, rerun `bash SKAO.sh setup` after the update finishes. Do not delete
lock files, kill the updater, or disable automatic security updates. The timeout
applies only to this install command; it does not change global APT settings.
An `apt-get update` lists-lock conflict is separate: wait for that operation to
finish and rerun setup.

Setup also requires every configured repository to refresh successfully. It
stops before installing packages if a repository fails signature verification
or cannot be downloaded, rather than continuing with a stale package index.

For the legacy ROS 2 Noble repository error
`EXPKEYSIG F42ED6FBAB17C654`, run this explicit one-time repair:

```bash
bash SKAO.sh repair-ros-key
bash SKAO.sh setup
```

The repair supports the original ROS 2 `.list` configuration referencing
`/usr/share/keyrings/ros-archive-keyring.gpg`. It checks the installed and
downloaded key against ROS's published fingerprint, verifies the refreshed key
is current, backs up the old key next to it, and replaces it atomically. It uses
HTTPS to fetch only the key from the official `ros/rosdistro` repository. ROS
packages and repository definitions are preserved, and signature verification
remains enabled. No key is changed if a different source layout, a package-owned
key, a download error or an unexpected fingerprint is found. It requires `curl`
and `gpg`, normally present on a host with this legacy ROS setup.

This repairs the existing key; it does not migrate ROS to `ros2-apt-source`.
ROS recommends that package for future automatic key updates. Follow the
[official migration guide](https://discourse.ros.org/t/ros-signing-key-migration-guide/43937)
when maintaining the ROS installation. SKAO setup does not automatically modify
unrelated repository configurations.

`Unit caddy.service does not exist, proceeding anyway` followed by a symlink to
`/dev/null` is expected during first setup. The installer masks the package's
default service before installation; SKAO uses its own `skao-web.service`.

## Connect phones using the current public-DNS pilot

When setup reports PASS, the host check verifies HTTPS using the certificate's
normal public trust chain and an explicit local address. It does not prove that
another device can resolve the hostname or reach the host.

In Cloudflare, add the following DNS record for smartkidsacademycenter.com:

| Field | Value |
| --- | --- |
| Type | A |
| Name | app |
| IPv4 address | The deployment host's private LAN IPv4 printed by setup |
| Proxy status | DNS only (gray cloud) |
| TTL | Auto |

Use one matching app A record; review any existing app A/AAAA/CNAME records before
adding a conflicting entry. The main website and certificate TXT records are
separate. Cloudflare serves the hostname lookup, while application HTTPS traffic
connects directly over the LAN. A private-IP DNS record does not open Internet
access to the host. No public port forwarding, tunnel or Cloudflare proxy is
needed. Keep the A record in sync if the host IP changes.

On the host, verify the public answer:

```bash
dig @1.1.1.1 app.smartkidsacademycenter.com A +noall +answer
```

On a phone connected to the same trusted LAN, open:

```text
https://app.smartkidsacademycenter.com
```

Sign in and test Add to Home Screen. Use the hostname, not the numerical IP.
This pilot worked on the owner's network without router or device DNS changes
or a private root certificate installation. Some resolvers block public DNS
answers containing private IPs as DNS-rebinding protection; test the actual
network and preserve its protections if it fails. The hostname/private IP are
publicly queryable, but DNS does not contain application records.

The deployment also provides a LAN-only DNS service for a future centrally
managed private network. It maps the app hostname and forwards other queries to
Cloudflare's 1.1.1.1 / 1.0.0.1 resolvers. It does not supply DHCP or change Ubuntu's
system resolver. Using it as network-wide DNS makes clients depend on this host
and can conflict with eero Plus filtering. The public-DNS pilot does not require
using that service on phones or changing the current router's DNS.

## Everyday commands

Run these from the repository root:

| Command | What it does |
| --- | --- |
| `bash SKAO.sh build` | Validate a temporary production build on the development machine without sudo or deployment configuration. |
| `bash SKAO.sh status` | Check services, local DNS, trusted HTTPS, database readiness, firewall and keep-awake inhibitor; show certificate expiry. |
| `bash SKAO.sh restart` | Restart the local services and verify they respond. |
| `bash SKAO.sh stop` | Stop the app, local DNS and keep-awake service. Boot startup remains enabled. |
| `bash SKAO.sh start` | Start services again and check them. |
| `bash SKAO.sh update` | Pull the current branch with `--ff-only`, build, back up, migrate and restart. Requires a clean checkout. |
| `bash SKAO.sh update --local` | Deploy tracked working-tree changes without pulling; useful for testing a patch before committing. Add newly created application files to Git's index first. |
| `bash SKAO.sh backup` | Create a consistent PostgreSQL custom-format archive in `/var/backups/skao/`. |
| `bash SKAO.sh logs` | Show the last 100 service log entries. Review logs before sharing them. |
| `bash SKAO.sh renew-test` | Test certificate renewal using the CA's staging service, without installing a staging certificate. |

Updates build before interrupting the running app. Local DNS stays available
during backup and migration. A failed backup or migration prevents release
activation; the previous release and backup are retained. An incomplete
activation also blocks API/web startup after reboot. Fix the reported error and
rerun `update --local` (or `setup` for a first install). Do not remove the
`activation.pending` marker or restore the live database just to clear an error.
There is no automatic database rollback.

Backups are root-only files containing facility data. `pg_restore --list` checks
the archive directory; it is not a full restore rehearsal. Keep a separate,
protected backup for recovery from storage failure. The script retains backups
and old releases and does not automatically delete them.

## Sleep, reboot and availability

`skao-awake.service` holds a `systemd-inhibit` sleep/idle lock while SKAO's local
services run. It releases the lock when you use `SKAO.sh stop`. Global Ubuntu
sleep settings and sleep targets are not changed. Turning off or locking the
display does not stop the app.

If the host actually sleeps or powers off, phones cannot reach the app. Devices
using the host as their DNS server can also lose name resolution for other sites.
An installed app may show its public offline shell, but it cannot read or save
facility records while the server is unavailable. Saved database records survive
normal sleep/restart; unsubmitted work may need to be entered again.

Services start automatically after boot and restart after a process failure.
The inhibitor cannot prevent loss of power or an administrator forcing suspend.
If clients use this host as their DNS server, restore their previous router/device
DNS settings before retiring it. Public-DNS pilot clients do not need that change. To disable future SKAO boot startup after restoring DNS:

```bash
bash SKAO.sh stop
sudo systemctl disable skao.target skao-renew.timer
sudo systemctl stop skao-renew.timer
```

This leaves database files, credentials, backups and protective firewall rules
in place. It does not uninstall unrelated Ubuntu software.

## What changes on Ubuntu

| Location / service | Purpose |
| --- | --- |
| `/opt/skao/releases/` and `/opt/skao/current` | Root-owned release snapshots and the selected release. |
| `/etc/skao/native/config.json`, `server.env` | Root-only deployment settings and database connection. |
| `/etc/skao/native/cloudflare.ini` | Root-only, zone-scoped Cloudflare token. |
| `/etc/skao/native/acme/`, `acme-logs/` | Private certificate account, renewal metadata and issuance logs. |
| `/etc/skao/native/tls/` | Certificate/key readable only by root and the dedicated web service group. |
| `/usr/local/lib/skao/ubuntu.py` | Root-owned helper used by boot and renewal services. |
| `skao-api`, `skao-web`, `skao-dns` | Separate non-login service accounts. |
| `skao.target` | Boot startup of API, HTTPS, local DNS and the sleep inhibitor. |
| `skao-renew.timer` | Twice-daily renewal checks with a randomized delay. |
| `inet skao_native` nftables table | Block direct LAN access to API/database ports; restrict DNS/HTTPS to the chosen LAN. |

If UFW is already active, setup adds only LAN-scoped HTTPS/DNS allowances with
the `SKAO-native` comment. It does not reset firewall policies or change SSH rules.
The package's unused `caddy.service` is masked so it cannot open a default public
HTTP listener; SKAO uses `skao-web.service` instead. This mask and the app services
persist across reboot. No Windows settings are changed.

The API listens on `127.0.0.1:3001`; PostgreSQL stays on localhost. HTTPS binds
only the reserved private IPv4 and loopback. DNS binds only that private IPv4.
Caddy's control API uses a protected Unix socket, not a network port. Request
access logging is disabled. These controls restrict access on the current LAN;
separate tablet-network hardware and segmentation remain future work.

The host still uses outbound Internet for packages, Git/npm downloads, certificate
issuance/renewal and forwarded DNS queries. Cloudflare handles certificate TXT
records; application traffic travels directly between LAN devices and the host.
Publicly trusted certificates publish the hostname in certificate-transparency
logs. They do not publish application records. No setup can promise immunity
from compromise; keep the OS, dependencies, accounts and backups maintained.

## Checks before completing SKAO-101

1. `bash SKAO.sh status` passes on the host.
2. A second device resolves the hostname to the reserved host IP and signs in over
   HTTPS without certificate warnings; existing data is present.
3. `bash SKAO.sh renew-test` passes.
4. After a host reboot, `status` passes and the second device can sign in again.
5. Direct API/database ports are unreachable from another LAN device, and the
   app cannot be reached using a cellular/off-LAN connection.
6. Resume SKAO-80 for Add to Home Screen, standalone launch and frontend update
   checks on the actual iPhone/iPad.

The test workflow is configured for Ubuntu AMD64 and ARM64 hosted VMs. It builds
the production release and uses synthetic data to exercise configuration, failure
order, TLS/proxy behavior, local DNS and cache headers. It does not issue a live
certificate or validate the owner's router or physical Pi. The ARM64 CI job verifies the
ARM64 runner, not a real Raspberry Pi. Existing dependency
audit findings are not remediated by this deployment patch.

References: [Certbot Cloudflare DNS plugin](https://certbot-dns-cloudflare.readthedocs.io/en/stable/),
[Caddy installation](https://caddyserver.com/docs/install),
[systemd inhibitor locks](https://github.com/systemd/systemd/blob/main/docs/INHIBITOR_LOCKS.md).
