# SKAO-100 verification

Base: `071c9577555175834890175bdc3f2801df3329ca` (development, SKAO-79 merged).
SKAO-80 remains a separate handoff. No application UI, API, database schema,
dependency, image, or Compose port changes are included in this patch.

## Executed successfully

- PowerShell 7.4.13: all four PowerShell files parse without errors.
- **39 isolated automation tests passed.** Tests cover private IPv4 selection,
  public-network refusal, multiple adapters, firewall policy, first/repeated setup,
  DHCP address changes, legacy-rule repair, duplicate-rule refusal, missing images,
  invalid Compose configuration, partial firewall failure, container/TLS failures,
  rollback failures, unexpected port exposure, public-only certificate export,
  fingerprints, diagnostic behavior, Git update guards, operation locking,
  repeat-update behavior, command dispatch and exit-code propagation.
- CI YAML loads and includes Windows PowerShell 5.1 parsing and execution of the
  isolated automation suite. Existing Docker integration checks remain intact.
- `git diff --cached --check` passes.
- The patch applies cleanly to the recorded development base.
- The patch also applies cleanly after the SKAO-80 handoff patch; SKAO-80's UI,
  manifest, icons, Caddy handling and CI checks are preserved.

The PowerShell runtime used here was downloaded from the official 7.4.13 release
and checked against its published SHA-256. It is a local test tool, not a new
dependency shipped to the user or a claim that this is the latest version.

## Still requires the Windows pilot and phone

Docker, Windows networking/firewall, UAC and Git pulls are mocked in the local
automation suite. This Linux workspace cannot validate actual Windows PowerShell
5.1 execution, Docker Desktop IP binding, Windows firewall policy, Schannel/curl
certificate validation, phone Wi-Fi connectivity, phone trust, native installation
or sign-in on a physical device. The Windows CI gate has been added but has not
been executed here. No deployment has been performed.

Run `SKAO.cmd setup-phone` on the existing Windows pilot, then `SKAO.cmd doctor`.
Setup will print the actual phone URL and public certificate location. Confirm
phone trust, sign-in, core navigation and restart behavior using synthetic records.
This is also the remaining prerequisite for SKAO-80's native phone review.

No commit, push or merge was performed. SKAO-100 remains In Progress in Sprint 1.
