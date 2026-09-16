# Inventory quantities and storage locations — SKAO-25

Inventory stores physical supplies and their quantities in PostgreSQL, organized into user-created groups. Administrators and editors can create groups and items, change item details and record stock movements. Viewers can browse, search, filter and read history. Existing sign-in, Origin and CSRF protections apply to the API.

Each record represents stock at one exact location. For example, paper in `Art room / Cupboard / Shelf 2` and paper in `Office / Drawer 1` are separate records. Every item belongs to a group and has a required storage location. Moving a record to another location or group is a details edit and preserves the previous values in history.

## Groups and the Meals area

Opening Inventory shows group cards with item counts and low/out-of-stock counts. It does not open a mixed table of food and other materials. Select **Add group** to create a named group, optionally describe it, and choose its type:

| Group type | Examples | Item form |
|---|---|---|
| Food stock | Food Stock, Pantry, Refrigerated Food | Can link to an existing food ingredient |
| Supplies and equipment | Classroom Materials, Toys, Decorations, Cleaning Supplies | Has no food ingredient controls |

Names are chosen by the user and must be unique regardless of capitalization or repeated spaces. Empty groups exist before any items are added. Open a group to view its stock or add an item with that group preselected. **Add inventory item** from the group overview asks you to choose the destination group. **All groups** returns to the cards, and **View all items** provides an optional combined search view.

Meals manages recipes, ingredient amounts per recipe and weekly menus. Food inventory records what is physically in storage. Grouping does not create a second place to edit recipes or automatically consume food when a menu is saved.

## Creating and maintaining stock

Create a group first if necessary. Choose **Add inventory item**, then select its group and enter its name, exact storage location, unit, opening count, reorder threshold and a reason for the opening count. Food groups can optionally link stock to an existing ingredient. Use **Edit** for the group, descriptive details and the reorder threshold. Use **Adjust stock** for changes in quantity.

| Movement | Quantity entered | Result |
|---|---|---|
| Opening count | Starting quantity physically counted | Creates the item and its first history entry |
| Stock addition | Amount added, greater than zero | Increases the recorded quantity |
| Usage | Amount used, greater than zero | Decreases the quantity; cannot exceed available stock |
| Count correction | Total physically counted, including zero | Sets the current count and records the difference |
| Details changed | Updated name/group/location/unit/link/threshold | Keeps the balance and records previous and new details |

The item form now uses a group selector in place of the old category text field. Historical categories remain visible in older movement snapshots.

Every change requires a reason. **History** shows the change, before/after quantities, unit, location, reason, signed-in username, timestamp and revision. Corrections create new entries; earlier entries cannot be edited or deleted through the API or interface. There is no item-deletion action in this version. An unused item can be counted down to zero with a reason and remains in history.

**Count correction takes the new total, not the amount to add or remove.** If the app says 15 packs and you count 12, enter `12`; history records a change of `-3`.

## Units, food links and precision

Supported units are `count`, `g`, `ml`, `oz`, `lb`, `gal`, `box` and `pack`. No conversions occur automatically. Quantities and thresholds must be non-negative, below one trillion, with at most six decimal places. The API returns them as decimal strings so fractional stock can be retained exactly; for example, `0.1` plus `0.2` is `0.3`.

Food links use ingredient IDs and are permitted only in a food stock group. Linking an ingredient selects its existing unit. A stock movement must specify that exact unit: an ounce quantity cannot be entered against a pounds record. Unit and ingredient link can change only when the item's stock is zero. Past movements retain the units and ingredient links that applied at the time. Ingredient-linked stock can move between food groups; unlinking an empty item allows it to move to a supplies group.

An ingredient referenced by current inventory cannot have its unit changed in Meal Setup, including when that inventory is empty. Existing links to archived ingredients remain readable and usable; new links require an active ingredient. Unlink an empty record or create a separate ingredient when changing units.

This story establishes inventory records and movement history. Purchase receipts and connection to shopping/meal planning are SKAO-26. Saving or generating a meal plan does not consume inventory in this version. Existing weekly-plan in-house entries and saved snapshots keep their current behavior. The Dashboard inventory card is separate work under SKAO-28; use the Inventory page for actual counts.

## Status, search and retry behavior

| Status | Calculation |
|---|---|
| Out of stock | Quantity is zero |
| Low stock | Quantity is positive and at or below the reorder threshold |
| Available | Quantity is above the reorder threshold |

Search matches words in item names without treating `%` or `_` as wildcards. Group, exact location and stock status filters combine with the search. The table uses 25 records per page. Summary cards count every item in the selected group across all locations and pages, independently of the search and location/status filters. Selecting All groups in the filter shows overall inventory totals. Reset filters keeps the selected group. Group cards always show counts for their own members.

**Refresh inventory** retries failed list and ingredient loads. A failed history load has **Retry history**. Unsaved form values survive failed saves. Retry the same save if the response was lost; the request identifier prevents a second opening or stock movement. If you change the payload after it was already committed, the server rejects reusing that identifier.

If another person updates the same item, saving an old revision returns a conflict and preserves your entries. Choose **Reload inventory item**, confirm replacement of the unsaved entries, and review the current balance before entering a new change. Refreshing the list alone does not replace the open form.

## API contract

All paths below are relative to `/api/inventory`. Writes require a signed-in administrator or editor, allowed `Origin` and `X-CSRF-Token`. Reads require an operational account.

| Method and path | Response or purpose |
|---|---|
| `GET /groups` | `{items: groups}` with per-group summaries, including empty groups |
| `POST /groups` | Create a named group; `201 {data: group}` |
| `GET /` | `{items, total, page, pageSize, summary, options}` |
| `GET /items` | Alias for the paginated list |
| `GET /status` | `{total, available, lowStock, outOfStock}` |
| `POST /` | Create item with opening count; `201 {data: item}` |
| `GET /:id` | `{data: item}` |
| `PUT /:id` | Edit metadata; `200 {data: item}` |
| `GET /:id/movements` | `{item, items, total, page, pageSize}`; newest revision first |
| `POST /:id/movements` | Apply addition, usage or correction; `200 {data: item}` |

The list accepts `q`, `groupId`, `location`, `status=all|available|low|out`, `page` and `pageSize`. The earlier `category` text filter remains supported for existing clients. Page size defaults to 50 and is capped at 100. History accepts only `page` and `pageSize`. Unknown body/filter fields are rejected. The list replaces the former hardcoded array response. Its API `summary` remains the overall inventory summary; `GET /groups` supplies the group summaries shown in the interface.

Create a group with `name` (1–80 characters), `kind` (`food` or `supplies`), optional `description` (up to 240 characters) and `requestId`. Group creation uses the same identifier on retries and has an attributed audit event. The response includes its stable `id`, name, kind, description and timestamps. Group reads and item responses omit internal request signatures.

Example create body (request identifiers must be fresh per intended operation, then retained for retries):

```json
{
  "name": "Drawing paper",
  "groupId": "REPLACE_WITH_CREATED_GROUP_ID",
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

Metadata edits accept `name`, `groupId`, `location`, `unit`, `ingredientId`, `reorderThreshold`, plus required `version`, `reason`, and `requestId`. They cannot set the current quantity. Moving an item changes its group without altering the balance and records a details movement. Request identifiers are 16–100 letters, digits, underscores or hyphens. Clients cannot supply actor, occurrence time, ID or a replacement history entry.

For compatibility, older clients can still supply category text without `groupId`; the API finds or creates the corresponding group. Food-linked stock and the category names Food, Food Stock, Ingredients and Groceries create food groups. A food-linked item cannot be placed in an existing supplies group. New interface requests always use a group ID.

Invalid input returns 400 with field details where applicable. Missing item/ingredient returns 404. Insufficient stock, prohibited unit/link changes, archived new ingredient links or a revision conflict return 409. Revision conflicts use `INVENTORY_CONFLICT`; conflicting reuse of a request identifier uses `INVENTORY_REQUEST_CONFLICT`. Repeating an identical committed request by the same account returns the item's current state with `replayed: true` without changing its quantity, revision or movement history again.

## Persistence and verification

Migration `009-inventory-ledger` adds `InventoryItems` and `InventoryMovements`. Migration `010-inventory-groups` adds `InventoryGroups` and required item group references. Existing categories become groups; names differing only by case or repeated whitespace share a group. Groups with ingredient-linked stock, or named Food, Food Stock, Ingredients or Groceries, receive the food type. Other groups receive the supplies type. No quantities, item versions, original categories, timestamps or historical movement entries are rewritten by migration 010.

Neither migration seeds demonstration stock or changes existing meals, rooms, children, staff, accounts or weekly plans. With no existing inventory, the groups page starts empty and asks you to create the first group. Mock inventory and groups are empty on every backend start and are for isolated tests; use PostgreSQL for persistent operation.

Item updates, stock movements and audit events commit in one transaction. The transaction takes authentication, catalog and inventory locks in that order. Revision checks prevent stale writes; a unique request identifier prevents duplicated movements. Database constraints protect non-negative balances, movement arithmetic and item/ingredient/account references.

Regression suites are `server/tests/inventory.test.js`, `server/tests/inventory.postgres.test.js`, `server/tests/inventoryGroups.test.js`, `server/tests/inventoryGroups.postgres.test.js`, `client/src/pages/Inventory.test.tsx`, and `client/tests/browser/inventory.spec.ts`. They cover stock arithmetic, corrections, history, units, ingredient links, permissions, conflicts, retry identifiers, rollback, filters, group browsing/creation, moving items, migration preservation, persistence and the browser workflow. Test execution and PostgreSQL migration are left to the user for this delivery. Follow [the groups update instructions](SKAO-25-groups-update.md) for an existing SKAO-25 installation.
