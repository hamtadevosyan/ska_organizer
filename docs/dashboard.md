# Daily dashboard

Open **Dashboard** for a quick overview. **Refresh dashboard** reads the latest saved records. Returning from another page also refreshes it. The update time and facility time zone are shown beside **Right now**.

The three headcounts and stock levels always describe the current situation. **Plan date** changes only the meals and room activities; **Today** follows the facility's current date. The dashboard never generates a menu, saves a draft, reserves supplies or changes attendance.

Click **Open attendance**, **Open children**, or **Open staff** to work on those records. Click **Running low** or **Out of stock** to go straight to that filtered inventory list. Use **Open meal planner** or **Open activity planner** to edit plans in those pages.

## Definitions

| Display | Definition |
|---|---|
| Enrolled children | All child records whose enrollment is active, including unassigned children. No page-size limit. |
| Present now | Distinct children with an open, non-voided visit that started on the current facility date at or before the displayed update time. Departed children are excluded. If any open visit is from an earlier date, is marked for review, has a missing/future check-in, or duplicates another child's open visit, the count is withheld and **Check attendance** is shown. It is a recorded attendance count, not a physical headcount. |
| Active Staff | All active staff-directory records, including unassigned staff. This is not staff attendance or the number of login accounts. |
| Running low | Inventory item records with quantity greater than zero and at or below their configured low-stock level, across all groups and storage locations. |
| Out of stock | Inventory item records with quantity exactly zero, even when their low-stock level is zero. These are excluded from Running low. |
| Inventory total | All inventory item records. One ingredient in two locations is two item records; units and amounts are not added together. |
| Meals | Selections from the saved weekly menu containing the selected date, using the saved meal names. Unsaved drafts, generated-but-unsaved menus and undated legacy menus are excluded. The existing meal planner covers Monday–Friday, so weekends show no saved meals. |
| Room activities | Saved schedule entries for the exact selected date, in time order and grouped by room, with no daily entry limit. Names come from saved activity snapshots. Archived rooms remain visible when they have entries on that date. Legacy morning/midday/afternoon entries retain their recorded block instead of an invented time. An active room with no entries shows an empty state. |
| Recent changes | Latest ten committed operational audit records, newest first across all dates. Includes roster, attendance, room, staff, inventory, purchasing, meal/recipe and activity/schedule actions. Sign-in and account/security actions are excluded before taking the latest ten. Summaries omit usernames, raw record identifiers and private details. An acknowledged retry can have another recorded audit event; this is an audit list, not an activity counter. |

Catalog corrections do not rewrite the names in saved plans. Stock and enrollment totals are current even when viewing an older plan date. Counts come from database count queries, not the first page of a directory. Sections are independent reads, not a historical or globally atomic reporting snapshot; refresh after concurrent edits settle when comparing records.

## Empty states and failures

A successful read of empty storage displays zero or a clear empty state. A failed section displays a retry button and no substituted zero. Other sections remain usable. A whole-request failure hides old totals until a successful retry. Changing dates cancels older requests so a late response cannot replace the newly selected day. Page access follows the same session and admin/editor/viewer permissions as the existing operational pages.

## API

`GET /api/dashboard` uses `FACILITY_TIME_ZONE` (default `America/Los_Angeles`) to choose today. `GET /api/dashboard?date=2026-09-14` reads plans for a different calendar date. Only `date` is accepted; invalid dates or repeated query values return 400.

The response contains `today`, `date`, `weekStart`, `timeZone`, `takenAt`, and `sections`. Each section is either `{ "data": ... }` or `{ "error": "..." }`. Section keys: `enrollment`, `attendance`, `staff`, `inventory`, `meals`, `activities`, `changes`. A partial response is HTTP 200 with explicit section errors. The compatibility fields `totalStudents`, `totalStaff`, and `inventoryCount` are included only when their source succeeds. All responses use `Cache-Control: no-store`.

This change uses the existing schema and audit records. It adds no migration or dependency.

## Verification

Use the normal full update checks from the repository root:

```bash
bash scripts/check-update.sh
```

Focused checks when investigating a dashboard problem:

```bash
cd server
npm test -- --runTestsByPath tests/dashboard.test.js tests/staff.test.js
npm run test:postgres -- --runTestsByPath tests/dashboard.test.js tests/staff.test.js
cd ../client
npm test -- src/pages/Dashboard.test.tsx src/pages/Inventory.test.tsx src/pages/Staff.test.tsx
npm run test:browser -- tests/browser/dashboard.spec.ts tests/browser/staff-directory.spec.ts
```

For a manual check, compare enrollment/staff counts with the directory totals; check a child in and out; create zero, low, and available stock; save meals and activities for two dates; then refresh the dashboard. Confirm the correct snapshots and empty days, direct inventory links, and that viewing the dashboard leaves stock and saved plans unchanged. Runtime verification and visual checks on the Ubuntu/Windows setup must be completed before integration.
