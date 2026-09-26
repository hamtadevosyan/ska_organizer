# SKAO-79 verification

Base: `e987440d8477803fa9bbadc7bd75e0da09cbddfb` (`development`, PR #18).
Prepared on 2026-09-26. SKAO-77 was closed at the owner's request; SKAO-79 is
In Progress pending owner review and integration.

## Executed successfully

| Check | Result |
|---|---|
| Production TypeScript/Vite build | Passed; generated `dist/sw.js` with 6 verified public files |
| Client Vitest suite | 142 tests passed across 15 files |
| Generated worker policy suite | 8 tests passed against the actual built worker in a Node VM |
| ESLint | No errors; one existing hooks warning in `MealsManagement.tsx` |
| Strict TypeScript check of new PWA browser suite/configurations | Passed |
| Playwright test discovery | New PWA suite discovers 2 tests; discovery does not launch a browser |
| GitHub Actions YAML parsing | Both edited workflows parse |

The client tests cover unavailable startup, recovery without unmounting a draft,
expired sessions, misleading browser offline hints, registration gating and API
error notification without request replay or CSRF removal. Existing auth and
business-component tests remain included.

The worker tests execute the generated JavaScript with mocked cache/network
objects. They verify exact public hashes, credential-free installation, API/write
bypass, public offline fallback, uncached online navigation, failed integrity
checks, scoped old-cache cleanup and missing-cache behavior. These checks are
not a substitute for a real browser's native service worker lifecycle.

## Still required

- Run the 26 existing browser cases and 2 new production-build PWA cases.
  Local browser access was blocked in this environment; no native browser pass
  is claimed. The new cases cover offline reload without private records,
  recovery, Cache Storage contents, logout and preserving a draft during a 503.
- Run the pilot deployment CI gate. Docker and Caddy are unavailable in this
  workspace. CI validates the actual Caddy configuration, builds the images and
  checks the HTTPS worker response and existing authentication behavior.
- Check the connection screen at phone widths, then a real authorized device
  using the trusted local HTTPS address. Verify the local app remains usable
  when internet access is absent but its local server is reachable.
- Review update activation after closing app tabs. Installation prompts,
  manifest/icons and broader device installation review remain SKAO-80.

There was no production deployment, live network change, migration, commit,
push or merge. Test data is synthetic. The patch and archive are prepared for
the owner's test/commit/merge workflow; delivery checks are recorded in the
package's `PACKAGE-VERIFICATION.txt`.
