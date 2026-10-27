# Local AI activity ideas — SKAO-93

The Activity Planner now has **AI activity ideas** beside **Generate week**. AI can propose new activities rather than choosing only from the saved catalog. Choose a learning focus, optional theme, duration and number of ideas. Review each suggestion, inspect any supplied reference excerpts, edit its details and choose **Save activity**. Use **Generate week** or **Add activity** to schedule saved activities, then **Save week**.

Generating ideas does not save activities, edit a week, change attendance or use inventory. AI material suggestions remain notes until a person links Inventory items and quantities in the normal activity form. That keeps the existing purchasing review and material validation in use.

This is the first implemented part of SKAO-93. General source-based questions, a maintained Title 22/CH DEV document collection, model benchmarking and release qualification remain in SKAO-89–94. There are no bundled course notes or invented regulatory citations. Model output is educational draft content requiring staff review, not a verification of age suitability or licensing compliance.

## Configure an already installed local runtime

The current adapter supports Ollama's local HTTP API. It is replaceable; Ollama or any particular model has not been selected as the benchmark winner. This update installs no runtime or model, performs no download, and changes no Windows, router, firewall or device settings. Model licensing and hardware performance must be evaluated before selecting an artifact for actual use.

The runtime may run on the same host, through an administrator-managed loopback forward, or on an explicitly configured private HTTPS AI machine as described in `docs/organizer-assistant.md`. Bind it to `127.0.0.1`, enable `OLLAMA_NO_CLOUD=1`, and restart the runtime. The adapter first requires `/api/status` to report `cloud.disabled: true`, then checks that the configured model is installed locally and has no remote-model metadata. Older runtimes without this status API fail closed. Configure no hosted model, cloud alias or externally accessible runtime URL.

Add these settings to the checkout's `server/.env`, using the exact name of your already installed, reviewed local model:

```dotenv
SKAO_AI_MODEL=YOUR_INSTALLED_LOCAL_MODEL
SKAO_AI_URL=http://127.0.0.1:11434
SKAO_AI_TIMEOUT_MS=120000
# Optional reviewed non-personal reference collection:
# SKAO_AI_SOURCES_FILE=/etc/skao/ai/references.json
```

`SKAO_AI_MODEL=` disables the feature. By default the URL accepts a literal loopback address only; the SKAO-92 private HTTPS option requires explicit opt-in and a dedicated token. clients cannot select an endpoint or model. Timeout is bounded to 300,000 ms. Slow or unavailable AI never triggers a cloud fallback. Keep the runtime's management API off the LAN and public domain.

From the repository root, run the read-only diagnostic:

```bash
bash SKAO.sh ai-check
```

It checks local configuration and model availability without generating content, installing anything, loading a model or requiring sudo. It reports basic host resources to help with the later model benchmark. Readiness does not measure educational quality or establish a licensing/compliance decision.

For development, restart the ordinary backend after changing its environment. For an existing native Ubuntu installation, apply the code, review it, then run your usual `bash SKAO.sh update --local`; explicitly supplied AI settings are merged into the installed service environment. Settings absent from `.env` keep their installed values. A reference file for the native service must be outside the checkout and home directories: the service uses `ProtectHome=true`. Create it with administrator-reviewed contents and read permission for the service account. Do not place credentials or child, family, staff or medical records in the source collection.

## Optional reviewed references

Without a reference collection the feature can still suggest educational ideas, with a visible missing-sources warning. To supply references, prepare a UTF-8 JSON file with actual permitted excerpts and accurate metadata. The empty collection is:

```json
{"version": 1, "sources": []}
```

Each entry in `sources` requires these fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable, unique identifier of up to 64 letters, numbers, underscores or hyphens |
| `title`, `publisher` | Actual document title and issuing organization, each up to 160 characters |
| `version` | Document version/effective or retrieval date, up to 80 characters |
| `section` | Actual page or section identifier, up to 120 characters |
| `kind` | `education`, `policy` or `regulation` |
| `text` | Exact reviewed excerpt, up to 1,200 characters |
| `ageMinMonths`, `ageMaxMonths` | Applicable age range, 0–216 months, maximum greater than minimum |
| `superseded` | Optional boolean; true excludes the excerpt |
| `topics` | Optional list: `balanced`, `language`, `creative`, `physical`, `discovery`, `social` |

Only non-superseded educational or policy excerpts covering the entire selected room age range are eligible. Simple local keyword/topic ranking selects at most six; no embedding service or internet search is used. Regulatory excerpts are retained in the collection but excluded from prompts until license/program applicability and regulatory verification are implemented in SKAO-91. Do not relabel regulations as educational guidance to bypass that restriction.

The file is limited to 256 KiB and 100 excerpts. Relative paths, final symlinks, nonregular files, malformed metadata and duplicate identifiers are rejected. An invalid configured collection stops AI generation instead of silently dropping its sources. The file is read again on each request; replace it atomically with a reviewed version to update it. Keep the previous version for rollback. References appear as local plain-text excerpts with title, publisher, version and section; no external page is loaded. A source ID must belong to the actual retrieved set. This prevents invented reference identities; it does not prove that a model's interpretation of a cited excerpt is correct.

## Access, limits and privacy

Only administrators and editors can draft and save activities in this first implementation. Teacher/class-viewer screens retain their existing permissions. A linked employee must be checked in. Session, role and work status are checked before inference and again before returning its result. Logout, expiry or the employee access gate clears the protected UI; in-flight client requests are cancelled using the existing transport.

The backend supplies room age bounds, selected educational options and approved source excerpts. It does not fetch child identities, health/emergency information, staff/payroll records, passwords or documents for model context. Do not put personal details in the optional theme. The model receives no tools, database credentials, file selectors, commands or arbitrary URLs. Its response is bounded and validated, displayed as text and edited using the existing activity form.

One generation is allowed at a time per backend process. Requests have a deadline, bounded input/output, fixed context/output-token limits, and cancellation on client disconnect. Prompts, responses and conversations are not persisted or logged by this application. A saved activity uses the ordinary database/audit history. Check the runtime's own logs and network behavior before a real-data release; this application cannot independently guarantee the behavior of another process or a forwarded host.

## Verification and remaining work

Regression tests use synthetic source excerpts and a deterministic loopback HTTP runtime, never real children or a hosted model. They cover authorization, CSRF, check-in gating, local-only runtime verification, rejected cloud aliases/redirects, invalid/oversized outputs, cancellation, timeout, concurrency, source filtering and explicit save/schedule behavior. This verifies the integration, not the quality of an actual language model.

Before operational use, complete model selection/benchmarking (SKAO-89), local runtime deployment and offline network observation (SKAO-90), the approved source collection (SKAO-91), broader assistant access integration (SKAO-92) and held-out quality/privacy qualification (SKAO-94). The app remains useful with AI disabled.

API behavior follows the official [Ollama generation API](https://docs.ollama.com/api/generate) and [local-only configuration guidance](https://docs.ollama.com/faq). The adapter deliberately requires the runtime's cloud-disabled status rather than assuming that a loopback address alone guarantees local inference.


SKAO-92 adds a read-only scoped operational assistant and shared loopback/private-HTTPS transport. See `docs/organizer-assistant.md` for the role matrix, snapshots, retention and separate-machine configuration. General regulatory questions and source retrieval remain separate work.
