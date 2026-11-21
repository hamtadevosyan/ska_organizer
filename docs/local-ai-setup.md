# Reproducible private AI setup

The Organizer API and PostgreSQL remain on the Pi. Ollama and a Caddy HTTPS gateway run under the protected Windows AI account. Only the configured Pi address and gateway token can use the permitted inference routes. The scripts preserve a matching manual installation; do not delete working state before running them.

This saved implementation was regenerated after the original temporary artifact expired. The bundled patch is based on the revision in `BASE_COMMIT.txt`. It contains setup automation and the independent readiness check, with no activity-description or translation changes.

## Windows prerequisites

- Windows 11 x64, Windows PowerShell 5.1 and the existing password-protected AI account.
- A session under that same account with administrative permission for initial task/firewall registration. An SSH session is supported; the script does not try to display UAC remotely.
- A trusted Windows Private network, enabled firewall profiles, and policy permitting the local firewall rules. Setup refuses conflicting policy instead of weakening it.
- Stable private IPv4 addresses for the laptop and Pi, preferably router DHCP reservations.
- Windows OpenSSH client and Python 3 on the Pi for the optional transfer helper. SSH host-key verification remains enabled.

Account creation, Windows SSH setup, GPU drivers and Windows sleep policy are prerequisites that these scripts do not change. Sleeping or disconnected laptops make AI unavailable while normal Organizer features remain usable.

## Saved commands

From the extracted bundle root under the AI account:

```powershell
# Read-only verification of the existing setup.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Setup-LocalAI.ps1 -Check

# Fresh setup or completion of recognized missing components.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Setup-LocalAI.ps1

# Optional, explicit synthetic inference test.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Setup-LocalAI.ps1 -TestGeneration

# Optional private transfer; enter the normal Pi username locally.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Transfer-To-Pi.ps1
```

Keep `Receive-Connection.py` beside the transfer script. Use each command as a complete line. The password prompt is for scheduled-task credentials, not a Windows Hello PIN. Passwords and connection tokens are never required in command arguments or chat.

Equivalent scripts are saved under `scripts/local-ai/windows` after applying the repository patch. For an offline Ollama archive, `Setup-Ollama.ps1 -ArchivePath` accepts the pinned ZIP and verifies its SHA-256 before extraction. Model installation still needs access to its official registry unless the exact model is already present.

`-Check` does not download, register/start/restart tasks, modify firewall rules, generate text or rewrite existing files. `-TestGeneration` cannot be combined with it. Normal setup creates missing recognized components or starts a validated stopped task; incompatible existing components cause a stop. It does not reset a CA, token or saved addresses.

## Runtime and gateway state

The saved runtime location is `%LOCALAPPDATA%\SKAO-AI`. It uses Ollama 0.40.13 and the exact `qwen3:4b-instruct-2507-q4_K_M` model digest. Download metadata and hashes are in `downloads.json`. Downloads come from official release/registry locations. The executable is not included in this bundle.

`Run-Ollama.cmd` explicitly sets loopback `127.0.0.1:11434`, cloud disabled, one parallel request, one loaded model, default context 4096 and keep-alive zero. The `SKAO Local AI` task uses Password logon, Limited privileges, startup delay 30 seconds, priority 7, restart policy and no execution time limit.

The gateway state is `%LOCALAPPDATA%\SKAO-AI\gateway`, including its protected configuration, private CA state, launcher and export directory. The `SKAO AI Gateway` task uses the same account with Limited privileges and startup delay 45 seconds. Both tasks need valid stored credentials after an account password change. Update those credentials locally in Task Scheduler.

Caddy 2.11.7 binds only the saved private laptop IPv4 address on TCP 8443. Its administrative endpoint and persisted configuration are disabled. It uses its internal CA without installing that CA into Windows system trust. It does not enable an access log. The gateway requires the exact Pi source address and dedicated bearer token, strips that token upstream, rejects query strings and restricts request bodies to 64 KiB.

Allowed routes are only GET `/api/status`, GET `/api/tags`, POST `/api/show` and POST `/api/generate`. Other requests return 403. The upstream remains loopback Ollama. The raw-port firewall rule blocks inbound TCP 11434 on every profile; the gateway allow rule is scoped to the Private profile, exact local/remote addresses and the Caddy executable.

Windows readiness uses direct HTTP and CA-verified HTTPS rather than TCP endpoint inventories, listener-state labels or process-to-port mappings. Those inventories contradicted successful direct requests on the existing host; their cause was not established. The private-CA curl check uses `--ssl-revoke-best-effort` for Schannel's unavailable revocation information while retaining certificate-chain and IP/name verification. No insecure TLS bypass is used.

## Pi setup and update

Apply the repository patch through your normal review workflow first. From the Organizer checkout as its normal user:

```bash
bash SKAO.sh ai-setup --check
bash SKAO.sh ai-check
bash SKAO.sh ai-diagnose
```

Checks and diagnostics are read-only. The AI laptop must be awake for network readiness. Diagnostics report bounded stage/error codes and route/reachability results without displaying addresses, tokens, database credentials or raw responses.

For first-time connection import, transfer only `ca.pem` and `ai.env` to the private `~/skao-ai-transfer` directory, then run:

```bash
bash SKAO.sh ai-setup
```

The transfer directory must be owned by the normal Pi account, mode 700; the two files must be owned by it, mode 600. Transfer reuses identical destination files and refuses different content. Existing SSH host keys remain authoritative; verify a new fingerprint using a trusted source.

Pi preparation installs only the public CA at `/etc/skao/ai/ca.pem` when needed. Its root-owned directory is accessible to the native API despite `ProtectHome=true`. The fixed CA installer validates a single public CA, safe source ownership/permissions, nonsymlink paths and a fixed destination. A differing installed CA is preserved and reported as a conflict.

The import preserves all settings outside the six exported connection keys, including `DATABASE_URL` and `SKAO_AI_SOURCES_FILE`. It checks that `server/.env` is ignored and untracked, saves a private exact backup and publishes an atomic mode-600 replacement. Ambiguous multiline assignments and concurrent edits stop the import. Do not replace `server/.env` with `ai.env`, source it in a shell or put it in Git.

Any existing connection key, including `SKAO_AI_MODEL=`, makes the checkout configuration authoritative. Normal updates do not overwrite it from old exports. A small private adoption receipt under `~/.local/state/skao/local-ai/pi-setup.json` contains no secrets and prevents later reimport if all connection keys are removed. `SKAO_AI_SOURCES_FILE` alone is not a connection key.

Normal `SKAO.sh setup` and `update` run offline preparation after their Git pull/reexecution step and before loading AI settings. An unconfigured checkout without transfer files remains unchanged. Configured installations do not need the transfer directory indefinitely. An explicitly blank model disables AI without reactivating stale exports. A configured local-loopback runtime ignores an unused old gateway certificate.

The existing native updater retains its supported operating-system requirements, build checks, database backups and deployment workflow. Commit/review code before a normal update; `update --local` remains the existing option when deliberately deploying reviewed local changes. `ai-setup` prepares settings but does not deploy or restart the application.

Advanced setup options are `--prepare` for offline preparation, `--if-configured` for a no-AI no-op, `--repo PATH`, `--transfer-dir PATH`, `--import` for an explicit reviewed six-key replacement, and `--test-generation` for a synthetic inference check. Read-only modes cannot import or generate. Do not use `--import` to troubleshoot a network outage.

## Verification and daily use

Pi qualification checks authenticated CA/name-verified HTTPS, cloud-disabled metadata and the configured local model. It then checks unauthenticated denial and raw-port isolation. Readiness does not generate content. `ai-check` loads only AI configuration and runtime/knowledge modules; it no longer requires checkout database packages or database-secret loading.

Optional synthetic generation uses the sentence `Local AI is ready.`, bounded context/output and immediate unloading. It contains no personal records. Validate a permitted synthetic activity/summary through Organizer separately, then qualify unattended task startup after a Windows restart. Local mock tests are not proof of native Windows task/firewall behavior or GPU performance.

Below-normal CPU priority and immediate unloading reduce background impact. Inference can still use the GPU and affect daily work. Application generation options can override the runtime defaults; the current activity generator requests a larger context/output than the short setup test. The short test does not establish application latency or memory use.

Keep the private CA keys, gateway configuration and Windows password on the AI machine. Only the public CA and dedicated bearer token are copied to the Pi. The application can send permitted prompt/context data over this authenticated connection; the setup does not anonymize that content or grant the model unrestricted database access.

If a check fails, keep working state and inspect its reported stage/code. Verify saved addresses, task state, trusted network, laptop availability and clocks locally. Do not expose raw port 11434, disable TLS verification or delete CA/token state as a workaround. The saved scripts do not silently change addresses; restore their reservation or plan an explicit reviewed reconfiguration.
