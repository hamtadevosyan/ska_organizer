const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const db = require('./dbAdapter');
const { problem, validateWeekStart } = require('./planValidation');
const { amount, decimal, UNITS } = require('./inventoryValidation');
const { calculate, MAX_LINES, MAX_ENTRIES } = require('./purchasingCalculation');

const key = randomBytes(32);
const MAX_TOKEN_BYTES = 700000;
const signature = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
const expired = () => Object.assign(problem('This purchasing calculation expired. Refresh the preview and review it before saving.', 409),
  { code: 'PURCHASING_PREVIEW_EXPIRED' });
const conflict = () => Object.assign(problem('This purchasing list changed elsewhere. Reopen the saved list and review your changes before saving.', 409),
  { code: 'PURCHASING_CONFLICT' });
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('Supply purchasing list details.');
  for (const name of Object.keys(value)) if (!allowed.includes(name)) throw problem('This purchasing field cannot be changed.');
}
function identifier(value, label, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value !== value.trim()) throw problem('Choose a valid ' + label + '.');
  return value;
}
function version(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 2147483647) throw problem('Reload the purchasing list before saving. A valid version is required.');
  return value;
}
function selection(input) {
  object(input, ['includeMeals', 'roomIds', 'lowStockTargets']);
  if (typeof input.includeMeals !== 'boolean') throw problem('Choose whether to include the saved meal plan.');
  if (!Array.isArray(input.roomIds) || input.roomIds.length > 100) throw problem('Choose up to 100 activity rooms.');
  const roomIds = input.roomIds.map((id) => identifier(id, 'activity room'));
  if (new Set(roomIds).size !== roomIds.length) throw problem('Choose each activity room only once.');
  if (!Array.isArray(input.lowStockTargets) || input.lowStockTargets.length > 100) throw problem('Choose up to 100 low-stock targets.');
  const lowStockTargets = input.lowStockTargets.map((target) => {
    object(target, ['itemId', 'targetQuantity']);
    const itemId = identifier(target.itemId, 'inventory item');
    if (typeof target.targetQuantity !== 'string') throw problem('Enter the target quantity as a decimal amount in the recorded unit.');
    const value = amount(target.targetQuantity, 'targetQuantity');
    if (value <= 0n) throw problem('Enter a total coverage target greater than zero.');
    return { itemId, targetQuantity: decimal(value) };
  });
  if (new Set(lowStockTargets.map((target) => target.itemId)).size !== lowStockTargets.length) throw problem('Choose each low-stock inventory record only once.');
  if (!input.includeMeals && !roomIds.length && !lowStockTargets.length) throw problem('Include meals, an activity room or a low-stock target to create a purchasing list.');
  return { includeMeals: input.includeMeals, roomIds: roomIds.sort(), lowStockTargets: lowStockTargets.sort((a, b) => a.itemId.localeCompare(b.itemId)) };
}
function encode(list) {
  const payload = Buffer.from(JSON.stringify({ list, version: list.version, expires: Date.now() + 3600000 })).toString('base64url');
  if (Buffer.byteLength(payload) > MAX_TOKEN_BYTES) throw problem('This purchasing calculation is too large to review and save safely. Include fewer room plans.', 422);
  const token = payload + '.' + signature(payload);
  // Leave space for every permitted choice, including long legacy identifiers,
  // inside this route's authenticated 1 MB request limit.
  const largestReview = { version: 2147483646, token, choices: list.lines.map((line) => ({ id: line.id,
    buyQuantity: '999999999999.999999', selected: false, checked: false })) };
  if (Buffer.byteLength(JSON.stringify(largestReview)) > 1000000) throw problem('This purchasing calculation is too large to review and save safely. Include fewer room plans.', 422);
  return token;
}
function decode(token) {
  if (typeof token !== 'string' || !token.length || Buffer.byteLength(token) > MAX_TOKEN_BYTES + 50) throw expired();
  const [payload, receivedSignature, extra] = token.split('.');
  if (!/^[A-Za-z0-9_-]+$/.test(payload || '') || extra || !receivedSignature) throw expired();
  const expected = Buffer.from(signature(payload));
  const received = Buffer.from(receivedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw expired();
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw expired(); }
  if (!Number.isSafeInteger(value.expires) || value.expires <= Date.now() || !value.list || value.version !== value.list.version) throw expired();
  return value;
}
function reviewed(list, choices) {
  if (!Array.isArray(choices) || choices.length !== list.lines.length || choices.length > MAX_LINES) throw problem('Review every purchasing line before saving.');
  const byId = new Map();
  for (const choice of choices) {
    object(choice, ['id', 'buyQuantity', 'selected', 'checked']);
    identifier(choice.id, 'purchasing line', 300);
    if (byId.has(choice.id)) throw problem('Review each purchasing line only once.');
    if (typeof choice.buyQuantity !== 'string') throw problem('Enter each buying quantity as a decimal amount.');
    const quantity = decimal(amount(choice.buyQuantity, 'buyQuantity'));
    if (typeof choice.selected !== 'boolean' || typeof choice.checked !== 'boolean') throw problem('Choose whether each line is selected and checked off.');
    if (choice.checked && !choice.selected) throw problem('Only a selected purchasing line can be checked off.');
    byId.set(choice.id, { buyQuantity: quantity, selected: choice.selected, checked: choice.checked });
  }
  return { ...list, lines: list.lines.map((line) => {
    const choice = byId.get(line.id);
    if (!choice) throw problem('A purchasing line changed. Review the list before saving.');
    return { ...line, ...choice };
  }) };
}

exports.get = (weekStart) => db.getPurchasingList(validateWeekStart(weekStart));
exports.options = () => db.withRoomLock(() => db.withInventoryLock(async () => {
  const [rooms, stock] = await Promise.all([db.listRooms({ includeArchived: true }), db.listAllInventory()]);
  const lowStock = stock.filter((row) => UNITS.includes(row.unit) && amount(row.quantity) <= amount(row.reorderThreshold || '0'));
  if (rooms.length > 10000 || lowStock.length > 10000) throw problem('There are too many purchasing options to review at once. Review Inventory and room records first.', 422);
  return { rooms: rooms.map((room) => ({ id: room.id, name: room.name, archived: !room.active })),
    lowStock: lowStock.map((row) => ({ id: row.id, name: row.name, location: row.location || null, unit: row.unit,
      quantity: decimal(amount(row.quantity)), reorderThreshold: decimal(amount(row.reorderThreshold || '0')), version: row.version })) };
}));
exports.preview = (weekStart, input) => {
  validateWeekStart(weekStart);
  const selected = selection(input);
  return db.withCatalogLock(() => db.withRoomLock(() => db.withInventoryLock(() => db.withPurchasingLock(async () => {
    const [previous, mealPlan, rooms, inventory] = await Promise.all([db.getPurchasingList(weekStart),
      selected.includeMeals ? db.getWeeklyPlan(weekStart) : null, db.listRooms({ includeArchived: true }), db.listAllInventory()]);
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    const storedPlans = await Promise.all(selected.roomIds.map(async (roomId) => {
      const [header, entries] = await Promise.all([db.getScheduleWeek(roomId, weekStart), db.listScheduleEntries(roomId, weekStart)]);
      return { room: roomById.get(roomId) || null, header, entries };
    }));
    if (storedPlans.reduce((sum, plan) => sum + plan.entries.length, 0) > MAX_ENTRIES) throw problem('This purchasing calculation has too many activities. Include fewer room plans.', 422);
    // Older snapshots omitted free-text material hints. They cannot safely
    // borrow current quantities, but current hints can require a plan review.
    const hasLegacyHints = (entry) => entry.activitySnapshot &&
      !(Object.hasOwn(entry.activitySnapshot, 'materialsNotes') && Object.hasOwn(entry.activitySnapshot, 'materialsLinks'));
    const legacyIds = [...new Set(storedPlans.flatMap((plan) => plan.entries.filter(hasLegacyHints).map((entry) => entry.activityId)))];
    const legacyHints = new Map(await Promise.all(legacyIds.map(async (id) => [id, await db.getActivityById(id)])));
    const activityPlans = storedPlans.map((plan) => ({ ...plan, entries: plan.entries.map((entry) => {
      if (!hasLegacyHints(entry)) return entry;
      const current = legacyHints.get(entry.activityId);
      return { ...entry, materialHintsUnknown: !!(typeof current?.materialsNotes === 'string' && current.materialsNotes.trim() || current?.materialsLinks?.length) };
    }) }));
    const list = calculate({ ...selected, weekStart, version: previous?.version || 0, mealPlan, activityPlans, inventory });
    return { list, token: list.issues.length ? '' : encode(list) };
  }))));
};
exports.save = (weekStart, input) => {
  validateWeekStart(weekStart);
  object(input, ['version', 'token', 'choices']);
  const expectedVersion = version(input.version);
  return db.withPurchasingLock(async () => {
    let list;
    if (Object.hasOwn(input, 'token')) {
      const decoded = decode(input.token);
      if (decoded.list.weekStart !== weekStart) throw problem('This purchasing calculation belongs to another week.');
      if (decoded.version !== expectedVersion) throw conflict();
      list = decoded.list;
    } else {
      list = await db.getPurchasingList(weekStart);
      if (!list) throw problem('Refresh a purchasing preview before saving this week.', 409);
      if (list.version !== expectedVersion) throw conflict();
    }
    if (list.issues.length) throw problem('Resolve the missing or incompatible plan details before saving this purchasing list.', 409);
    return db.savePurchasingList(reviewed(list, input.choices), expectedVersion);
  });
};
