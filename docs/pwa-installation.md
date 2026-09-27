# Install Smart Kids Academy — SKAO-80

**App setup** is available on the sign-in screen, in the desktop toolbar, and
under **More** on phones. It explains installation and lets a user check for
updates. Installation does not bypass sign-in or provide offline record access.
The approved academy crest is used for the launcher icons.

## Add the app on a device

Use the academy's normal trusted HTTPS address on its Wi-Fi. The certificate
must already be trusted by that device; do not bypass browser certificate
warnings. Plain HTTP at a LAN address does not provide the required secure
context. See [Private pilot](private-pilot.md) for the current deployment.

| Device/browser | Steps |
|---|---|
| Android / Chrome | Open App setup. Use Add to home screen when offered, or Chrome's menu > Install app / Add to Home screen. Confirm and open the academy icon. |
| iPhone / iPad / Safari | Open the academy link in Safari. Choose Share (possibly in the page menu), then Add to Home Screen. Enable Open as Web App if shown, then Add. |
| Desktop Chrome / Edge | Use the browser's install control or App setup when a native install offer is available. |

The full application name is **Smart Kids Academy**. Where the OS needs a short
label, it uses **Smart Kids**. The icon opens `/dashboard` with standalone display
requested. The existing account gate still decides whether to show sign-in,
password change or the authenticated app. Some platforms use separate sign-in
storage for an installed app, so a first launch may require signing in again.

A native install button appears only after the browser provides an install
offer. It is never clicked automatically. Cancelling consumes that particular
offer; the manual steps remain available. An accepted prompt is not called
installed until the browser reports `appinstalled` or standalone launch is
detected. Standalone detection also supports Safari's `navigator.standalone`.

Browser support and device policies determine whether this becomes an installed
app or a shortcut. The OS may shorten the label. If installation is unavailable,
normal browser access remains supported. Native device acceptance is required;
manifest validation alone cannot prove successful home-screen installation.

## Local operation and installation privacy

The application adds no analytics, remote fonts, push service or external API.
Its operational requests still go to the configured academy server. SKAO-79's
static-only cache and auth/CSRF behavior remain unchanged. Records and failed
saves are not cached or queued by the worker.

Browser-managed installation is a separate boundary. Android Chrome can ask a
provider's cloud service to create a WebAPK using app metadata. The app address,
name and icon can leave the device in that process. The manifest contains only
public branding and a fixed start URL, without child IDs, room queries, account
information or tokens. This implementation does not make Chrome installation a
guaranteed offline or zero-egress process. App setup discloses this on its Android
instructions. Fully isolated devices can keep using the browser until their
installation method and network policy are validated in the later device work.
No firewall, router, network or device management setting is changed by SKAO-80.

## Updating without losing an open form

The app registers the existing `/sw.js` in secure production builds. The worker
continues to wait for old controlled windows to close: it never calls
`skipWaiting` and the page never reloads automatically. The provider watches for
an already waiting update and for new installation/state changes.

Long-lived visible windows check hourly. Returning to the app or receiving an
online hint also checks, with a five-minute throttle and no check skipped just
because the browser reports no internet. **Check for updates** requests a manual
check. Failures show a retry message without blocking normal use.

When **New version ready** appears:

1. Finish and save work in every academy window.
2. Close all academy browser tabs and installed app windows. On phones, close
   the installed app in the app switcher as well.
3. Reopen the academy app while connected to the local server.

An open old tab intentionally delays worker activation. A normal refresh alone
does not guarantee activation while other tabs remain open. Online navigation
continues to prefer fresh HTML, as in SKAO-79. If a server update is in progress
and public files do not match their hashes, worker installation fails safely
and a later check retries. No partial build is accepted.

The first move from SKAO-79 to SKAO-80 requires closing old windows once; the
older frontend did not contain the new update notification. Future versions
built on SKAO-80 can display it. Updates to an OS-owned label/icon may follow
the browser's own schedule rather than the frontend update timing.

## Vite and the deployed files

This extends the existing Vite integration instead of adding a second worker:

- `client/public/manifest.webmanifest` is linked in `index.html`; Vite copies it
  unchanged. Its identity and scope are `/`, with `/dashboard` as the start URL.
- Public PNGs under `client/public/assets/icons/` supply 192 and 512 px normal
  icons, a 512 px maskable icon, and a 180 px Apple touch icon.
- `npm run build` compiles the client and finalizes the existing hash-verified
  worker. The four public icons are included under its existing assets rule.
  The manifest stays on the network path so it can be revalidated.
- Registration moved into `PwaProvider`, which also owns the install event and
  update subscriptions and cleans them up on unmount. Development builds do not
  register a worker or display a native install offer.
- No dependency or lockfile change is needed. No generic runtime API caching is
  introduced.

The tracked pilot uses **Caddy**, not nginx. The existing web Dockerfile runs the
same Vite build and copies the whole `dist` directory. Caddy now serves the
manifest explicitly as `application/manifest+json` with no-store/revalidation
headers. Worker serving and the existing API no-store headers remain intact.
The pilot CI gate downloads the served manifest and all launcher icons over its
trusted synthetic HTTPS origin. An older untracked nginx setup must be checked
separately; no compatibility test of such a configuration is claimed here.

## Icon source

Icons are size/padding exports of `client/src/assets/brand/academy-logo.png`,
with the existing brand background `#fffcf3`; the crest has not been redrawn.
The maskable export fits the entire crest inside a centered 280 x 280 box on a
512 px square, within the central safe circle. Normal 192/512 px exports use
160/432 px content boxes; Apple uses 148 px content on a 180 px square.
All are opaque RGB PNGs. To regenerate with ImageMagick, from the repo root:

```bash
convert client/src/assets/brand/academy-logo.png -resize 160x160 -gravity center -background '#fffcf3' -extent 192x192 -strip PNG24:client/public/assets/icons/academy-192.png
convert client/src/assets/brand/academy-logo.png -resize 432x432 -gravity center -background '#fffcf3' -extent 512x512 -strip PNG24:client/public/assets/icons/academy-512.png
convert client/src/assets/brand/academy-logo.png -resize 280x280 -gravity center -background '#fffcf3' -extent 512x512 -strip PNG24:client/public/assets/icons/academy-maskable-512.png
convert client/src/assets/brand/academy-logo.png -resize 148x148 -gravity center -background '#fffcf3' -extent 180x180 -strip PNG24:client/public/assets/icons/apple-touch-icon.png
```

ImageMagick is only needed to regenerate these checked-in icon assets, not to
install dependencies, build the app or run the pilot.

## Verification and references

Use [START-HERE](handoffs/SKAO-80-START-HERE.md) for owner checks, including the
two-window update exercise. [Verification](handoffs/SKAO-80-VERIFICATION.md)
separates executed tests from pending native browser and device checks.

- [MDN: installability and manifests](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN: app icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons)
- [MDN: triggering installation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt)
- [MDN: checking a worker for updates](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/update)
- [Apple: add a Safari website as an app](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- [Google: browser installation and WebAPK packaging](https://web.dev/learn/pwa/installation)
