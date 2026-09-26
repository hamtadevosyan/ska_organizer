# Static caching and local connections — SKAO-79

The app can keep its public shell on a device so a previously visited app can
explain a lost connection. Records still require the academy server. This change
does not add offline record storage, queued saves or synchronization.

SKAO-79 supplies the caching policy, worker, registration and connection screens.
The manifest, home-screen icons, install/help interface and device installation
review belong to SKAO-80. This change alone is not the finished installable PWA.

## What the worker can store

| Resource | Behavior |
|---|---|
| Built `index.html` | Verified public copy saved during worker installation; used when an app navigation fails or returns 502/503/504 |
| Exact built JS, CSS, fonts and images under `/assets/` | Verified public copies saved during installation; served from that build's cache |
| `/api` and everything below `/api/` | Never intercepted, read from Cache Storage or written to it |
| POST, PUT, PATCH, DELETE and other non-GET requests | Never intercepted, retried or queued by the worker |
| Other origins, downloads and unlisted assets | Not intercepted or cached by the worker |
| Route query strings | Passed to the network normally; never saved as cache keys |

`npm run build` runs Vite, then `scripts/build-service-worker.mjs`. The script
lists only the built HTML and permitted file types under `dist/assets`, records
their SHA-256 hashes and writes `dist/sw.js`. It does not scan the source tree,
environment files, uploaded records, source maps or arbitrary public files.
Keep build assets public; do not put personal information or secrets into them.

Installation fetches those exact files from the app's own origin without
credentials, HTTP-cache reuse or redirects. Every response must match its build
hash before the worker writes any of the build to Cache Storage. A failed
installation removes that new cache. Cache names include the build hash.

There is no runtime cache-write path. Online navigation prefers fresh HTML and
does not store the network response. Known application routes can fall back to
the cached public HTML; unknown routes and API navigations cannot. Static URLs
with query strings bypass the worker's static handler. Missing cached assets
are fetched and verified without adding a runtime cache entry.

API responses already use `Cache-Control: no-store` in Express. Caddy now also
sets it on API responses and its error responses. These headers protect the
normal HTTP-cache path; they do not themselves constrain the Cache API. The
worker's explicit allowlist and absence of API interception enforce that boundary.
Authentication cookies, current CSRF headers and session invalidation remain on
the existing network path. No external service or connectivity probe is added.

## Losing and restoring the connection

- On a cold app load, the session must be checked with the server before private
  screens mount. A network failure, timeout or 502/503/504 shows **We can't reach
  the academy computer**, with an academy Wi-Fi reminder and **Try again**.
- In an already signed-in tab, an outage shows **Connection interrupted** while
  keeping the current screen and unsaved form state mounted. Existing visible
  records may be stale. This state remains in the open page's memory; this change
  does not persist it in Cache Storage, localStorage or IndexedDB.
- **Try again** checks the session; it does not repeat a failed save. A visible
  page also checks every 30 seconds while signed in or reconnecting, and checks
  on focus or a browser connectivity event. Session checks time out after eight
  seconds. They contact the configured academy API, never an internet endpoint.
- A same-session recovery preserves the draft and warns the user to check the
  latest records before retrying a failed save. A failed write may already have
  reached the server. No automatic replay is attempted. Reload to fetch fresh
  records when ready; reloading or closing the page discards unsaved edits.
- A confirmed expired session returns to sign-in and unmounts private screens.
  An unreachable server is not treated as proof of session expiry. Signing out
  still requires the existing server logout; it is not queued while offline.

`navigator.onLine` is only a hint. A tablet can lose internet access while still
reaching the academy computer over Wi-Fi. The app keeps making real API requests
in that situation, even when the browser reports it is offline. This feature
does not configure the network or establish hardware isolation.

The friendly offline startup requires an earlier successful production visit,
worker installation and retained public files. A first-ever visit while offline
cannot load the app. Browsers may clear cached files or refuse registration.
If the worker remains active but its HTML is missing, it returns a small public
connection page; unsupported browsers retain normal online use.

## HTTPS and the local Wi-Fi installation

Service workers require a secure context. Use the existing trusted HTTPS pilot
address on tablets. Plain HTTP at a LAN IP does not qualify. Loopback addresses
such as `http://127.0.0.1` have a development exception; this does not extend to
another device's LAN address. `npm run dev` deliberately does not register this
worker; use a production build for PWA checks.

The tracked pilot uses **Caddy**, with `tls internal` on port 8443. A local CA can
issue its certificates without contacting a public certificate authority. Each
authorized client must trust the pilot's public root certificate and reach the
exact host named in the certificate. A warning bypass is not a substitute for a
trusted secure context. Share only the public root certificate, never CA private
keys. See [Private pilot](private-pilot.md) for the existing address, trust and
update process. Initial builds and dependency installation still need their
normal development access; app operation uses local assets and the local API.

Production authentication also already uses Secure cookies. Reverting production
to plain HTTP requires revisiting that existing authentication configuration; it
is not part of this task. No network, router or tablet hardware change is needed
to review the implementation on loopback.

`deploy/pilot/Caddyfile` serves `/sw.js` explicitly with a JavaScript content
type and no-store/revalidation headers. Missing workers and assets do not receive
the SPA's HTML fallback. API errors remain no-store. The existing web Dockerfile
runs the updated build and copies the resulting worker with the other files.

## Updates and validation

The worker registers only for a secure production build, with
`updateViaCache: 'none'`. It does not call `skipWaiting` or reload open pages.
An updated worker waits for tabs controlled by the old worker to close; after
activation it removes only older `skao-static-v1-` caches. Close all app tabs and
reopen after a release when ready to discard or finish unsaved work. Installation
and update help in the app are follow-up work in SKAO-80.

From `client`, run `npm run build`, `npm run test:pwa`, `npm test`, then the two
browser suites sequentially: `npm run test:browser` and
`npm run test:browser:pwa`. The PWA suite builds the production app and uses a
disposable API, so it exercises registration instead of the development server.
See [START-HERE](handoffs/SKAO-79-START-HERE.md) for setup and manual review, and
[verification](handoffs/SKAO-79-VERIFICATION.md) for what was actually run.

The pilot CI workflow also validates the actual Caddy configuration and checks
the served worker through HTTPS. A loopback test does not replace that gate or
the eventual device/browser installation checks.

## Platform references

- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [MDN: Cache API and HTTP-cache headers](https://developer.mozilla.org/en-US/docs/Web/API/Cache)
- [MDN: why navigator.onLine is unreliable](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)
- [Caddy: local HTTPS and certificate trust](https://caddyserver.com/docs/automatic-https)
- [W3C: Service Workers lifecycle](https://www.w3.org/TR/service-workers/)
