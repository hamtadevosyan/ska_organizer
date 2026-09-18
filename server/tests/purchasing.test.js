const { randomUUID } = require('node:crypto');
const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const time = require('../services/facilityTime');
const amounts = require('../services/inventoryValidation');
const quantity = async (id) => amounts.decimal(amounts.amount((await db.getInventoryById(id)).quantity));

async function stock(changes = {}) {
  const response = await request(app).post('/api/inventory').send({ name: 'Synthetic supplies', category: 'Classroom',
    location: 'Studio / Shelf 1', unit: 'pack', ingredientId: null, openingQuantity: '0.1', reorderThreshold: '0',
    reason: 'Opening count', requestId: randomUUID(), ...changes });
  expect(response.status).toBe(201); return response.body.data;
}
const receiptBody = (item, changes = {}) => ({ quantity: '0.2', unit: item.unit, version: item.version,
  receivedOn: time.dateAt(), supplier: 'Synthetic supplier', totalCost: '12.30', requestId: randomUUID(), ...changes });
const receive = (item, body) => request(app).post('/api/inventory/' + item.id + '/purchases').send(body);
const purchases = (item) => request(app).get('/api/inventory/purchases' + (item ? '?itemId=' + item.id : ''));

test('a received purchase adds exact stock once and keeps its original item details and attribution', async () => {
  const item = await stock(); const body = receiptBody(item);
  const response = await receive(item, body); expect(response.status).toBe(201);
  expect(response.body.data.item).toMatchObject({ quantity: '0.3', version: 2 });
  const receipt = response.body.data.receipt;
  expect(receipt).toMatchObject({ itemId: item.id, quantity: '0.2', unit: 'pack', totalCost: '12.30', currency: 'USD',
    receivedOn: body.receivedOn, supplier: 'Synthetic supplier', actorId: request.credentials().account.id,
    actorUsername: 'test-admin', itemSnapshot: { name: item.name, location: item.location, quantity: '0.3', version: 2 } });
  expect(Number.isNaN(Date.parse(receipt.recordedAt))).toBe(false);
  const repeats = await Promise.all([receive(item, body), receive(item, Object.fromEntries(Object.entries(body).reverse()))]);
  for (const repeated of repeats) {
    expect(repeated.status).toBe(201);
    expect(repeated.body.data).toMatchObject({ receipt, replayed: true, item: { quantity: '0.3', version: 2 } });
  }
  const edited = await request(app).put('/api/inventory/' + item.id).send({ name: 'Relabeled item', location: 'Shelf 2',
    version: 2, reason: 'Relabeled storage', requestId: randomUUID() });
  expect(edited.status).toBe(200);
  expect((await purchases(item)).body).toMatchObject({ items: [receipt], total: 1 });
  expect(await db.countInventoryMovements(item.id)).toBe(3);
});

test.each([
  ['negative quantity', { quantity: '-1' }], ['zero quantity', { quantity: '0' }],
  ['excess precision', { quantity: '0.0000001' }], ['incompatible unit', { unit: 'gal' }],
  ['negative cost', { totalCost: '-0.01' }], ['cost precision', { totalCost: '1.001' }],
  ['non-numeric cost', { totalCost: 'NaN' }], ['invalid date', { receivedOn: '2026-02-30' }],
  ['future date', { receivedOn: '9999-01-01' }], ['spoofed actor', { actorId: 'someone-else' }],
  ['spoofed recorded time', { recordedAt: '2000-01-01' }], ['invalid request ID', { requestId: 'short' }],
  ['invalid supplier', { supplier: [] }], ['currency override', { currency: 'EUR' }],
])('receipts reject %s without creating a receipt or increasing stock', async (_name, changes) => {
  const item = await stock();
  expect((await receive(item, receiptBody(item, changes))).status).toBe(400);
  expect(await db.countPurchaseReceipts()).toBe(0);
  expect(await db.countInventoryMovements(item.id)).toBe(1);
  expect(await quantity(item.id)).toBe('0.1');
});

test('optional supplier/cost, zero cost and pagination retain distinct received purchases', async () => {
  const item = await stock();
  const first = await receive(item, receiptBody(item, { supplier: null, totalCost: null }));
  expect(first.status).toBe(201);
  expect(first.body.data.receipt).toMatchObject({ supplier: null, totalCost: null });
  const second = await receive(first.body.data.item, receiptBody(first.body.data.item, { totalCost: '0' }));
  expect(second.status).toBe(201); expect(second.body.data.receipt.totalCost).toBe('0.00');
  const pages = await Promise.all([1, 2].map((page) => request(app).get('/api/inventory/purchases?pageSize=1&page=' + page)));
  expect(pages.every((response) => response.status === 200 && response.body.total === 2)).toBe(true);
  expect(new Set(pages.map((response) => response.body.items[0].id)).size).toBe(2);
});

test('conflicting request reuse and stale item versions cannot add stock twice', async () => {
  const item = await stock(); const body = receiptBody(item);
  expect((await receive(item, body)).status).toBe(201);
  expect((await receive(item, { ...body, quantity: '1' })).body.error.code).toBe('INVENTORY_REQUEST_CONFLICT');
  expect((await receive(item, receiptBody(item))).body.error.code).toBe('INVENTORY_CONFLICT');
  const move = await request(app).post('/api/inventory/' + item.id + '/movements').send({ type: 'addition',
    quantity: '0.2', unit: item.unit, version: 2, reason: 'Different action', requestId: body.requestId });
  expect(move.body.error.code).toBe('INVENTORY_REQUEST_CONFLICT');
  expect(await quantity(item.id)).toBe('0.3');
  expect(await db.countPurchaseReceipts()).toBe(1);
});

test.each(['appendInventoryMovement', 'createPurchaseReceipt', 'appendAudit'])('%s failure rolls back the entire receipt and permits an identical retry', async (method) => {
  const item = await stock(); const body = receiptBody(item);
  const failure = jest.spyOn(db, method).mockRejectedValueOnce(new Error('Synthetic receipt failure'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { expect((await receive(item, body)).status).toBe(500); }
  finally { failure.mockRestore(); logging.mockRestore(); }
  expect(await db.countPurchaseReceipts()).toBe(0);
  expect(await db.countInventoryMovements(item.id)).toBe(1);
  expect(await quantity(item.id)).toBe('0.1');
  expect((await receive(item, body)).status).toBe(201);
  expect(await db.countPurchaseReceipts()).toBe(1);
});

test('editors receive purchases; viewers read history but cannot receive; authentication remains required', async () => {
  const item = await stock();
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  expect((await receive(item, receiptBody(item))).status).toBe(201);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await purchases()).status).toBe(200);
  expect((await receive(item, receiptBody(item))).status).toBe(403);
  expect((await anonymous(app).get('/api/inventory/purchases')).status).toBe(401);
  // A viewer is rejected before routing; an administrator reaches the missing route.
  expect((await request(app).delete('/api/inventory/purchases/anything')).status).toBe(403);
  await db.updateAccount(request.credentials().account.id, { role: 'admin' });
  expect((await request(app).delete('/api/inventory/purchases/anything')).status).toBe(404);
});

test('shopping reads linked stock across locations while saved snapshots, printing reads and planning never consume it', async () => {
  const ingredient = await db.createIngredient({ name: 'Same display name', unit: 'count' });
  const other = await db.createIngredient({ name: 'Same display name', unit: 'count' });
  const meal = await db.createMeal({ name: 'Synthetic breakfast', type: 'breakfast' });
  await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity: 1 });
  const first = await stock({ category: 'Food', ingredientId: ingredient.id, unit: 'count', openingQuantity: '2' });
  await stock({ category: 'Food', ingredientId: ingredient.id, unit: 'count', location: 'Shelf 2', openingQuantity: '1' });
  await stock({ category: 'Food', ingredientId: other.id, unit: 'count', openingQuantity: '100' });
  const path = '/api/menu/plans/2026-09-07';
  const body = { version: 0, childrenCount: 4, staffCount: 1, week: [{ day: 'Monday', menu: { breakfast: meal } }] };
  const preview = await request(app).post(path + '/preview').send(body); expect(preview.status).toBe(200);
  expect(preview.body.data).toMatchObject({ stockSource: 'inventory', items: [{ quantity: 5, inStorage: 3, toBuy: 2 }] });
  expect(preview.body.data.items[0].stockItems).toHaveLength(2);
  const saved = await request(app).put(path).send({ previewToken: preview.body.data.previewToken }); expect(saved.status).toBe(200);
  expect(await quantity(first.id)).toBe('2');
  expect((await receive(first, receiptBody(first, { quantity: '4' }))).status).toBe(201);
  const refreshed = await request(app).post(path + '/preview').send({ ...body, version: 1 });
  expect(refreshed.body.data.items[0]).toMatchObject({ quantity: 5, inStorage: 7, toBuy: 0 });
  const historical = await request(app).get(path + '/shopping');
  expect(historical.body.data.items[0]).toMatchObject({ inStorage: 3, toBuy: 2 });
  expect((await request(app).get(path)).body.data).toEqual(saved.body.data);
  expect(await quantity(first.id)).toBe('6');
  const manual = await request(app).post(path + '/preview').send({ ...body, version: 1, inHouse: { [ingredient.id]: 100 } });
  expect(manual.status).toBe(400); expect(manual.body.error.message).toMatch(/count correction/);
});

test('connecting existing food preserves its stock and history while shopping converts pounds to recipe grams', async () => {
  const ingredient = await db.createIngredient({ name: 'Oats for recipes', unit: 'g' });
  const other = await db.createIngredient({ name: 'Different food', unit: 'g' });
  const meal = await db.createMeal({ name: 'Oat breakfast', type: 'breakfast' });
  await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity: 1000 });
  const item = await stock({ category: 'Food', name: ingredient.name, unit: 'lb', openingQuantity: '2' });
  const path = '/api/menu/plans/2026-09-07/preview';
  const draft = { version: 0, childrenCount: 1, staffCount: 0, week: [{ day: 'Monday', menu: { breakfast: meal } }] };
  const before = await request(app).post(path).send(draft);
  expect(before.status).toBe(200);
  expect(before.body.data.items[0]).toMatchObject({ quantity: 1000, inStorage: 0, toBuy: 1000 });
  const payload = { ingredientId: ingredient.id, version: 1, reason: 'Connected existing food', requestId: randomUUID() };
  const connected = await request(app).put('/api/inventory/' + item.id).send(payload);
  expect(connected.status).toBe(200);
  expect(connected.body.data).toMatchObject({ ingredientId: ingredient.id, quantity: '2', unit: 'lb', version: 2 });
  const retry = await request(app).put('/api/inventory/' + item.id).send(payload);
  expect(retry.status).toBe(200); expect(retry.body.data.replayed).toBe(true);
  const after = await request(app).post(path).send(draft);
  expect(after.status).toBe(200);
  expect(after.body.data.items[0]).toMatchObject({ quantity: 1000, inStorage: 907.18474, toBuy: 92.81526,
    stockItems: [{ id: item.id, quantity: '2', unit: 'lb' }] });
  const history = await request(app).get('/api/inventory/' + item.id + '/movements');
  expect(history.body.total).toBe(2);
  expect(history.body.items[0]).toMatchObject({ type: 'details', delta: '0', beforeQuantity: '2', afterQuantity: '2',
    before: { ingredientId: null }, after: { ingredientId: ingredient.id } });
  expect(history.body.items[1].after.ingredientId).toBeNull();
  // Connecting unlinked stock must not permit relabeling an already connected balance.
  for (const values of [{ ingredientId: other.id }, { unit: 'g' }]) {
    expect((await request(app).put('/api/inventory/' + item.id).send({ ...values, version: 2, reason: 'Invalid relabel', requestId: randomUUID() })).status).toBe(409);
  }
  expect(await quantity(item.id)).toBe('2');
});

const newFoodBody = (groupId) => ({ groupId, name: 'Brown rice', location: 'Kitchen / Rice bin', unit: 'lb',
  ingredientId: null, newIngredient: { name: 'Brown rice', unit: 'lb' }, openingQuantity: '2', reorderThreshold: '0',
  reason: 'Initial quantity recorded', requestId: randomUUID() });
async function foodGroup() {
  const response = await request(app).post('/api/inventory/groups').send({ name: 'Pantry foods', kind: 'food', requestId: randomUUID() });
  expect(response.status).toBe(201); return response.body.data;
}

test('adding new food creates its recipe ingredient and stock together and retries only once', async () => {
  const group = await foodGroup(); const body = newFoodBody(group.id);
  const beforeCount = (await db.listIngredients({ includeArchived: true })).length;
  const created = await request(app).post('/api/inventory').send(body);
  expect(created.status).toBe(201);
  const item = created.body.data;
  expect(item).toMatchObject({ quantity: '2', unit: 'lb', ingredient: { name: 'Brown rice', unit: 'lb' } });
  expect(item.ingredientId).toBe(item.ingredient.id);
  const retry = await request(app).post('/api/inventory').send(body);
  expect(retry.status).toBe(201); expect(retry.body.data).toMatchObject({ id: item.id, replayed: true, version: 1 });
  expect((await db.listIngredients({ includeArchived: true })).length).toBe(beforeCount + 1);
  expect(await db.countInventoryMovements(item.id)).toBe(1);
  const duplicate = await request(app).post('/api/inventory').send({ ...body, requestId: randomUUID(), newIngredient: { name: '  brown   RICE ', unit: 'lb' } });
  expect(duplicate.status).toBe(409); expect(duplicate.body.error.fields.newIngredient).toMatch(/already exists/);
  expect(await db.countInventory()).toBe(1);
  expect((await db.listIngredients({ includeArchived: true })).length).toBe(beforeCount + 1);
});

test.each(['appendInventoryMovement', 'appendAudit'])('new-food %s failure leaves no orphan ingredient and identical retry creates one connected item', async (method) => {
  const group = await foodGroup(); const body = newFoodBody(group.id);
  const before = await db.listIngredients({ includeArchived: true });
  const failure = jest.spyOn(db, method).mockRejectedValueOnce(new Error('Synthetic food creation failure'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { expect((await request(app).post('/api/inventory').send(body)).status).toBe(500); }
  finally { failure.mockRestore(); logging.mockRestore(); }
  expect(await db.listIngredients({ includeArchived: true })).toEqual(before);
  expect(await db.countInventory()).toBe(0);
  const retry = await request(app).post('/api/inventory').send(body);
  expect(retry.status).toBe(201);
  expect(retry.body.data.ingredient).toMatchObject({ name: 'Brown rice', unit: 'lb' });
  expect((await db.listIngredients({ includeArchived: true })).length).toBe(before.length + 1);
  expect(await db.countInventory()).toBe(1);
});
