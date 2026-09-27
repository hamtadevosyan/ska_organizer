# SKAO-80 verification

Base: `071c9577555175834890175bdc3f2801df3329ca` (`development`, PR #19).
Prepared September 26, 2026 (America/Los_Angeles). SKAO-79 is closed at the
owner's request. SKAO-80 remains In Progress pending owner integration/review.

## Executed

| Check | Result |
|---|---|
| TypeScript and production Vite build | Passed; worker covers 10 verified public files |
| Client unit/component tests | 155 passed across 16 files |
| Worker/installation-asset tests | 10 passed; includes the existing eight cache-boundary checks |
| ESLint | No errors; the pre-existing MealsManagement hooks warning remains |
| New PWA browser suite strict TypeScript | Passed |
| PWA browser test discovery | 4 tests found; no browser launched |
| Edited deployment workflow | YAML parsing passed |
| Icon review | Inspected exported academy crest; PNG dimensions/opaque RGB checked |

Vite reports one JS chunk slightly above its 500 kB warning threshold (about
501 kB, 148 kB gzip). This is a successful build, not a suppressed warning.

The new unit tests cover user-initiated/single-use installation, cancellation,
browser confirmation, manual Apple instructions, standalone/insecure contexts,
failed registration, waiting updates that preserve a draft, retryable update
checks, throttling and listener cleanup. The eight worker tests still execute
generated worker code in a Node VM with mocked browser cache/network objects.
The two asset tests check the built manifest, icons, HTML metadata and public
cache membership. They do not establish native installability by themselves.

## Pending owner/CI checks

- Run 26 existing browser cases and 4 PWA browser cases. The new cases inspect
  Chromium's parsed manifest and icon responses, plus 320 px setup navigation,
  focus restoration and an open draft. Local browser access was blocked in this
  environment; no native browser execution is claimed.
- Run the updated pilot CI with Docker/Caddy. It checks served manifest headers
  and PNG files over trusted HTTPS, alongside existing worker/auth checks.
  Neither Docker nor Caddy is available in this workspace.
- Exercise a real two-window, two-build update as described in START-HERE.
  Confirm no forced reload and activation after all old windows close.
- Install and launch on the intended Android and iPhone/iPad browsers. Check
  the icon, standalone display, certificate trust, sign-in, safe areas, keyboard,
  logout and connection recovery. Desktop emulation is not a substitute.
- Validate browser-managed installation and device policy for the future fully
  isolated network. Android WebAPK packaging can contact a provider; this task
  does not prove zero egress from the OS/browser.

No dependencies, migrations, live records, network settings or deployment were
changed. No commit, push or merge was made. The reviewed patch/ZIP are for the
owner's test/commit/merge workflow; `PACKAGE-VERIFICATION.txt` records the base,
exact patch reconstruction and archive checks.
