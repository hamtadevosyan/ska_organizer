# Windows pilot commands

Run **SKAO.cmd** in the existing Windows Docker pilot repository. Double-click it
for a menu, or use the commands below in PowerShell. Docker Desktop must be running
with Linux containers. Keep the computer awake while phones use the app.

| Command | What it does |
|---|---|
| `.\SKAO.cmd setup-phone` | Detect a private Windows LAN address, configure HTTPS and firewall, start the saved release, verify it and export the phone certificate |
| `.\SKAO.cmd start` | Start the saved release and wait for healthy services |
| `.\SKAO.cmd restart` | Stop and restart the saved release, retaining data and settings |
| `.\SKAO.cmd stop` | Stop the pilot containers |
| `.\SKAO.cmd update` | Fast-forward the current clean `development` or `main` checkout, then run the existing backup-and-update workflow |
| `.\SKAO.cmd status` | Show containers, saved release, URL and recent backups |
| `.\SKAO.cmd doctor` | Check LAN/firewall, published ports and verified HTTPS/API readiness |
| `.\SKAO.cmd certificate` | Re-export the public phone certificate and URL |
| `.\SKAO.cmd trust` | Trust the pilot certificate for the current Windows user |
| `.\SKAO.cmd backup` | Create a consistent database backup |
| `.\SKAO.cmd logs` | Show the latest container logs |

The launcher requests Windows administrator access only for `setup-phone` or
`firewall`. Use the same Windows account that owns the pilot. It does not change
the computer's PowerShell execution policy. Managed-device policies still apply.

## Phone setup behavior

`setup-phone` uses the actual Windows IPv4 address for both the HTTPS hostname and
Docker binding on port **8443**. It selects a connected private physical interface,
keeps an already selected address when possible, and asks you to choose if more
than one eligible address remains. It refuses public-profile, loopback, VPN/virtual
and non-private addresses. A trusted facility network must already be marked
**Private** in Windows Settings; the script does not silently change that decision.

For unattended selection, the underlying command accepts an actual address and
optional exact adapter name:

```powershell
.\scripts\pilot.ps1 lan -BindAddress YOUR_WINDOWS_LAN_IP -InterfaceAlias 'Wi-Fi'
```

The firewall rule is limited to inbound TCP 8443, the selected local address and
adapter, the Private network profile and local-subnet clients. Running the command
again updates the same rule, including the earlier pilot rule when present. It
does not forward router ports or expose PostgreSQL/the API as separate host ports.
This is local access with application sign-in, not device isolation: other devices
on that permitted subnet can reach the sign-in page. Separate hardware/subnet work
remains a future task.

The script reuses the saved release, database, secrets and certificate volumes.
It updates the API origin through Compose and does not build images, run migrations,
reset accounts, or initialize a replacement pilot. It saves prior LAN settings in
`.pilot/lan-previous.env`, separate from update/recovery's `.pilot/previous.env`.
Command failures restore the old settings/firewall and try the old container
configuration. A failed rollback is reported explicitly. If a process or computer
is forcibly interrupted, run `doctor`, then rerun `setup-phone`; preserve `.pilot`
and the named volumes.

If DHCP later changes the computer's address, rerun `setup-phone` and use the newly
printed URL. A router reservation can keep that address stable. The command cannot
reserve an address on your router. Switching from `localhost` or another hostname
also changes the browser origin; sign in again at the new URL.

## Phone certificate

Setup prints the URL and creates these two files:

- `.pilot/phone/academy-root.cer`: the public root CA in DER format, with no private key.
- `.pilot/phone/PHONE.txt`: URL, certificate SHA-256 fingerprint and device guidance.

Transfer the public certificate to the authorized phone through a trusted local
transfer. Its installation/trust must be approved on the phone. A Windows script
cannot approve a certificate on an unmanaged phone. On iPhone/iPad, enable SSL trust
for the installed root under Certificate Trust Settings. On Android, install it as
a **CA certificate**, not a Wi-Fi or client identity certificate. `PHONE.txt` links
the current vendor guidance; settings names can differ by device.

Use the normal local Wi-Fi. A guest network can prevent the phone reaching the
computer. Open the printed HTTPS URL and check that there is no certificate warning,
then sign in. `doctor` checks the Windows side using the local CA and hostname; it
does not prove that a phone can connect or that its trust store is configured.
Certificate export can be rerun independently without changing the LAN settings.

## Updates and repairs

`update` requires a clean release branch tracking the matching `origin` branch and
uses `git pull --ff-only --no-rebase`. It stops on local changes, an unexpected
upstream, a feature/detached branch or a divergent history. It never stashes,
resets, commits, pushes, switches branches, or creates a merge commit. Use it after
you have tested and merged your changes. The underlying `scripts/pilot.ps1 update`
still deploys the current clean commit without pulling.

A new release uses the existing verified-copy migration and backup workflow in
[backup-recovery.md](backup-recovery.md). Repeating `update` on the already selected
commit starts/checks that release without making another database copy. `restart`
always uses the saved release, even if the checkout contains a newer commit.

`doctor` is diagnostic: it changes no service/network configuration, but refreshes
the local public certificate file for its TLS check. A pass covers only the pilot
containers and managed rule, not a security audit of unrelated Windows programs,
firewall rules, router settings or the older HTTP deployment.

References: [Windows network discovery](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netipconfiguration),
[Windows firewall updates](https://learn.microsoft.com/en-us/powershell/module/netsecurity/set-netfirewallrule),
[iPhone/iPad certificate trust](https://support.apple.com/en-us/102390),
[Android certificate installation](https://support.google.com/pixelphone/answer/2844832).
