# Mobile navigation

The signed-in app uses a compact header and a floating bottom navigation below
768 CSS pixels. At 768 pixels and above it keeps the desktop sidebar and
header account controls. No API, authentication, database, HTTPS, or PWA
installation settings are changed by this layout.

## On a phone

- **Home** opens the existing `/dashboard` page.
- **Attendance** opens `/attendance`.
- **Activities** opens `/activities`.
- **Meals** opens `/meals`.
- **More** opens Children, Rooms & Classes, Inventory, Staff, Reports, and account actions. Accounts is visible only to administrators,
  matching the desktop navigation; server-side permissions are unchanged.
- More also contains the signed-in user's name, role, Change password, and
  Sign out. Password changes and sign-out use the existing authentication flow.

The selected page is highlighted. More stays highlighted on secondary pages,
including filtered URLs such as `/inventory?status=low`. Existing bookmarks,
the `/` dashboard redirect, and the `/schedule` activity-planner redirect remain
unchanged. The bottom bar is not mounted while signed out or while a temporary
password change is required.

The More sheet closes after selection, with its close button, on an outside tap,
or on Escape. Native modal behavior keeps keyboard focus inside the sheet and
makes background controls inactive. Browser history changes and switching to
desktop width close the sheet. Dismissal restores focus to the opening control
when it is still present.

## Layout and limitations

- The HTML viewport uses device width and `viewport-fit=cover`; zoom is not disabled.
- Navigation controls have at least 44-by-44 CSS-pixel targets.
- Bottom spacing reserves the navigation height plus the device's safe-area inset.
- The header and sheets also account for safe-area insets.
- Existing wide pages can scroll horizontally within the main content region.
  Home and Attendance use the approved SKAO-96 design; the remaining operational pages retain their existing forms and tables.
- Print layouts exclude the application navigation and its mobile spacing.
- This is a responsive website change, not a PWA installation or offline feature.

## Automated checks

From `client/`:

```bash
npm ci
npm run build
npm run lint
npm test
npx playwright install chromium
npm run test:browser -- tests/browser/mobile-navigation.spec.ts
```

The browser tests require the server dependencies (`npm ci` from `server/`).
The existing Playwright configuration starts its isolated, synthetic in-memory
API fixture and frontend on loopback. It does not use the pilot database,
real accounts, or deployment configuration.

The navigation tests cover 320, 375, 390, and 430 px phone viewports; fixed-bar
position and content clearance; actual routes and current-page indicators;
keyboard focus and modal dismissal; password cancellation and sign-out;
session expiry; history; and switching back to the desktop sidebar. Component
tests cover administrator/editor/viewer navigation permissions, the existing
password-change handler, and failed sign-out feedback. The existing browser
authentication suite continues to verify server-side account permissions.

## Real-phone smoke test

After applying the update to a test installation:

1. Open it in iPhone Safari and Android Chrome; sign in with a test account.
2. Visit Home, Attendance, Activities, Meals, and every More destination.
3. Scroll to the bottom; confirm the last action is reachable above the bottom bar.
4. Rotate the phone, open and close More, and use the browser's back button.
5. Open Change password; check keyboard/field visibility, scrolling, and Cancel.
6. Check an administrator and a non-administrator account; sign out and confirm
   private navigation disappears.
7. On a notched/home-indicator device, check that navigation is not covered.
8. Check the desktop sidebar and a report/activity print preview.

Desktop browser emulation cannot fully validate physical keyboard behavior,
home-indicator insets, or every mobile browser's UI. Record those checks separately
from automated results.
