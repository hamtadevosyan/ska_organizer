# Inventory and shopping

Inventory shows what is on hand, organized into groups such as Food, Toys or Cleaning Supplies. Open a group and find the item. Routine actions ask only for an amount and a save; setup, history and optional information stay out of the main view.

## Everyday actions

| What happened | Action | What to enter |
| --- | --- | --- |
| You received more | **Bought more** | The amount received, then **Save amount** |
| You used some | **Used some** | The amount used, then **Save amount** |
| You checked what is left | **More → Check the amount** | The total you counted, including zero, then **Save amount** |

The form previews the resulting amount before saving. For example, using 2 of 10 packs shows **8 packs left**. Usage cannot exceed what is available. A physical count replaces the current total; entering 12 when the app shows 15 records a decrease of 3.

**Bought more** uses today's facility date automatically. Open **Date, cost or notes (optional)** for an earlier received date, supplier, total cost in USD or a note. An empty cost is unknown; zero is no cost. Dates cannot be in the future. Use this action for goods actually received.

History notes are supplied automatically: **Initial quantity recorded**, **Purchase received**, **Used in daily activities**, **Physical count checked**, or **Inventory details updated**. Users may supply an optional note. Other additions, such as donated supplies, are under **Other changes → Added without a purchase**.

## Add an item

Open its group and choose **Add item**. Answer three questions:

1. **What is it?** Type the name.
2. **How much do you have?** Enter the amount and select its unit. Zero means none.
3. **Where do you keep it?** Type a location or choose a suggested location.

Choose **Save item**. The current group is already selected. From the overview, choose a group first. **Optional details** contains the group and a warning level; leave the warning empty if it is unnecessary. A warning does not place orders or send notifications.

For food, a unique existing recipe ingredient with the same name is chosen automatically, ignoring capitalization and repeated spaces. Suggestions can also be selected. A new name creates the food and its stock together in one transaction and makes it available in Meal Setup. Add that food to the relevant recipes there. Similar names are not guessed; duplicate names require an explicit choice. Archived foods must be restored or given a different name.

Weight defaults to pounds, volume to gallons, and counts to pieces for a matched food. A compatible unit can be chosen. Supply items have no recipe controls. Each record represents one storage location; the same food may have separate records in the pantry and freezer.

## Groups and additional details

The first empty screen offers **Add your first group**. Later use the page's **More → Add group**. Choose **Food stock** for food used in meals and **Supplies and equipment** for other materials. Group names must be unique regardless of capitalization or repeated spaces.

Open a group to browse or add its items. **All groups** returns to the cards. **View all items** offers combined search. **More filters** holds group, location and status filters; **Overview** holds totals. Zero warning counts are omitted from group cards.

Use an item's **More → Edit details** for its name, group, location or warning level. Moving a record moves its entire balance and keeps the previous details in history. The main list is hidden while editing so the active task remains clear. An item's **More → History** and **More → Purchases** show past changes; the page's **More → Purchase history** shows all receipts.

Administrators and editors can change inventory. Viewers can read it and its history. Every change records the signed-in user and server time. History and receipts cannot be edited or deleted through this interface. Corrections create a new entry. Item/group deletion, receipt returns and financial accounting are outside this workflow.

## Food and the shopping list

The planner subtracts available food across every location from recipe requirements. **Already have** shows the recorded amount; **Buy** shows `max(needed − available, 0)`. Calculations use ingredient identifiers, including those automatically chosen when adding food, rather than names alone.

For older food without a connection, use **More → Choose food** to select the recipe ingredient and save. The amount stays unchanged. If the record is in a supplies group, edit its group first. Group names do not determine group type. Boxes and packs must have their contents counted or measured before they can supply a recipe; do not count both the packages and their contents.

**View what we have** opens Inventory in another tab. An unsaved shopping draft refreshes when you return or when another same-origin tab reports an inventory change. It keeps meal selections and headcounts. There is no background polling of other devices; **Update shopping list** is also available whenever a fresh calculation is needed.

A saved week keeps its saved quantities until you choose **Update shopping list** or edit the plan. Review and save to replace it. Saving and printing never consume or reserve inventory; record actual use with **Used some**. The same stock may appear in multiple future weeks. See [Saved weekly menus](saved-weekly-menus.md).

## Units, status and retries

Supported units are pieces (`count`), `g`, `ml`, `oz`, `lb`, US `gal`, `box` and `pack`. Quantities are non-negative, below one trillion, with at most six decimal places. The API returns decimal strings and daily previews use exact decimal arithmetic.

Food accepts compatible mass units (`g`, `oz`, `lb`) or volume units (`ml`, `gal`). Counts match counts only. There is no assumed size for packs or boxes. Converted available stock is rounded down to six decimal places. Once stock exists, its unit stays fixed; an unconnected record may still select a compatible ingredient. Replacing an already connected ingredient requires a zero balance. Previous history retains its original units and links.

An ingredient referenced by inventory cannot change its recipe unit. Links to archived ingredients remain readable; new links require an active ingredient.

Zero is **Out of stock**. A positive amount at or below an enabled warning level is **Low stock**; other positive quantities are **Available**. The list is paginated and filters preserve overall/group summaries.

If a save response is lost, retry the unchanged form. A request identifier prevents duplicate changes. A concurrent update or reused identifier with different details keeps the entered values visible and asks for review. Check history before explicitly reloading the latest item, which replaces unsaved entries after confirmation. The stock increase, receipt and history are saved atomically.

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
| `GET /purchase-config` | `{today, timeZone}` from the facility clock |
| `GET /purchases` | `{items, total, page, pageSize, today, timeZone}`; optional `itemId` filter |
| `POST /:id/purchases` | Record a received purchase; `201 {data: {receipt, item, replayed}}` |

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
  "reason": "Initial quantity recorded",
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

Create and metadata-edit bodies also accept `newIngredient: {"name": "Brown rice", "unit": "lb"}` instead of an existing `ingredientId`. `ingredientId` must be null when adding a new food. The group must have type `food`, and stock and food units must be compatible. New food, stock, movement and audit share one transaction; identical retries reuse the recorded result. An existing normalized food name (including an archived food) returns 409 with guidance to choose or restore it. This avoids silently creating duplicate recipe ingredients. The UI requires a food choice or new food in food groups; older API clients may still create unlinked records, which are visibly flagged in Inventory.

Purchase requests contain `quantity`, the item's exact `unit`, `receivedOn` (`YYYY-MM-DD`), current `version` and `requestId`. Optional fields are `supplier` (up to 200 characters), `totalCost` (null or non-negative USD amount with at most two decimal places), and `reason` (up to 500 characters, defaults to "Purchase received"). Negative or zero quantity, future/invalid dates, incompatible units, invalid costs and unknown fields return 400. Received date is user-selected; actor and recording time are server-generated. Purchase reads accept only `itemId`, `page` and `pageSize`, and sort by received date, recorded time and ID descending.

For compatibility, older clients can still supply category text without `groupId`; the API finds or creates the corresponding group. Food-linked stock and the category names Food, Food Stock, Ingredients and Groceries create food groups. A food-linked item cannot be placed in an existing supplies group. New interface requests always use a group ID.

Invalid input returns 400 with field details where applicable. Missing item/ingredient returns 404. Insufficient stock, prohibited unit/link changes, archived new ingredient links or a revision conflict return 409. Revision conflicts use `INVENTORY_CONFLICT`; conflicting reuse of a request identifier uses `INVENTORY_REQUEST_CONFLICT`. Repeating an identical committed request by the same account returns the item's current state with `replayed: true` without changing its quantity, revision or movement history again.

## Persistence and verification

Migration `009-inventory-ledger` adds `InventoryItems` and `InventoryMovements`. Migration `010-inventory-groups` adds `InventoryGroups` and required item group references. Existing categories become groups; names differing only by case or repeated whitespace share a group. Groups with ingredient-linked stock, or named Food, Food Stock, Ingredients or Groceries, receive the food type. Other groups receive the supplies type. No quantities, item versions, original categories, timestamps or historical movement entries are rewritten by migration 010.

Migration `011-purchase-receipts` adds `PurchaseReceipts`, linked to the original stock movement, item and account. It does not rewrite balances, old movement history or saved weekly plans. Existing stock additions remain movements; they are not relabeled as purchases.

These migrations do not seed demonstration stock or change existing meals, rooms, children, staff, accounts or weekly plans. With no existing inventory, the groups page starts empty and asks you to create the first group. Mock inventory, groups and purchases are empty on every backend start and are for isolated tests; use PostgreSQL for persistent operation.

Item updates, stock movements, purchase receipts and audit events commit in one transaction. The transaction takes authentication, catalog and inventory locks in that order. Revision checks prevent stale writes; a unique request identifier prevents duplicated movements and each receipt refers to one unique movement. Database constraints protect non-negative balances/costs, positive receipt quantities, movement arithmetic and item/ingredient/account references.

Inventory and group suites cover stock arithmetic, corrections, history, permissions, conflicts, retry identifiers, rollback, filters, moving items, migration preservation and persistence. Purchasing coverage is in `server/tests/purchasing.test.js`, `server/tests/purchasing.postgres.test.js`, `server/tests/inventoryStock.test.js`, `client/src/components/inventory/Purchasing.test.tsx`, and `client/tests/browser/purchasing.spec.ts`. Planner/catalog regression cases verify historical snapshots, linked stock and read-only calculation. Use the shared [backup, migration and automated checks procedure](update-checks.md), including its focused inventory option. Test results must come from running those suites in your environment.

## Manual verification

Use synthetic items and your separate test database for automated checks.

1. Add a supply item with 10 packs. **Bought more → 0.5 → Save amount** gives 10.5; **Used some → 9** previews 1.5 and saves that amount. Neither routine action requires a note, date or movement type.
2. Check the amount under More and enter zero. Edit its location. Reload and confirm that counts, receipts and history remain. Try using more than is available; it must fail without changing stock.
3. Type an existing food name in a food group. Save its amount and location without choosing a recipe link. Verify it reduces the shopping requirement for a recipe using that ingredient. New food must become available in Meal Setup. Ambiguous names require a choice.
4. Use a recipe needing 15 eggs with 2 in Inventory: 13 to buy. Keep an unsaved draft open, buy 3 more in the Inventory tab and return: 5 available, 10 to buy; meals and headcounts remain.
5. Save that week, change Inventory, then return or reload. Its saved shopping amounts must stay unchanged until **Update shopping list**. Save and print; Inventory must not change.
6. Retry a lost response unchanged and confirm only one change was recorded. A viewer can browse history but cannot mutate stock. Check narrow screens: item details stack and daily actions remain easy to tap.
