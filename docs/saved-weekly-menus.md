# Saved weekly menus

The planner stores each calendar week separately. Saving records the meals,
child/staff counts, recipe ingredients and quantities, and a sample of recorded
inventory in one atomic snapshot. Reopening a week restores that snapshot, including historical
ingredient names, units and stock totals. Later recipe edits, purchases and
stock corrections do not rewrite it.

For catalog edits and archiving, see [Correcting meals and recipes (SKAO-19)](catalog-corrections.md).

## Update and run

Use the shared [backup, migration and automated checks procedure](update-checks.md)
after applying an update. It backs up the configured PostgreSQL database before
applying pending migrations. Keep your existing databases and settings; no seed
or database recreation is needed.

Migration `002-weekly-plans` introduced dated snapshots. Migration
`011-purchase-receipts` adds purchase history without rewriting any saved plan.

Start the frontend with `npm run dev` in `client`, and the backend with
`node index.js` in `server`, using separate Ubuntu terminals. In Windows Chrome,
open the Network URL printed by Vite. See [PostgreSQL setup](postgresql-setup.md)
for the initial environment configuration.

## Plan a week

1. Open **Meals → Planner** and select **Week starting Monday**. Selecting another
   weekday selects the Monday of that week.
2. An existing saved plan loads automatically. For a new week, click **Generate
   Menu**. Meals and their recipe ingredients must already exist in Meal Setup.
3. Adjust meals and child/staff counts. Counts must be whole numbers, neither may
   be negative, and their total must exceed zero. The calculation reads linked
   food stock from Inventory across all storage locations.
4. Review the required, recorded-stock and to-buy quantities, then click **Save
   Menu**. One request saves the entire reviewed snapshot. Save and Print are
   unavailable during recalculation or after an error. Reopening an unchanged
   saved week allows printing its historical snapshot; Save becomes available
   only after an edit or explicit recalculation.
5. Return to either week or reload the browser to reopen its saved plan. The
   browser remembers the last selected week.

Drafts stay in memory for each week while the Meals page is open, including trips
to **Meal Setup**. They are not automatically saved to the database. Closing or
reloading the browser asks about unsaved work. Save before navigating to another
application page. **Reopen saved week** asks before discarding that week's draft;
other weeks' drafts remain intact.

If you had a saved menu before calendar weeks were introduced, choose its intended
week and click **Use earlier undated menu**. This creates an editable draft using
the old menu, current Inventory and the old defaults of 20 children and 5 staff.
Review counts and stock before saving. Its ingredients are captured from the
current catalog because the old format did not store recipe history. The original
undated records remain available and are never assigned a guessed date.

For a saved week, an unchanged meal in the same day/meal period retains its saved
recipe even if the catalog recipe changes or the meal is later deleted. Changing
headcounts scales that recipe. A newly selected meal uses its current catalog
recipe. **Use current recipes** explicitly adopts catalog corrections in a saved
week’s draft; the saved week changes only after Save. A newly generated menu or
new calendar week also uses current recipes. Conflicting units for the
same ingredient are rejected instead of being added together.

## Inventory and saved shopping

The planner uses food amounts from Inventory. **View what we have** opens it in another tab. Unsaved drafts refresh on return or an inventory-change notification from another same-origin tab, preserving meals and headcounts. **Update shopping list** can also request a fresh calculation. There is no polling of other devices.

A reopened week is labeled **Saved list**. Its original stock quantities stay unchanged, including older manually entered amounts. Updating shopping or editing a saved plan creates a draft using current Inventory; only Save replaces the saved week.

Food is matched by ingredient ID across all locations and pages. When adding an item to a food group, typing a unique existing food name selects that identifier automatically. Existing unconnected stock can use **More → Choose food** in Inventory. A new food still needs to be added to its recipes in Meal Setup.

Compatible weights and volumes are converted. Package sizes are never guessed. Missing stock means zero available; stock above the requirement means zero to buy. **No amount recorded yet** indicates the ingredient has no linked inventory record. See [Inventory](inventory.md) for units, daily actions and manual checks.

Saving and printing do not decrease or reserve stock. Record actual usage with **Used some**. The same available stock can appear in several future plans; this feature does not allocate stock between weeks.

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
| `POST /api/menu/plans/:weekStart/preview` | Read-only calculation; signed `previewToken` only when recipes are complete |
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
  ]
}
```

Optional `refreshRecipes: true` adopts current catalog recipes for a saved week.
A preview with incomplete recipes returns named `warnings` and no save token.
Stock is derived on the server. A nonempty `inHouse` input is rejected with an
instruction to record a count correction in Inventory instead.

Use version `0` for a new week, or the version returned by GET for an existing
week. Week arrays contain one to five distinct weekdays and valid meal slots.
Quantities in the API use the ingredient's stored unit. The UI converts grams and
milliliters to US display units. Each preview's `items` includes `ingredient`,
`quantity`, `inStorage`, `toBuy` and `stockItems` (source item, location, quantity,
unit and revision). New snapshots include `stockSource: "inventory"` and an ISO
`stockTakenAt` timestamp. Historical saved-shopping responses identify older
snapshots with `stockSource: "manual"` and a null sample time.

Save submits the token from the successful preview, so the saved recipe and
stock snapshot is exactly what was reviewed, even if the catalog or inventory
changes between calculation and save. Recalculate first when you want fresher
stock. The token is not a sign-in credential; normal [authentication and
permissions](authentication.md) remain required.

The older `/menu/current`, `/menu/confirm`, and undated shelf APIs remain compatible
with the previous workflow. They do not represent dated plans or the inventory
ledger. New consumers must use dated endpoints.

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

Manual check: add a breakfast recipe using one egg per person and create linked
food inventory with an opening count of 2 eggs. Select the recipe on three days
and set 4 children and 1 staff. Save and reload: the table must show 15 needed,
2 recorded and 13 to buy. Save a different second week, then reopen the first;
its selections, counts and stock snapshot must remain unchanged.

Receive 3 more eggs in Inventory. Reopening the first week must still show its
saved 2/13 stock/buy values. Explicitly recalculate to see 5/10, then save and
print. The inventory balance must stay at 5. For correction, retry and permission
checks, use the manual verification in [Inventory](inventory.md).
