# Saved weekly menus (SKAO-18)

The planner stores each calendar week separately. Saving records the meals,
child/staff counts, recipe ingredients and quantities, and in-house stock in one
atomic snapshot. Reopening a week restores that snapshot, including historical
ingredient names and units. Later recipe edits do not rewrite it.

## Update your existing Ubuntu installation

After bringing this branch into `~/workspace/ska_organizer`, stop both running
servers with Ctrl+C. Keep your existing PostgreSQL databases and `.env` files.

```bash
cd ~/workspace/ska_organizer/server
npm ci
npm run db:migrate
npm test
npm run test:postgres
```

Migration `002-weekly-plans` adds `WeeklyPlans`. It leaves existing tables and data
intact. Migration is required before restarting the backend. You do not need to
recreate database users or run the development seed again.

```bash
cd ~/workspace/ska_organizer/client
npm ci
npm run build
npm run lint
npm test
npm run dev
```

In your second Ubuntu terminal:

```bash
cd ~/workspace/ska_organizer/server
node index.js
```

Open the Network URL printed by Vite in Windows Chrome. Your configured
`VITE_API_BASE_URL` is used when present; otherwise the frontend connects to port
3001 on the same host that served the page. Your usual startup commands are unchanged.

## Plan a week

1. Open **Meals → Planner** and select **Week starting Monday**. Selecting another
   weekday selects the Monday of that week.
2. An existing saved plan loads automatically. For a new week, click **Generate
   Menu**. Meals and their recipe ingredients must already exist in Meal Setup.
3. Adjust meals and child/staff counts, then enter stock already in house. Counts
   must be whole numbers, neither may be negative, and their total must exceed
   zero. Stock may be fractional but cannot be negative or blank.
4. Wait for the shopping calculation, then click **Save Menu**. One request saves
   the entire plan. Save and Print are unavailable during recalculation or after
   a calculation error; previous totals are not presented as current.
5. Return to either week or reload the browser to reopen its saved plan. The
   browser remembers the last selected week.

Drafts stay in memory for each week while the Meals page is open, including trips
to **Meal Setup**. They are not automatically saved to the database. Closing or
reloading the browser asks about unsaved work. Save before navigating to another
application page. **Reopen saved week** asks before discarding that week's draft;
other weeks' drafts remain intact.

If you had a saved menu before calendar weeks were introduced, choose its intended
week and click **Use earlier undated menu**. This creates an editable draft using
the old menu and shelf check, with the old defaults of 20 children and 5 staff.
Review counts and stock before saving. Its ingredients are captured from the
current catalog because the old format did not store recipe history. The original
undated records remain available and are never assigned a guessed date.

For a saved week, an unchanged meal in the same day/meal period retains its saved
recipe even if the catalog recipe changes or the meal is later deleted. Changing
headcounts scales that recipe. A newly selected meal uses its current catalog
recipe. A new calendar week also uses current recipes. Conflicting units for the
same ingredient are rejected instead of being added together.

## Errors and concurrent edits

- **Calculation error:** correct invalid values or use **Retry calculation**.
- **Save failure:** the prior saved snapshot remains intact and the editable draft
  stays on screen. Retry saving when the service is available.
- **Calculation expired:** calculations expire after one hour or a server restart.
  Use **Retry calculation** before saving again.
- **Saved elsewhere:** another tab or user saved a newer version. Your draft is
  retained, but it cannot overwrite that version. Review your edits, then use
  **Reopen saved week** to load the latest version and reapply them.

## API contract

All success responses wrap the result in `{ "data": ... }`. Validation returns
400, missing saved shopping returns 404, and expired/conflicting saves return
409, with `{ "error": { "message": "..." } }`.

| Request | Behavior |
| --- | --- |
| `GET /api/menu/plans/:weekStart` | Complete saved snapshot, or `null` for a new week |
| `POST /api/menu/plans/:weekStart/preview` | Read-only draft calculation and signed `previewToken` |
| `PUT /api/menu/plans/:weekStart` | Atomically saves `{ "previewToken": "..." }` |
| `GET /api/menu/plans/:weekStart/shopping` | Saved quantities and saved headcounts, independent of today's recipes |
| `GET /api/shelf/final?weekStart=YYYY-MM-DD` | Same dated saved-shopping result |
| `POST /api/menu/plans/:weekStart/import-preview` | Read-only import of the earlier undated menu into a new week's draft |

`weekStart` must be a valid ISO date on a Monday. Preview input:

```json
{
  "version": 0,
  "childrenCount": 4,
  "staffCount": 1,
  "week": [
    { "day": "Monday", "menu": { "breakfast": { "id": "saved-meal-id" } } }
  ],
  "inHouse": { "saved-ingredient-id": 2 }
}
```

Use version `0` for a new week, or the version returned by GET for an existing
week. Week arrays contain one to five distinct weekdays and valid meal slots.
Quantities in the API use the ingredient's stored unit. The UI converts grams and
milliliters to US display units. Each preview's `items` includes `ingredient`,
`quantity`, `inStorage`, and `toBuy`. Save submits the token from the successful
preview, so the saved recipe/quantity snapshot is exactly what was reviewed, even
if someone edits the catalog between calculation and save. The token is not an
authentication credential; authentication remains a separate backlog item.

The older `/menu/current`, `/menu/confirm`, and undated shelf APIs remain compatible
with the previous workflow. They do not represent dated plans. New consumers must
use dated endpoints rather than the old final-shopping default headcounts.

## Verification

Server tests cover two weeks, saved quantities, read-only drafts, historical
recipes, malformed input, token expiry/tampering, failed saves and concurrent
first saves. Client tests exercise rendered controls, reload, tab/week preservation,
immediate stale-state blocking, rejected calculations and saves, and out-of-order
responses even when cancellation is ignored.

`npm run test:postgres` exercises the same API against PostgreSQL and verifies
dated plans in separate Node processes. The existing restart procedure now also
saves two dated plans and checks the **15 needed / 2 in house / 13 buy** example:

```bash
cd ~/workspace/ska_organizer/server
npm run test:restart:prepare
sudo systemctl restart postgresql
npm run test:restart:verify
```

It uses only an isolated schema in `TEST_DATABASE_URL`, whose database name must
end in `_test`. Successful verification removes its own test records. The GitHub
workflow runs the native PostgreSQL 16 suite and restart check; the client workflow
runs the production build, lint and interaction tests.

The full Chromium flow also runs in client CI, using isolated mock storage on
ports 3009 and 5179; it never connects to your development database. To run it
locally after installing both client and server dependencies:

```bash
cd ~/workspace/ska_organizer/client
npx playwright install --with-deps chromium
npm run test:browser
```

Manual check: add a breakfast recipe using one egg per person; select it on three
days, set 4 children and 1 staff, and enter 2 eggs in house. Save and reload: the
shopping table must show 15 needed and 13 buy. Save a different second week, then
reopen the first and verify its selections, counts and stock are unchanged.

### Ubuntu verification — September 7, 2026

The handoff commit was imported and migration `002-weekly-plans` applied to the
existing configured database, without recreating databases or changing `.env`
files. With Node 22.17.1, all 35 mock tests, all 39 native PostgreSQL tests, all
12 React interaction tests and the production build passed. ESLint passed with
the existing `MealsManagement.tsx` hook dependency warning.

The full Chromium flow passed after correcting its breakfast selector to use
the combobox role and accessible name. It verified save/reload, the 15/2/13
quantities through both the UI and saved-shopping API, draft retention across
tabs and weeks, reopening the saved first week, and mobile navigation.
GitHub CI and PR merge remain separate delivery gates.
