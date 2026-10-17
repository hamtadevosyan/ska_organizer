const { createHash, randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const v = require('./inventoryValidation');
const validation = require('./batchPurchaseValidation');
const { compatible, convert } = require('./stockUnits');
const { problem, validateWeekStart } = require('./planValidation');

const MAX = 999999999999999999n;
const locked = (operation) => db.withCatalogLock(() => db.withInventoryLock(() => db.withPurchasingLock(operation)));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const json = (value) => JSON.stringify(canonical(value));
function calculationKey(list) {
  const { version: _version, savedAt: _savedAt, lines, ...immutable } = list;
  return createHash('sha256').update(json({ ...immutable, lines: lines.map(({ buyQuantity: _buy, selected: _selected, checked: _checked, ...line }) => line) })).digest('hex');
}
const conflict = (message, code = 'BATCH_PURCHASE_CONFLICT') => Object.assign(problem(message, 409), { code });
const publicBatch = (row) => Object.fromEntries(['id', 'receivedOn', 'supplier', 'reason', 'currency', 'actorId', 'actorUsername', 'recordedAt', 'purchasingRef', 'lines'].map((key) => [key, row[key] ?? null]));
const movementRequestId = (requestId, itemId) => 'b110_' + createHash('sha256').update(json([requestId, itemId])).digest('hex');
const itemSnapshot = (item) => ({ ...Object.fromEntries(['id', 'name', 'category', 'groupId', 'location', 'unit', 'ingredientId', 'version'].map((key) => [key, item[key]])),
  quantity: v.decimal(v.amount(item.quantity)), reorderThreshold: v.decimal(v.amount(item.reorderThreshold || '0')) });
async function savedList(weekStart) {
  const list = await db.getPurchasingList(validateWeekStart(weekStart));
  return list ? { list, calculationKey: calculationKey(list) } : null;
}
async function receiptTotals(value) {
  const { list, calculationKey: key } = value;
  const batches = await db.listPurchaseBatchesForCalculation(list.weekStart, key);
  const received = new Map();
  for (const batch of batches) for (const line of batch.lines) {
    if (!line.purchasingLineId) continue;
    received.set(line.purchasingLineId, (received.get(line.purchasingLineId) || 0n) + v.amount(line.stockDelta));
  }
  return { batches, received };
}
async function inactive(item) {
  if (!item || item.archived) return true;
  const group = item.groupId ? await db.getInventoryGroupById(item.groupId) : null;
  return !group || !!(group.archived || group.deletedAt);
}
async function progress(value) {
  const { list } = value;
  const { batches, received } = await receiptTotals(value);
  return { weekStart: list.weekStart, version: list.version, stockTakenAt: list.stockTakenAt,
    lines: await Promise.all(list.lines.map(async (line) => {
      const quantity = received.get(line.id) || 0n;
      const remaining = v.amount(line.buyQuantity) - quantity;
      const unavailable = line.itemId && await inactive(await db.getInventoryById(line.itemId));
      return { id: line.id, itemId: line.itemId, name: line.name, location: line.location, unit: line.unit,
        buyQuantity: v.decimal(v.amount(line.buyQuantity)), receivedQuantity: v.decimal(quantity),
        remainingQuantity: v.decimal(remaining > 0n ? remaining : 0n), selected: line.selected,
        ...(unavailable ? { unavailable: true, availabilityMessage: 'This inventory record is archived or unavailable. Refresh purchasing and choose an active record before receiving.' } : {}) };
    })), batches: batches.map(({ id, receivedOn, supplier, recordedAt }) => ({ id, receivedOn, supplier, recordedAt })),
    note: 'Only receipts linked to this saved stock calculation count here. Manual check-offs do not receive stock. An explicitly refreshed calculation starts a new receiving baseline.' };
}
async function review(request) {
  let purchasingRef = null;
  let list = null;
  let byLine = new Map();
  let received = new Map();
  if (request.purchasingRef) {
    const value = await savedList(request.purchasingRef.weekStart);
    if (!value || value.list.version !== request.purchasingRef.version) throw conflict('This purchasing list changed elsewhere. Reopen its saved version and review the receipt again.', 'PURCHASING_CONFLICT');
    list = value.list;
    if (list.issues.length) throw conflict('Resolve the purchasing list issues and save it before receiving linked purchases.');
    purchasingRef = { weekStart: list.weekStart, version: list.version, stockTakenAt: list.stockTakenAt, calculationKey: value.calculationKey };
    byLine = new Map(list.lines.map((line) => [line.id, line]));
    received = (await receiptTotals(value)).received;
  }
  const lines = [];
  for (const line of request.lines) {
    const item = await db.getInventoryById(line.itemId);
    if (!item) throw problem('A selected inventory record is unavailable. Choose an existing record and location before receiving.', 404);
    if (await inactive(item)) throw conflict(item.name + ' is archived or belongs to an inactive group. Choose an active inventory record before receiving.', 'INVENTORY_ARCHIVED');
    if (item.version !== line.version) throw conflict(item.name + ' changed elsewhere. Refresh its current version and review the receipt again.', 'INVENTORY_CONFLICT');
    if (!v.UNITS.includes(item.unit) || !compatible(line.unit, item.unit)) throw problem('The received unit for ' + item.name + ' is incompatible with its recorded ' + item.unit + '. Choose a compatible weight, volume or exact package unit.', 422);
    const value = v.amount(line.quantity);
    const delta = convert(value, line.unit, item.unit);
    if (delta <= 0n) throw problem('The received amount for ' + item.name + ' is below recorded-unit precision. Enter a quantity representable to six decimal places in ' + item.unit + '.', 422);
    const before = v.amount(item.quantity);
    if (delta > MAX || before + delta > MAX) throw problem('The resulting stock for ' + item.name + ' would exceed the supported quantity.', 422);
    if (await db.getInventoryMovementByRequestId(movementRequestId(request.requestId, item.id))) throw conflict('This receipt identifier conflicts with an existing inventory operation. Review and use a new receipt identifier.');
    const notes = [];
    if (line.unit !== item.unit) notes.push('Received ' + line.quantity + ' ' + line.unit + '; recorded ' + v.decimal(delta) + ' ' + item.unit + '. Conversion rounds down to six decimal places, so stock is never overstated.');
    let plannedQuantity = null;
    let previouslyReceived = null;
    let remainingQuantity = null;
    if (line.purchasingLineId) {
      const planned = byLine.get(line.purchasingLineId);
      if (!planned || !planned.selected || planned.itemId !== item.id || planned.unit !== item.unit) throw conflict('A linked purchasing line is missing, unselected or uses a different inventory record or unit. Reopen the purchasing list and review this receipt.');
      const prior = received.get(planned.id) || 0n;
      const remaining = v.amount(planned.buyQuantity) - prior;
      plannedQuantity = v.decimal(v.amount(planned.buyQuantity));
      previouslyReceived = v.decimal(prior);
      remainingQuantity = v.decimal(remaining > 0n ? remaining : 0n);
      if (delta > (remaining > 0n ? remaining : 0n)) notes.push('This actual received quantity exceeds the linked list’s remaining ' + remainingQuantity + ' ' + item.unit + '. Confirm the goods and destination; the purchasing list itself will not change.');
    }
    lines.push({ itemId: item.id, name: item.name, location: item.location || null, quantity: line.quantity, unit: line.unit,
      stockUnit: item.unit, stockDelta: v.decimal(delta), beforeQuantity: v.decimal(before), afterQuantity: v.decimal(before + delta),
      totalCost: line.totalCost, versionBefore: item.version, versionAfter: item.version + 1,
      purchasingLineId: line.purchasingLineId || null, plannedQuantity, previouslyReceived, remainingQuantity, notes,
      itemSnapshot: itemSnapshot({ ...item, quantity: v.decimal(before + delta), version: item.version + 1 }) });
  }
  return { request, lines, purchasingRef };
}
exports.preview = (input) => {
  const request = validation.payload(input);
  return locked(() => review(request));
};
exports.receive = (input, actor) => {
  const request = validation.payload(input);
  return locked(async () => {
    const signature = { request, actorId: actor.id };
    const repeated = await db.getPurchaseBatchByRequestId(request.requestId);
    if (repeated) {
      if (json(repeated.request) !== json(signature)) throw conflict('This receipt identifier was already used with different details or another account. Reopen the saved receipt before creating a new one.', 'BATCH_REQUEST_CONFLICT');
      return { batch: publicBatch(repeated), replayed: true };
    }
    // Validate every line before inserting anything. The inventory/purchasing
    // locks and outer audit transaction also protect failures after a write.
    const checked = await review(request);
    const recordedAt = new Date().toISOString();
    const batch = await db.createPurchaseBatch({ id: randomUUID(), requestId: request.requestId, request: signature,
      receivedOn: request.receivedOn, supplier: request.supplier, reason: request.reason, currency: 'USD',
      actorId: actor.id, actorUsername: actor.username, recordedAt, purchasingRef: checked.purchasingRef,
      purchasingWeekStart: checked.purchasingRef?.weekStart || null, purchasingCalculationKey: checked.purchasingRef?.calculationKey || null,
      lines: checked.lines });
    const finalLines = [];
    for (const line of checked.lines) {
      const before = await db.getInventoryById(line.itemId);
      const saved = await db.updateInventory(line.itemId, { quantity: line.afterQuantity, version: line.versionAfter });
      const movement = await db.appendInventoryMovement({ itemId: line.itemId, batchId: batch.id, type: 'addition', delta: line.stockDelta,
        beforeQuantity: line.beforeQuantity, afterQuantity: line.afterQuantity, before: itemSnapshot(before), after: itemSnapshot(saved),
        itemVersion: line.versionAfter, reason: request.reason, actorId: actor.id, actorUsername: actor.username,
        occurredAt: recordedAt, requestId: movementRequestId(request.requestId, line.itemId), request: { operation: 'batch-purchase', batchId: batch.id, actorId: actor.id } });
      const receipt = await db.createPurchaseReceipt({ batchId: batch.id, itemId: line.itemId, movementId: movement.id,
        quantity: line.stockDelta, unit: line.stockUnit, receivedOn: request.receivedOn, supplier: request.supplier, totalCost: line.totalCost,
        currency: 'USD', itemSnapshot: itemSnapshot(saved), actorId: actor.id, actorUsername: actor.username, recordedAt });
      finalLines.push({ ...line, receiptId: receipt.id, movementId: movement.id, itemSnapshot: itemSnapshot(saved) });
    }
    const saved = await db.updatePurchaseBatch(batch.id, { lines: finalLines });
    return { batch: publicBatch(saved), replayed: false };
  });
};
exports.get = (id) => db.withInventoryLock(async () => {
  const row = await db.getPurchaseBatchById(validation.identifier(id, 'batchId'));
  if (!row) throw problem('Received-purchase batch not found.', 404);
  return publicBatch(row);
});
exports.byRequest = (requestId, actor) => db.withInventoryLock(async () => {
  v.requestId({ requestId });
  const row = await db.getPurchaseBatchByRequestId(requestId);
  if (row && row.actorId !== actor.id) throw conflict('This receipt identifier belongs to another account.', 'BATCH_REQUEST_CONFLICT');
  return row ? publicBatch(row) : null;
});
exports.list = (query = {}) => db.withInventoryLock(async () => {
  const pagination = v.pagination(query, ['page', 'pageSize']);
  const [items, total] = await Promise.all([db.listPurchaseBatches(pagination), db.countPurchaseBatches()]);
  return { items: items.map(publicBatch), total, ...pagination, ...require('./inventoryService').purchaseConfig() };
});
exports.fulfillment = (weekStart) => db.withInventoryLock(() => db.withPurchasingLock(async () => {
  const value = await savedList(weekStart);
  return value ? progress(value) : null;
}));
exports.calculationKey = calculationKey;
