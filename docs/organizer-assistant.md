# Local AI integration (SKAO-92)

Organizer and PostgreSQL stay on the Pi. An optional local AI runtime can run on a different trusted computer. The backend, never a phone or browser, makes the AI request. There is no model download, cloud fallback, direct model database access, shell execution or model-selected tool call.

## What is available

Open **More → AI assistant** on a phone or **AI assistant** in desktop navigation. Choose a room overview, today's attendance, a saved activity week or inventory counts. The model receives a narrow numeric snapshot, and returns a plain-text summary with source labels and a snapshot timestamp. Check the original records before acting; source labels establish the input source, not factual accuracy of the generated interpretation. This is operational summarization, not regulatory advice or a general chat assistant.

Administrators/editors may summarize any accessible room, attendance and saved schedule, plus facility inventory counts. Teachers receive only their currently assigned active room, its schedule and attendance counts. Class viewers receive only their assigned active room and saved schedule; attendance and inventory requests are denied. Unassigned or archived class accounts cannot request a class summary. Existing checked-in employee requirements, password-change requirements, station restrictions, cookies, CSRF and session revocation apply.

The inference request excludes room names/IDs, child identities, attendance rows, activity names/descriptions, staff identities/pay/tax details, health data, database credentials and session credentials. Room data contains configured age limits, capacity and enrollment count. Attendance contains aggregate counts for today. Schedules contain at most 80 saved dates/time slots and a version, without activity text or material details. Inventory contains four aggregate stock counts, not purchase information or individual items. No financial or regulatory context is supported.

A model cannot choose new fields, rooms, URLs, database queries or commands. Unknown input fields are rejected. Only known source identifiers and bounded plain-text outputs are accepted; HTML, image/Markdown links and external URLs are rejected. The UI renders the result as text. Prompts, replies and conversation histories are not stored, browser-cached or logged by Organizer. Clear summary removes the in-memory answer; leaving the page, logout or access loss clears it too. A successful summary creates only an ordinary local audit event (actor, time, action; no prompt, answer, room ID or counts). Existing audit retention rules apply; there is no conversation table to delete.

## Same host or an existing private tunnel

Keep the current configuration:

```dotenv
SKAO_AI_MODEL=YOUR_REVIEWED_INSTALLED_MODEL
SKAO_AI_URL=http://127.0.0.1:11434
SKAO_AI_TIMEOUT_MS=120000
```

The loopback address may also terminate an administrator-managed encrypted forward to the other machine. This release does not create tunnels, SSH keys or remote accounts.

## Separate trusted LAN machine

On the AI computer, keep the actual model runtime bound to loopback, with cloud features disabled. Expose only the four inference/readiness endpoints through an authenticated HTTPS gateway: `GET /api/status`, `GET /api/tags`, `POST /api/show`, `POST /api/generate`. The gateway must verify a dedicated Bearer token, strip it before proxying to the loopback runtime, deny all other paths (including model downloads/management), and accept connections only from the Organizer host. Do not forward Internet ports. Gateway/runtime installation, account selection and network qualification remain SKAO-90; this integration does not install or modify another computer.

Configure the Organizer backend's `server/.env` with the actual reserved private IP and reviewed model, for example:

```dotenv
SKAO_AI_MODEL=YOUR_REVIEWED_INSTALLED_MODEL
SKAO_AI_LAN=1
SKAO_AI_URL=https://192.168.1.50:8443
SKAO_AI_TOKEN=YOUR_DEDICATED_RANDOM_TOKEN_OF_AT_LEAST_32_CHARACTERS
SKAO_AI_CA_FILE=/etc/skao/ai/ca.pem
SKAO_AI_TIMEOUT_MS=120000
```

The token must contain 32–256 ASCII letters, numbers, underscores or hyphens and match the gateway's token; generate it locally and never place it in Jira or source control. `SKAO_AI_CA_FILE` is optional when the AI certificate's issuer is already trusted by Node. Otherwise it names the issuing CA's PEM certificate, not a private key. The certificate must include the configured IP in its subject alternative names. For native deployment, place the CA outside home/checkout/release directories and make it readable by the `skao-api` service account. A final symlink, nonregular file or CA larger than 64 KiB is rejected. No TLS verification bypass is supported.

Only RFC1918 IPv4 literal HTTPS addresses are accepted for LAN operation. Public IPs, hostnames, plaintext LAN HTTP, credentials in URLs, extra paths, query strings, fragments, redirects and environmental HTTP proxies cannot expand the destination. IPv6 LAN gateways are not supported in this first implementation. Loopback IPv4/IPv6 HTTP remains available. Backend settings are administrator-managed; clients cannot choose a host, model or token. Change these settings when migrating to a Jetson; no frontend or database change is required.

The adapter supports the existing Ollama-compatible local API contract. Before inference it requires `/api/status` to report `cloud.disabled: true`, verifies a nonempty installed model with a local digest using `/api/tags`, and rejects remote/cloud model metadata in `/api/show` and inference results. The runtime must support those checks; older runtimes fail closed. These checks and TLS authenticate the configured service but do not prove another machine's network behavior or educational quality. Verify actual runtime isolation/log retention and benchmark the selected model in SKAO-89/90/94.

## Install, validate, deploy

Apply the delivery to a branch from merged development including SKAO-113. No new npm packages or database migration are required. On the development host, run:

```bash
bash scripts/check-update.sh --ai
```

This retains the normal backup/migration, native PostgreSQL, client, build, browser and PWA checks and includes the new assistant/transport tests. Never use a production database as the test database.

After review/commit/merge, on the Pi use the existing single command:

```bash
bash SKAO.sh update
```

Or `bash SKAO.sh setup` for first native installation. Explicit AI settings are merged by the main installer into the backend's protected service environment; no separate AI integration install command is needed. Missing AI settings preserve the existing configuration. A changed LAN URL requires the full URL/opt-in/token tuple in the source `.env` during initial validation. Native deployment retains its existing OS/runtime prerequisites; `check-update.sh` is the development test command.

Check an already configured runtime without generating content:

```bash
bash SKAO.sh ai-check
```

Leaving `SKAO_AI_MODEL` empty disables AI while normal Organizer features continue working. Unavailable AI returns `AI_UNAVAILABLE`; it never falls back to a hosted service. The assistant and activity generator share one inference slot per backend process, bounded deadlines, cancellation on disconnect, bounded response sizes and zero retained chat state. Multi-process installations have one slot per process; the gateway/runtime should also enforce its own resource limits.

## Verification limits

Automated tests use only synthetic records, a deterministic HTTP model substitute, and a real local HTTPS server with a temporary CA. No real model, Pi/Jetson hardware, private LAN gateway, production database or real child information is used. End-to-end deployment to the selected AI computer and real-model quality/privacy checks remain pending. SKAO-91 maintains the regulatory/CH DEV corpus separately; this update does not invent those sources or claim sourced regulatory Q&A.
