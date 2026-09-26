# SKAO-77 — remaining core phone layouts

Baseline: `development` commit `b09ebbe`, including SKAO-78 (PR #15),
SKAO-96 (PR #16), and the SKAO-66 review documents (PR #17).

SKAO-77 overlaps the earlier work but was not fully completed by it. Its three
acceptance criteria are: core workflows without horizontal page scrolling,
easy-to-reach touch actions, and usable desktop layouts. The shell and visual
identity are reused; this increment fills the remaining page-layout gaps.

## Coverage comparison

| Area | Already merged | This increment |
| --- | --- | --- |
| Navigation, More, account dialogs | SKAO-78: phone dock, desktop sidebar, safe-area spacing, focus and account flows. SKAO-96: Bloom appearance. | Reused without changes. |
| Home | SKAO-96: action cards, real summaries, responsive panels and branded artwork. | Reused without changes. |
| Attendance | SKAO-96: child cards, next action, expandable details, search and role-aware controls. | Approved design retained. The owner's browser run exposed long-room-name overflow at 320/390 px; a follow-up wraps labels, lets grid/flex columns shrink and stacks phone filters. |
| Children | Forms and filters already stack, but the roster stays a five-column table with small inline actions. | Labeled phone cards keep View/Edit/End enrollment beside each child. Profile history adapts too; long names and form actions wrap. |
| Meals | Menu and shopping sections partly stack, but nested page padding, a large banner, fixed tab sizing and crowded section headers waste narrow-screen space. Printable shopping quantities stay in a wide table. | Compact Bloom header, wrapping tabs/actions, smaller phone panel padding, full-width week controls, and labeled shopping records on screen. Print remains a table. |
| Activities | Full-day planning, seven days and unlimited entries already work. Times/selection use a fixed multi-column row at small tablet widths. | Better room/week/control sizing, stacked time fields on very narrow phones, later breakpoint for the wide activity row, and readable materials cards. No planner workflow changes. |
| Inventory | Group tiles and basic item cards already exist below 640 px. History/filter controls and intermediate widths remain uneven. | Consistent labeled item cards through small tablet sizes; purchase history cards, wrapping history/pagination, and stacked form/filter controls. |
| Staff | Edit form stacks, but the directory/actions remain in a wide table. | Labeled staff cards, visible actions, wrapping header/pagination, and fluid filters. |
| Reports | Filters already partly stack; results remain wide tables. | Labeled result cards, dates stacked until there is enough space, and wrapping pagination. Full report print and CSV behavior are retained. |

The source review found these concrete layout gaps; the browser tool could not
open the loopback test app in this environment. No before/after browser
screenshots or measured phone rendering are claimed.

## Implementation boundaries

`client/src/styles/core-screens.css` applies only to the six remaining operational
pages marked `ska-core-page`. Home, Attendance and the navigation shell keep their
own approved styles. It uses the existing local font, colors and icons; no new
font/image service, analytics, dependency or network request is introduced.

The later Attendance overflow correction updates its own stylesheet with
wrapping and sizing rules. It retains the existing screen structure, colors and
attendance behavior. The long-name browser width checks remain in place.

Record tables become labeled cards at screen widths up to 1023 px, with a single
column for very narrow phones. The same DOM contains the data and actions;
there are no duplicate mobile and desktop forms. Explicit table roles and column
headers preserve table structure for assistive technology. Labels are also shown
visually beside the phone values. Verify screen-reader behavior on target devices.

Forms use constrained widths, long text can wrap, and core buttons/selects have
44 px minimum heights. Phone text fields use 16 px text. Checkbox/radio labels
provide a larger target. Card transformation rules are screen-only; report and
shopping printouts retain their original columns and all records.

No business state, API payload, permissions, save/retry/conflict handling,
attendance behavior, inventory arithmetic or database schema changed. The
Activity Planner proposal, copy/move/undo features and draft-protection follow-ups
from SKAO-66 are not implemented here. The owner deferred that review until AI
integration. PWA caching/install work remains in SKAO-79/80.

## Verification

- Production TypeScript/Vite build passed.
- All **128 client tests across 14 files passed**, covering role restrictions,
  drafts, save/reload, cancellation, inventory, attendance and print/export data.
- ESLint: **0 errors**, one existing `react-hooks/exhaustive-deps` warning in
  `MealsManagement.tsx` at line 91.
- A focused browser check is included in `client/tests/browser/core-screens.spec.ts`.
  It uses synthetic long-name records at 320, 390, 768 and 1280 px, checks the
  document and main content widths, measures core control heights, opens profile
  and edit forms, and checks report table printing. It is an additional guard;
  existing workflow/browser tests remain in place.
- **Browser checks were not executed here.** The browser tool returned
  `net::ERR_BLOCKED_BY_CLIENT` when opening the local synthetic test app. No
  alternative browser or route was used to bypass that block. Browser test
  TypeScript/static checks are recorded in the delivery verification file.
- No server tests, real-record operations, database migration, or deployment was
  needed for these presentation changes. Physical-device, keyboard and print
  rendering checks are still required before calling SKAO-77 complete.

## Acceptance walkthrough

Use the synthetic browser fixture described in START-HERE, then repeat on the
test installation. Check 320/375/390/430 px phone widths, a tablet and desktop.

1. Home and Attendance: confirm the approved cards, navigation and next actions
   remain familiar; search and open a synthetic child's attendance details.
2. Children: filter/search, view a profile and its history, open Edit, cancel,
   then save a synthetic change. Names, dates and actions must remain reachable
   without moving the main page sideways.
3. Staff: search/filter and edit a synthetic record as admin. On an editor/viewer
   account, confirm the existing restriction on staff changes still applies.
4. Inventory: open a group, receive a synthetic purchase, record usage, and open
   movement/purchase history. Check optional details and pagination with long
   names/locations. Reports and planner views must not change quantities.
5. Meals: generate an example week, choose meals, adjust counts, change tabs,
   save/reopen, and read the shopping list. Create/edit a recipe and check its
   quantity controls. Print the shopping list; verify every quantity and column.
6. Activities: select room/week, add more than five activities, edit times,
   inspect materials and save/reload. Confirm the existing workflow and full-week
   printing still work. New copy/move/prototype behavior is intentionally absent.
7. Reports: change dates/room/type, inspect populated attendance and purchase
   results, paginate, print and export CSV. Screen cards must not truncate print
   records or change CSV data.
8. Rotate a phone, use keyboard navigation, zoom, test long content, and reach
   the bottom of each page above the navigation bar. Recheck desktop tables and
   all print views after narrowing the window.

SKAO-77 stays In Progress for the handoff and native-browser/device validation.
The owner continues to test, commit, push and merge locally.
