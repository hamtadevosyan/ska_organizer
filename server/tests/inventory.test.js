const { randomUUID } = require('node:crypto');
const { runInNewContext } = require('node:vm');
const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');

const details = { name: 'Synthetic paper', category: 'Art supplies', location: 'Studio / Cupboard / Shelf 2',
  unit: 'pack', ingredientId: null, reorderThreshold: '2', openingQuantity: '10', reason: 'Opening physical count' };
const createBody = (values = {}) => ({ ...details, requestId: randomUUID(), ...values });
async function item(values = {}) {
  const response = await request(app).post('/api/inventory').send(createBody(values));
  expect(response.status).toBe(201);
  return response.body.data;
}
const moveBody = (stock, values = {}) => ({ type: 'addition', quantity: '1', unit: stock.unit, version: stock.version,
  reason: 'Synthetic stock change', requestId: randomUUID(), ...values });
const move = (stock, values) => request(app).post('/api/inventory/' + stock.id + '/movements').send(moveBody(stock, values));
const edit = (stock, values) => request(app).put('/api/inventory/' + stock.id).send({ version: stock.version,
  reason: 'Correct inventory details', requestId: randomUUID(), ...values });
const history = async (id) => {
  const response = await request(app).get('/api/inventory/' + id + '/movements');
  expect(response.status).toBe(200);
  return response.body;
};

test('opening, addition, usage, corrections and location edits retain an attributed, ordered history', async () => {
  const stock = await item({ name: '  Synthetic   paper  ' });
  expect(stock).toMatchObject({ name: 'Synthetic paper', quantity: '10', reorderThreshold: '2', status: 'available', version: 1, ingredient: null });
  const added = await move(stock, { quantity: '5', reason: 'Delivery put on shelf' });
  expect(added.status).toBe(200);
  expect(added.body.data).toMatchObject({ quantity: '15', version: 2 });
  const used = await move(added.body.data, { type: 'usage', quantity: '13', reason: 'Art class' });
  expect(used.status).toBe(200);
  expect(used.body.data).toMatchObject({ quantity: '2', status: 'low', version: 3 });
  const corrected = await move(used.body.data, { type: 'correction', quantity: '0', reason: 'Physical recount: shelf empty' });
  expect(corrected.status).toBe(200);
  expect(corrected.body.data).toMatchObject({ quantity: '0', status: 'out', version: 4 });
  const changed = await edit(corrected.body.data, { location: 'Studio / Cupboard / Shelf 3', reorderThreshold: '3' });
  expect(changed.status).toBe(200);
  const audit = await history(stock.id);
  expect(audit.items.map((row) => row.type)).toEqual(['details', 'correction', 'usage', 'addition', 'opening']);
  expect(audit.items.map((row) => row.delta)).toEqual(['0', '-2', '-13', '5', '10']);
  expect(audit.items.map((row) => row.itemVersion)).toEqual([5, 4, 3, 2, 1]);
  expect(audit.items[0]).toMatchObject({ before: { location: details.location, reorderThreshold: '2' },
    after: { location: 'Studio / Cupboard / Shelf 3', reorderThreshold: '3' }, beforeQuantity: '0', afterQuantity: '0' });
  expect(audit.items[4]).toMatchObject({ before: null, reason: 'Opening physical count', beforeQuantity: '0', afterQuantity: '10' });
  for (const row of audit.items) {
    expect(row).toMatchObject({ actorId: request.credentials().account.id, actorUsername: 'test-admin' });
    expect(Number.isNaN(Date.parse(row.occurredAt))).toBe(false);
    expect(row).not.toHaveProperty('request');
    expect(row).not.toHaveProperty('requestId');
  }
  expect((await request(app).get('/api/inventory/' + stock.id + '/movements?page=2&pageSize=2')).body.items.map((row) => row.itemVersion)).toEqual([3, 2]);
  expect((await request(app).delete('/api/inventory/' + stock.id)).status).toBe(404);
  expect((await request(app).put('/api/inventory/' + stock.id + '/movements/' + audit.items[0].id).send({ reason: 'Rewrite' })).status).toBe(404);
  expect((await history(stock.id)).items).toEqual(audit.items);
});

test('fractional stock is exact and invalid or incompatible quantities never change the balance', async () => {
  const stock = await item({ unit: 'lb', openingQuantity: '0.100000', reorderThreshold: '0.3' });
  const added = await move(stock, { quantity: '0.2' });
  expect(added.status).toBe(200);
  expect(added.body.data).toMatchObject({ quantity: '0.3', status: 'low' });
  const latest = added.body.data;
  for (const values of [{ type: 'usage', quantity: '0.300001' }, { unit: 'oz' }, { quantity: '-1' }, { quantity: '0.0000001' },
    { quantity: 1e12 }, { quantity: '1e2' }, { quantity: null }, { quantity: true }, { quantity: '0' }, { type: 'delete' }]) {
    expect((await move(latest, values)).status).toBe(values.type === 'usage' ? 409 : 400);
    expect((await history(stock.id)).total).toBe(2);
  }
  expect((await request(app).get('/api/inventory/' + stock.id)).body.data.quantity).toBe('0.3');
  const used = await move(latest, { type: 'usage', quantity: '0.3' });
  expect(used.status).toBe(200);
  expect(used.body.data).toMatchObject({ quantity: '0', status: 'out' });
  const large = await item({ openingQuantity: '999999999999.999999' });
  expect((await move(large, { quantity: '0.000001' })).status).toBe(400);
  expect((await history(large.id)).item.quantity).toBe('999999999999.999999');
});

// Keep independent validation cases separate: the former single test made 30
// serial API requests under one timeout, including real PostgreSQL transactions.
// Each named case now has its own timeout and the usual isolated test database.
test.each([
  ['blank name', { name: ' ' }],
  ['blank category', { category: '' }],
  ['blank location', { location: '' }],
  ['overlong location', { location: 'x'.repeat(201) }],
  ['unsupported unit', { unit: 'bucket' }],
  ['negative reorder threshold', { reorderThreshold: '-1' }],
  ['null opening quantity', { openingQuantity: null }],
  ['blank reason', { reason: '' }],
  ['overlong reason', { reason: 'x'.repeat(501) }],
  ['invalid request identifier', { requestId: 'short' }],
  ['invalid ingredient identifier', { ingredientId: [] }],
  ['client-supplied balance', { quantity: '7' }],
  ['spoofed actor', { actorId: 'another-user' }],
  ['spoofed time', { occurredAt: '2000-01-01' }],
])('inventory creation rejects %s without saving stock', async (_label, values) => {
  expect((await request(app).post('/api/inventory').send(createBody(values))).status).toBe(400);
  expect(await db.countInventory()).toBe(0);
  expect(await db.listInventoryGroups()).toHaveLength(0);
});

test.each([
  ['blank reason', { reason: '' }],
  ['invalid version', { version: null }],
  ['spoofed actor', { actorUsername: 'Impostor' }],
  ['spoofed time', { occurredAt: '2000-01-01' }],
])('stock movement rejects %s without changing stock or history', async (_label, values) => {
  const stock = await item();
  const before = await history(stock.id);
  expect((await move(stock, values)).status).toBe(400);
  expect(await history(stock.id)).toEqual(before);
});

test('metadata edits cannot set the inventory balance or change its history', async () => {
  const stock = await item();
  const before = await history(stock.id);
  expect((await edit(stock, { quantity: '100' })).status).toBe(400);
  expect(await history(stock.id)).toEqual(before);
});

test.each(['status=invalid', 'page=0', 'page=1.5', 'pageSize=101', 'category[]=Food', 'unknown=true'])(
  'inventory rejects invalid list filter %s', async (query) => {
    expect((await request(app).get('/api/inventory?' + query)).status).toBe(400);
  },
);

test('inventory history rejects filters other than pagination', async () => {
  const stock = await item();
  expect((await request(app).get('/api/inventory/' + stock.id + '/movements?status=low')).status).toBe(400);
  expect((await history(stock.id)).total).toBe(1);
});

test.each(['/api/inventory/missing', '/api/inventory/missing/movements'])(
  'missing inventory resource %s returns 404', async (url) => {
    expect((await request(app).get(url)).status).toBe(404);
  },
);

test('filters combine with literal search, global counts and pagination across categories and exact locations', async () => {
  const percent = await item({ name: 'Synthetic 100%_paper', openingQuantity: '2' });
  await item({ name: 'Synthetic 100XXpaper', openingQuantity: '3' });
  await item({ name: 'Synthetic glue', category: 'Cleaning', location: 'Closet / Shelf 1', openingQuantity: '0' });
  await item({ name: 'Synthetic towels', location: 'Closet / Shelf 1', openingQuantity: '5' });
  const response = await request(app).get('/api/inventory').query({ q: 'PAPER 100%_', category: details.category, location: details.location, status: 'low' });
  expect(response.status).toBe(200);
  expect(response.body.items.map((stock) => stock.id)).toEqual([percent.id]);
  expect(response.body).toMatchObject({ total: 1, summary: { total: 4, available: 2, lowStock: 1, outOfStock: 1 } });
  expect(response.body.options.categories).toEqual(['Art supplies', 'Cleaning']);
  expect(response.body.options.locations).toEqual(['Closet / Shelf 1', details.location]);
  const pages = await Promise.all([1, 2].map((page) => request(app).get('/api/inventory').query({ page, pageSize: 2 })));
  expect(pages.map((page) => page.body.items.length)).toEqual([2, 2]);
  expect(new Set(pages.flatMap((page) => page.body.items.map((stock) => stock.id))).size).toBe(4);
  expect((await request(app).get('/api/inventory/status')).body).toEqual(response.body.summary);
  expect((await request(app).get('/api/inventory/items?status=out')).body.items).toHaveLength(1);
});

test('food uses stable ingredient IDs and compatible units; archived links and historical units are retained', async () => {
  const ingredient = (await request(app).post('/api/ingredients').send({ name: 'Synthetic flour', unit: 'lb' })).body.data;
  expect(ingredient.id).toBeDefined();
  expect((await request(app).post('/api/inventory').send(createBody({ ingredientId: ingredient.id, unit: 'gal' }))).status).toBe(400);
  expect((await request(app).post('/api/inventory').send(createBody({ ingredientId: 'missing' }))).status).toBe(404);
  const stock = await item({ name: 'Flour bag', ingredientId: ingredient.id, unit: 'lb' });
  expect(stock.ingredient).toMatchObject({ id: ingredient.id, unit: 'lb' });
  expect((await request(app).put('/api/ingredients/' + ingredient.id).send({ unit: 'oz' })).status).toBe(409);
  expect((await edit(stock, { unit: 'oz', ingredientId: null })).status).toBe(409);
  expect((await request(app).put('/api/ingredients/' + ingredient.id).send({ name: 'Corrected flour', archived: true })).status).toBe(200);
  expect((await request(app).get('/api/inventory/' + stock.id)).body.data.ingredient).toMatchObject({ id: ingredient.id, name: 'Corrected flour', archived: true });
  expect((await request(app).post('/api/inventory').send(createBody({ ingredientId: ingredient.id, unit: 'lb' }))).status).toBe(409);
  const retained = await edit(stock, { name: 'Renamed flour bag' });
  expect(retained.status).toBe(200);
  const zero = await move(retained.body.data, { type: 'correction', quantity: '0' });
  expect(zero.status).toBe(200);
  const unlinked = await edit(zero.body.data, { unit: 'pack', ingredientId: null });
  expect(unlinked.status).toBe(200);
  expect(unlinked.body.data).toMatchObject({ unit: 'pack', ingredientId: null, quantity: '0' });
  const rows = (await history(stock.id)).items;
  expect(rows[0]).toMatchObject({ before: { unit: 'lb', ingredientId: ingredient.id }, after: { unit: 'pack', ingredientId: null } });
  expect(rows.at(-1).after).toMatchObject({ unit: 'lb', ingredientId: ingredient.id, quantity: '10' });
});

test('retries replay one opening or stock change and cannot reuse an identifier with different details', async () => {
  const opening = createBody();
  const created = await request(app).post('/api/inventory').send(opening);
  expect(created.status).toBe(201);
  const stock = created.body.data;
  const retry = await request(app).post('/api/inventory').send(opening);
  expect(retry.status).toBe(201);
  expect(retry.body.data).toMatchObject({ id: stock.id, quantity: '10', replayed: true, version: 1 });
  expect(await db.countInventory()).toBe(1);
  const payload = moveBody(stock, { quantity: '2' });
  const responses = await Promise.all([1, 2].map(() => request(app).post('/api/inventory/' + stock.id + '/movements').send(payload)));
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect((await history(stock.id))).toMatchObject({ total: 2, item: { quantity: '12', version: 2 } });
  expect((await request(app).post('/api/inventory/' + stock.id + '/movements').send({ ...payload, quantity: '3' })).body.error.code).toBe('INVENTORY_REQUEST_CONFLICT');
  const metadata = { name: 'Updated paper', version: 2, reason: 'Label correction', requestId: randomUUID() };
  expect((await request(app).put('/api/inventory/' + stock.id).send(metadata)).status).toBe(200);
  expect((await request(app).put('/api/inventory/' + stock.id).send(metadata)).body.data.replayed).toBe(true);
  expect((await history(stock.id))).toMatchObject({ total: 3, item: { name: 'Updated paper', quantity: '12', version: 3 } });
});

test('retries accept JSON from another realm and reordered keys but retain value types and operation scope', async () => {
  const opening = createBody();
  const created = await request(app).post('/api/inventory').send(opening);
  expect(created.status).toBe(201);
  const stock = created.body.data;
  const lookup = db.getInventoryMovementByRequestId;
  const foreign = jest.spyOn(db, 'getInventoryMovementByRequestId').mockImplementation(async (id) => {
    const stored = await lookup(id);
    // Emulate data returned across the Jest/Node realm boundary or by a driver.
    return stored ? runInNewContext('JSON.parse(serialized)', { serialized: JSON.stringify(stored) }) : null;
  });
  try {
    const reordered = Object.fromEntries(Object.entries(opening).reverse());
    const retry = await request(app).post('/api/inventory').send(reordered);
    expect(retry.status).toBe(201);
    expect(retry.body.data).toMatchObject({ id: stock.id, quantity: '10', version: 1, replayed: true });
    const changedType = await request(app).post('/api/inventory').send({ ...opening, openingQuantity: 10 });
    expect(changedType.status).toBe(409);
    expect(changedType.body.error.code).toBe('INVENTORY_REQUEST_CONFLICT');
    const changedOperation = await move(stock, { requestId: opening.requestId });
    expect(changedOperation.status).toBe(409);
    expect(changedOperation.body.error.code).toBe('INVENTORY_REQUEST_CONFLICT');
  } finally { foreign.mockRestore(); }
  expect(await db.countInventory()).toBe(1);
  expect((await history(stock.id))).toMatchObject({ total: 1, item: { quantity: '10', version: 1 } });
});

test('concurrent adjustments reject a stale balance instead of consuming or adding stock twice', async () => {
  const stock = await item({ openingQuantity: '1' });
  const results = await Promise.all([1, 2].map(() => move(stock, { type: 'usage', quantity: '1' })));
  expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(results.find((response) => response.status === 409).body.error.code).toBe('INVENTORY_CONFLICT');
  expect((await history(stock.id))).toMatchObject({ total: 2, item: { quantity: '0', version: 2 } });
  expect((await edit(stock, { location: 'Stale location' })).body.error.code).toBe('INVENTORY_CONFLICT');
});

test('a history or audit failure rolls back the balance and the same request can then be retried', async () => {
  const stock = await item();
  for (const method of ['appendInventoryMovement', 'appendAudit']) {
    const before = await history(stock.id);
    const payload = moveBody(before.item, { quantity: '0.5' });
    const failed = jest.spyOn(db, method).mockRejectedValueOnce(new Error('Synthetic ledger failure'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await request(app).post('/api/inventory/' + stock.id + '/movements').send(payload)).status).toBe(500); }
    finally { failed.mockRestore(); log.mockRestore(); }
    const unchanged = await history(stock.id);
    expect(unchanged.items).toEqual(before.items);
    expect(unchanged.item).toMatchObject({ quantity: before.item.quantity, version: before.item.version });
    expect((await request(app).post('/api/inventory/' + stock.id + '/movements').send(payload)).status).toBe(200);
    expect((await history(stock.id)).total).toBe(before.total + 1);
  }
  expect(await db.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'inventory.create', entityId: stock.id, actorId: request.credentials().account.id })]));
});

test('editors can manage inventory, viewers can read history and anonymous requests are rejected', async () => {
  expect((await anonymous(app).get('/api/inventory')).status).toBe(401);
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  const stock = await item();
  expect((await move(stock, { quantity: '1' })).status).toBe(200);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await request(app).get('/api/inventory')).status).toBe(200);
  expect((await history(stock.id)).total).toBe(2);
  expect((await request(app).post('/api/inventory').send(createBody())).status).toBe(403);
  expect((await edit(stock, { name: 'Unauthorized change' })).status).toBe(403);
  expect((await move(stock, { quantity: '5' })).status).toBe(403);
  expect((await history(stock.id)).item.quantity).toBe('11');
});

test('list failures return a retryable error instead of fabricated stock figures', async () => {
  const failed = jest.spyOn(db, 'countInventory').mockRejectedValueOnce(new Error('Synthetic read failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await request(app).get('/api/inventory');
    expect(response.status).toBe(500);
    expect(response.body.error.message).toBe('Internal server error.');
    expect(response.body).not.toHaveProperty('items');
  } finally { failed.mockRestore(); log.mockRestore(); }
  expect((await request(app).get('/api/inventory')).body.summary.total).toBe(0);
});
