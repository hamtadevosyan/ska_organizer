const { isDeepStrictEqual } = require('node:util');
const db = require('./dbAdapter');
const v = require('./inventoryValidation');
const { problem } = require('./planValidation');
const { fieldError, validate } = require('./catalogValidation');
const { compatible } = require('./stockUnits');

const snapshot = (item) => ({ ...Object.fromEntries(['id', 'name', 'category', 'groupId', 'location', 'unit', 'ingredientId', 'version'].map((key) => [key, item[key]])),
  quantity: v.decimal(v.amount(item.quantity)), reorderThreshold: v.decimal(v.amount(item.reorderThreshold)) });
const publicGroup = (group) => Object.fromEntries(['id', 'name', 'kind', 'description', 'createdAt', 'updatedAt'].map((key) => [key, group[key]]));
const summary = (item, ingredient, group) => ({ ...item, ...snapshot(item), group: group ? publicGroup(group) : null,
  status: v.amount(item.quantity) === 0n ? 'out' : v.amount(item.quantity) <= v.amount(item.reorderThreshold) ? 'low' : 'available',
  ingredient: ingredient ? { id: ingredient.id, name: ingredient.name, unit: ingredient.unit, archived: !!ingredient.archived } : null,
});
async function requireItem(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 255) throw problem('Choose a valid inventory item.');
  const item = await db.getInventoryById(id);
  if (!item) throw problem('Inventory item not found.', 404);
  return item;
}
async function present(item) { return summary(item, item.ingredientId ? await db.getIngredientById(item.ingredientId) : null, await db.getInventoryGroupById(item.groupId)); }
async function requireGroup(id) {
  const group = await db.getInventoryGroupById(v.identifier(id, 'groupId'));
  if (!group) throw fieldError('groupId', 'Inventory group not found.', 404);
  return group;
}
async function assignGroup(values) {
  let group;
  if (values.groupId) group = await requireGroup(values.groupId);
  else {
    // Older clients sent category text. Preserve that contract as a named group.
    group = await db.getInventoryGroupByName(values.category.toLowerCase());
    if (!group) group = await db.createInventoryGroup({ name: values.category, nameKey: values.category.toLowerCase(),
      kind: values.ingredientId || /^(food|food stock|ingredients|groceries)$/i.test(values.category) ? 'food' : 'supplies', description: '' });
  }
  if (values.ingredientId && group.kind !== 'food') throw fieldError('groupId', 'Choose a food stock group for an ingredient-linked item.', 409);
  return { ...values, groupId: group.id, category: group.name };
}
async function verifyIngredient(item, previous) {
  if (!item.ingredientId) return;
  const ingredient = await db.getIngredientById(item.ingredientId);
  if (!ingredient) throw fieldError('ingredientId', 'Ingredient not found.', 404);
  if (ingredient.archived && item.ingredientId !== previous?.ingredientId) throw fieldError('ingredientId', 'Choose an active ingredient for a new link.', 409);
  if (!compatible(item.unit, ingredient.unit)) throw fieldError('unit', 'Choose a unit compatible with this food: ' + ingredient.unit + '. Packages must be recorded as a count, weight or volume.');
}
// Runs inside the same transaction as the stock record and its history.
async function connectNewFood(values, payload) {
  if (payload.newIngredient === undefined) return values;
  if (values.ingredientId) throw fieldError('ingredientId', 'Choose an existing food or add a new food, not both.');
  const group = await requireGroup(values.groupId);
  if (group.kind !== 'food') throw fieldError('groupId', 'Choose a food stock group when adding food.');
  const details = payload.newIngredient;
  if (!details || typeof details !== 'object' || Array.isArray(details) || Object.keys(details).some((key) => !['name', 'unit'].includes(key))) {
    throw fieldError('newIngredient', 'Supply a food name and unit.');
  }
  const validated = validate(details, 'ingredient');
  const normalized = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const existing = (await db.listIngredients({ includeArchived: true })).find((row) => normalized(row.name) === normalized(validated.name));
  if (existing) throw fieldError('newIngredient', existing.archived ? 'This food is archived. Restore it in Meal Setup before choosing it.' : 'This food already exists. Choose it from the food list.', 409);
  if (!compatible(values.unit, validated.unit)) throw fieldError('unit', 'Choose a compatible count, weight or volume for this food.');
  const food = await db.createIngredient({ ...validated, name: validated.name.replace(/\s+/g, ' '), shelfLifeDays: null });
  return { ...values, ingredientId: food.id };
}
// Ingredient unit edits and inventory writes share the catalog lock. Always take
// catalog before inventory, including when nested in an audited transaction.
const locked = (fn) => db.withCatalogLock(() => db.withInventoryLock(fn));
const signature = (payload, operation, itemId, actor) => ({ payload, operation, itemId, actorId: actor.id });
// Signatures are JSON data. Normalize both sides into this realm before strict
// comparison: structuredClone under Jest can return objects with other prototypes.
// This also ignores JSON key order while retaining value types and request scope.
const requestValue = (value) => JSON.parse(JSON.stringify(value));
exports.createGroup = (payload, actor) => db.withInventoryLock(async () => {
  const values = v.group(payload);
  const request = { payload, actorId: actor.id };
  const repeated = await db.getInventoryGroupByRequestId(payload.requestId);
  if (repeated) {
    if (!isDeepStrictEqual(requestValue(repeated.request), requestValue(request))) throw problem('This request was already used for a different inventory group.', 409);
    return { ...publicGroup(repeated), replayed: true };
  }
  if (await db.getInventoryGroupByName(values.nameKey)) throw fieldError('name', 'An inventory group with this name already exists.', 409);
  return publicGroup(await db.createInventoryGroup({ ...values, requestId: payload.requestId, request }));
});
exports.listGroups = () => db.withInventoryLock(async () => {
  const [groups, counts] = await Promise.all([db.listInventoryGroups(), db.inventoryGroupCounts()]);
  const byId = new Map(counts.map(({ groupId, ...totals }) => [groupId, totals]));
  return { items: groups.map((group) => ({ ...publicGroup(group), summary: byId.get(group.id) || { total: 0, available: 0, lowStock: 0, outOfStock: 0 } })) };
});
async function replay(payload, operation, itemId, actor) {
  const old = await db.getInventoryMovementByRequestId(v.requestId(payload));
  if (!old) return null;
  if (!isDeepStrictEqual(requestValue(old.request), requestValue(signature(payload, operation, itemId, actor)))) {
    throw Object.assign(problem('This request identifier was already used for different inventory details. Reload before trying again.', 409), { code: 'INVENTORY_REQUEST_CONFLICT' });
  }
  return { ...await present(await requireItem(old.itemId)), replayed: true };
}
async function record(before, after, type, payload, operation, actor, reason = payload.reason) {
  const prior = before ? v.amount(before.quantity) : 0n;
  return db.appendInventoryMovement({
    itemId: after.id, type, delta: v.decimal(v.amount(after.quantity) - prior),
    beforeQuantity: v.decimal(prior), afterQuantity: v.decimal(v.amount(after.quantity)),
    before: before ? snapshot(before) : null, after: snapshot(after), itemVersion: after.version,
    reason: v.text(reason, 'reason', 500), actorId: actor.id, actorUsername: actor.username,
    occurredAt: new Date().toISOString(), requestId: payload.requestId,
    request: signature(payload, operation, operation === 'create' ? null : after.id, actor),
  });
}
exports.create = (payload, actor) => locked(async () => {
  const repeated = await replay(payload, 'create', null, actor);
  if (repeated) return repeated;
  const values = await connectNewFood(await assignGroup(v.item(payload)), payload);
  const quantity = v.decimal(v.amount(payload.openingQuantity, 'openingQuantity'));
  v.text(payload.reason, 'reason', 500);
  await verifyIngredient(values);
  const saved = await db.createInventory({ ...values, quantity, version: 1 });
  await record(null, saved, 'opening', payload, 'create', actor);
  return present(saved);
});
exports.update = (id, payload, actor) => locked(async () => {
  const repeated = await replay(payload, 'update', id, actor);
  if (repeated) return repeated;
  const previous = await requireItem(id);
  const values = await connectNewFood(await assignGroup(v.item(payload, previous)), payload);
  v.text(payload.reason, 'reason', 500);
  await verifyIngredient(values, previous);
  const saved = await db.updateInventory(id, { ...values, version: previous.version + 1 });
  await record(previous, saved, 'details', payload, 'update', actor);
  return present(saved);
});
exports.adjust = (id, payload, actor) => locked(async () => {
  const repeated = await replay(payload, 'adjust', id, actor);
  if (repeated) return repeated;
  const previous = await requireItem(id);
  const quantity = v.movement(payload, previous);
  v.text(payload.reason, 'reason', 500);
  const saved = await db.updateInventory(id, { quantity, version: previous.version + 1 });
  await record(previous, saved, payload.type, payload, 'adjust', actor);
  return present(saved);
});
exports.get = async (id) => present(await requireItem(id));
const publicReceipt = (row) => ({
  ...Object.fromEntries(['id', 'itemId', 'movementId', 'unit', 'receivedOn', 'supplier', 'totalCost', 'currency',
    'itemSnapshot', 'actorId', 'actorUsername', 'recordedAt'].map((key) => [key, row[key]])),
  quantity: v.decimal(v.amount(row.quantity)),
});
exports.purchaseConfig = () => {
  const time = require('./facilityTime');
  return { today: time.dateAt(), timeZone: time.timeZone() };
};
exports.receivePurchase = (id, payload, actor) => locked(async () => {
  const repeated = await replay(payload, 'purchase', id, actor);
  if (repeated) {
    const movement = await db.getInventoryMovementByRequestId(payload.requestId);
    const receipt = await db.getPurchaseByMovementId(movement.id);
    if (!receipt) throw problem('The purchase record could not be loaded.', 500);
    return { receipt: publicReceipt(receipt), item: repeated, replayed: true };
  }
  const previous = await requireItem(id);
  const values = v.receipt(payload, previous);
  const saved = await db.updateInventory(id, { quantity: values.resultingQuantity, version: previous.version + 1 });
  const movement = await record(previous, saved, 'addition', payload, 'purchase', actor, values.reason);
  const { resultingQuantity: _quantity, reason: _reason, ...details } = values;
  const receipt = await db.createPurchaseReceipt({ ...details, itemId: id, movementId: movement.id,
    itemSnapshot: snapshot(saved), actorId: actor.id, actorUsername: actor.username, recordedAt: movement.occurredAt });
  return { receipt: publicReceipt(receipt), item: await present(saved), replayed: false };
});
exports.purchases = (query = {}) => db.withInventoryLock(async () => {
  const filters = v.pagination(query, ['itemId', 'page', 'pageSize']);
  if (query.itemId !== undefined) filters.itemId = (await requireItem(query.itemId)).id;
  const [items, total] = await Promise.all([db.listPurchaseReceipts(filters), db.countPurchaseReceipts(filters)]);
  return { items: items.map(publicReceipt), total, page: filters.page, pageSize: filters.pageSize, ...exports.purchaseConfig() };
});
exports.getStatus = () => db.withInventoryLock(async () => {
  const [total, lowStock, outOfStock] = await Promise.all([db.countInventory(), db.countInventory({ status: 'low' }), db.countInventory({ status: 'out' })]);
  return { total, lowStock, outOfStock, available: total - lowStock - outOfStock };
});
exports.getInventoryItems = (query = {}) => db.withInventoryLock(async () => {
  const filters = v.pagination(query);
  if (filters.groupId) await requireGroup(filters.groupId);
  const [items, total, status, options, ingredients, groups] = await Promise.all([
    db.listInventory(filters), db.countInventory(filters), exports.getStatus(), db.inventoryOptions(), db.listIngredients({ includeArchived: true }), db.listInventoryGroups(),
  ]);
  const byId = new Map(ingredients.map((item) => [item.id, item]));
  const byGroup = new Map(groups.map((group) => [group.id, group]));
  return { items: items.map((item) => summary(item, byId.get(item.ingredientId), byGroup.get(item.groupId))), total,
    page: filters.page, pageSize: filters.pageSize, summary: status, options };
});
exports.history = (id, query = {}) => db.withInventoryLock(async () => {
  const filters = v.pagination(query, ['page', 'pageSize']);
  const item = await requireItem(id);
  const [rows, total] = await Promise.all([db.listInventoryMovements(id, filters), db.countInventoryMovements(id)]);
  const signed = (value) => { const text = String(value); return v.decimal(text.startsWith('-') ? -v.amount(text.slice(1)) : v.amount(text)); };
  return { item: await present(item), items: rows.map((row) => ({
    ...Object.fromEntries(['id', 'itemId', 'type', 'reason', 'actorId', 'actorUsername', 'occurredAt', 'itemVersion', 'before', 'after'].map((key) => [key, row[key]])),
    delta: signed(row.delta), beforeQuantity: signed(row.beforeQuantity), afterQuantity: signed(row.afterQuantity),
  })), total, page: filters.page, pageSize: filters.pageSize };
});
