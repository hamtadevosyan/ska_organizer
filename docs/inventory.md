# Inventory quantities and storage locations — SKAO-25

Inventory now stores actual supplies and their quantities in PostgreSQL. Administrators and editors can create records, change details and record stock movements. Viewers can search, filter and read history. Existing sign-in, Origin and CSRF protections apply to the API.

Each record represents stock at one exact location. For example, paper in `Art room / Cupboard / Shelf 2` and paper in `Office / Drawer 1` are separate records. Category and location are required text fields, with suggestions from existing inventory. Moving an entire record to another location is a details edit and preserves its old location in history.

## Creating and maintaining stock

Choose **Add inventory item**, then enter its name, category, exact storage location, unit, opening count, reorder threshold and a reason for the opening count. Food can optionally link to an existing ingredient. Use **Edit** for descriptive details and the reorder threshold. Use **Adjust stock** for changes in quantity.

| Movement | Quantity entered | Result |
|---|---|---|
| Opening count | Starting quantity physically counted | Creates the item and its first history entry |
| Stock addition | Amount added, greater than zero | Increases the recorded quantity |
| Usage | Amount used, greater than zero | Decreases the quantity; cannot exceed available stock |
| Count correction | Total physically counted, including zero | Sets the current count and records the difference |
| Details changed | Updated name/category/location/unit/link/threshold | Keeps the balance and records previous and new details |

Every change requires a reason. **History** shows the change, before/after quantities, unit, location, reason, signed-in username, timestamp and revision. Corrections create new entries; earlier entries cannot be edited or deleted through the API or interface. There is no item-deletion action in this version. An unused item can be counted down to zero with a reason and remains in history.

**Count correction takes the new total, not the amount to add or remove.** If the app says 15 packs and you count 12, enter `12`; history records a change of `-3`.

## Units, food links and precision

Supported units are `count`, `g`, `ml`, `oz`, `lb`, `gal`, `box` and `pack`. No conversions occur automatically. Quantities and thresholds must be non-negative, below one trillion, with at most six decimal places. The API returns them as decimal strings so fractional stock can be retained exactly; for example, `0.1` plus `0.2` is `0.3`.

Food links use ingredient IDs. Linking an ingredient selects its existing unit. A stock movement must specify that exact unit: an ounce quantity cannot be entered against a pounds record. Unit and ingredient link can change only when the item's stock is zero. Past movements retain the units and ingredient links that applied at the time.

An ingredient referenced by current inventory cannot have its unit changed in Meal Setup, including when that inventory is empty. Existing links to archived ingredients remain readable and usable; new links require an active ingredient. Unlink an empty record or create a separate ingredient when changing units.

This story establishes inventory records and movement history. Purchase receipts and connection to shopping/meal planning are SKAO-26. Saving or generating a meal plan does not consume inventory in this version. Existing weekly-plan in-house entries and saved snapshots keep their current behavior. The Dashboard inventory card is separate work under SKAO-28; use the Inventory page for actual counts.

## Status, search and retry behavior

| Status | Calculation |
|---|---|
| Out of stock | Quantity is zero |
| Low stock | Quantity is positive and at or below the reorder threshold |
| Available | Quantity is above the reorder threshold |

Search matches words in item names without treating `%` or `_` as wildcards. Category, exact location and stock status filters combine with the search. The table uses 25 records per page. Summary cards count all inventory records, across every page and location, independently of the selected filters.

**Refresh inventory** retries failed list and ingredient loads. A failed history load has **Retry history**. Unsaved form values survive failed saves. Retry the same save if the response was lost; the request identifier prevents a second opening or stock movement. If you change the payload after it was already committed, the server rejects reusing that identifier.

If another person updates the same item, saving an old revision returns a conflict and preserves your entries. Choose **Reload inventory item**, confirm replacement of the unsaved entries, and review the current balance before entering a new change. Refreshing the list alone does not replace the open form.

## API contract

All paths below are relative to `/api/inventory`. Writes require a signed-in administrator or editor, allowed `Origin` and `X-CSRF-Token`. Reads require an operational account.

| Method and path | Response or purpose |
|---|---|
| `GET /` | `{items, total, page, pageSize, summary, options}` |
| `GET /items` | Alias for the paginated list |
| `GET /status` | `{total, available, lowStock, outOfStock}` |
| `POST /` | Create item with opening count; `201 {data: item}` |
| `GET /:id` | `{data: item}` |
| `PUT /:id` | Edit metadata; `200 {data: item}` |
| `GET /:id/movements` | `{item, items, total, page, pageSize}`; newest revision first |
| `POST /:id/movements` | Apply addition, usage or correction; `200 {data: item}` |

The list accepts `q`, `category`, `location`, `status=all|available|low|out`, `page` and `pageSize`. Page size defaults to 50 and is capped at 100. History accepts only `page` and `pageSize`. Unknown body/filter fields are rejected. The list replaces the former hardcoded array response.

Example create body (request identifiers must be fresh per intended operation, then retained for retries):

```json
{
  "name": "Drawing paper",
  "category": "Art supplies",
  "location": "Art room / Cupboard / Shelf 2",
  "unit": "pack",
  "ingredientId": null,
  "openingQuantity": "10",
  "reorderThreshold": "2",
  "reason": "Opening physical count",
  "requestId": "synthetic-opening-request-0001"
}
```

Example adjustment to that item's current revision:

```json
{
  "type": "usage",
  "quantity": "3",
  "unit": "pack",
  "version": 1,
  "reason": "Art class supplies",
  "requestId": "synthetic-usage-request-0001"
}
```

Metadata edits accept `name`, `category`, `location`, `unit`, `ingredientId`, `reorderThreshold`, plus required `version`, `reason`, and `requestId`. They cannot set the current quantity. Request identifiers are 16–100 letters, digits, underscores or hyphens. Clients cannot supply actor, occurrence time, ID or a replacement history entry.

Invalid input returns 400 with field details where applicable. Missing item/ingredient returns 404. Insufficient stock, prohibited unit/link changes, archived new ingredient links or a revision conflict return 409. Revision conflicts use `INVENTORY_CONFLICT`; conflicting reuse of a request identifier uses `INVENTORY_REQUEST_CONFLICT`. Repeating an identical committed request by the same account returns the item's current state with `replayed: true` without changing its quantity, revision or movement history again.

## Persistence and verification

Migration `009-inventory-ledger` adds `InventoryItems` and `InventoryMovements`. It does not seed demonstration stock or change existing meals, rooms, children, staff, accounts or weekly plans. The Inventory page initially has no records after migration. Mock inventory is empty on every backend start and is for isolated tests; use the existing PostgreSQL adapter for persistent operation.

Item updates, stock movements and audit events commit in one transaction. The transaction takes authentication, catalog and inventory locks in that order. Revision checks prevent stale writes; a unique request identifier prevents duplicated movements. Database constraints protect non-negative balances, movement arithmetic and item/ingredient/account references.

Regression suites are `server/tests/inventory.test.js`, `server/tests/inventory.postgres.test.js`, `client/src/pages/Inventory.test.tsx`, and `client/tests/browser/inventory.spec.ts`. They cover stock arithmetic, corrections, history, units, ingredient links, permissions, conflicts, retry identifiers, rollback, filters, persistence and the browser workflow. Test execution and PostgreSQL migration are left to the user for this delivery. Follow [the Ubuntu installation and testing instructions](SKAO-25-manual-install.md).
