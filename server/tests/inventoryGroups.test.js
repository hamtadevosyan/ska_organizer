const { randomUUID } = require('node:crypto');
const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');

async function group(values = {}) {
  const response = await request(app).post('/api/inventory/groups').send({ name: 'Classroom materials', kind: 'supplies',
    description: 'Materials used in the classrooms', requestId: randomUUID(), ...values });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function stock(groupId, values = {}) {
  const response = await request(app).post('/api/inventory').send({ groupId, name: 'Paper', location: 'Studio / Shelf 2',
    unit: 'pack', openingQuantity: '2', reorderThreshold: '2', reason: 'Initial count', requestId: randomUUID(), ...values });
  expect(response.status).toBe(201);
  return response.body.data;
}

test('empty groups exist independently and keep separate stock counts and filtered lists', async () => {
  const materials = await group();
  const decorations = await group({ name: 'Decorations' });
  const food = await group({ name: 'Food stock', kind: 'food' });
  let overview = await request(app).get('/api/inventory/groups');
  expect(overview.status).toBe(200);
  expect(overview.body.items).toHaveLength(3);
  expect(overview.body.items.every((item) => item.summary.total === 0)).toBe(true);
  expect(overview.body.items[0]).not.toHaveProperty('request');
  const paper = await stock(materials.id);
  await stock(materials.id, { name: 'Paint', openingQuantity: '5' });
  await stock(decorations.id, { name: 'Banners', openingQuantity: '0' });
  overview = await request(app).get('/api/inventory/groups');
  expect(overview.body.items.find((item) => item.id === materials.id)).toMatchObject({ summary: { total: 2, available: 1, lowStock: 1, outOfStock: 0 } });
  expect(overview.body.items.find((item) => item.id === decorations.id)).toMatchObject({ summary: { total: 1, available: 0, lowStock: 0, outOfStock: 1 } });
  expect(overview.body.items.find((item) => item.id === food.id)).toMatchObject({ summary: { total: 0 } });
  const response = await request(app).get('/api/inventory').query({ groupId: materials.id, status: 'low' });
  expect(response.status).toBe(200);
  expect(response.body.items.map((item) => item.id)).toEqual([paper.id]);
  expect(response.body.items[0]).toMatchObject({ groupId: materials.id, group: { name: 'Classroom materials', kind: 'supplies' } });
  expect((await request(app).get('/api/inventory?groupId=missing')).status).toBe(404);
  expect((await request(app).get('/api/inventory?groupId[]=invalid')).status).toBe(400);
});

test('group names are unique after trimming, whitespace normalization and case folding; creation retries do not duplicate them', async () => {
  const payload = { name: '  Toys   and books  ', kind: 'supplies', requestId: randomUUID() };
  const first = await request(app).post('/api/inventory/groups').send(payload);
  expect(first.status).toBe(201);
  expect(first.body.data.name).toBe('Toys and books');
  const retry = await request(app).post('/api/inventory/groups').send(payload);
  expect(retry.status).toBe(201);
  expect(retry.body.data).toMatchObject({ id: first.body.data.id, replayed: true });
  const conflict = await request(app).post('/api/inventory/groups').send({ ...payload, name: 'TOYS AND BOOKS', requestId: randomUUID() });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.fields.name).toBeDefined();
  expect((await request(app).post('/api/inventory/groups').send({ ...payload, kind: 'food' })).status).toBe(409);
  expect((await request(app).get('/api/inventory/groups')).body.items).toHaveLength(1);
});

test('a food group is required for ingredient-linked stock and ordinary supplies never need ingredient data', async () => {
  const supplies = await group();
  const food = await group({ name: 'Kitchen ingredients', kind: 'food' });
  const ingredient = (await request(app).post('/api/ingredients').send({ name: 'Oats for group test', unit: 'lb' })).body.data;
  const paper = await stock(supplies.id);
  expect(paper.ingredientId).toBeNull();
  const payload = { groupId: supplies.id, name: 'Oats', location: 'Pantry', unit: 'lb', ingredientId: ingredient.id,
    openingQuantity: '2', reason: 'Counted bag', requestId: randomUUID() };
  expect((await request(app).post('/api/inventory').send(payload)).status).toBe(409);
  const oats = await stock(food.id, { unit: 'lb', ingredientId: ingredient.id });
  const moved = await request(app).put('/api/inventory/' + oats.id).send({ groupId: supplies.id, version: oats.version,
    reason: 'Wrong group', requestId: randomUUID() });
  expect(moved.status).toBe(409);
  expect((await request(app).get('/api/inventory/' + oats.id)).body.data.groupId).toBe(food.id);
});

test('moving an item between groups preserves stock and records the previous group in history', async () => {
  const materials = await group();
  const decorations = await group({ name: 'Decorations' });
  const paper = await stock(materials.id);
  const before = (await request(app).get('/api/inventory/' + paper.id + '/movements')).body;
  const response = await request(app).put('/api/inventory/' + paper.id).send({ groupId: decorations.id, version: paper.version,
    reason: 'These supplies belong with decorations', requestId: randomUUID() });
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ id: paper.id, groupId: decorations.id, quantity: '2', version: 2 });
  const history = (await request(app).get('/api/inventory/' + paper.id + '/movements')).body;
  expect(history.items).toHaveLength(2);
  expect(history.items[0]).toMatchObject({ type: 'details', delta: '0', before: { groupId: materials.id, category: materials.name },
    after: { groupId: decorations.id, category: decorations.name } });
  expect(history.items[1]).toEqual(before.items[0]);
  const overview = (await request(app).get('/api/inventory/groups')).body.items;
  expect(overview.find((item) => item.id === materials.id).summary.total).toBe(0);
  expect(overview.find((item) => item.id === decorations.id).summary.total).toBe(1);
});

test('group validation, permissions and audit rollback protect group creation', async () => {
  expect((await anonymous(app).get('/api/inventory/groups')).status).toBe(401);
  for (const values of [{ name: '' }, { name: 'x'.repeat(81) }, { kind: 'meal' }, { description: 'x'.repeat(241) }, { actorId: 'spoof' }]) {
    expect((await request(app).post('/api/inventory/groups').send({ name: 'New group', requestId: randomUUID(), ...values })).status).toBe(400);
  }
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await request(app).post('/api/inventory/groups').send({ name: 'Rollback group', requestId: randomUUID() })).status).toBe(500);
  } finally { audit.mockRestore(); log.mockRestore(); }
  expect((await request(app).get('/api/inventory/groups')).body.items).toHaveLength(0);
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  const created = await group();
  expect(await db.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'inventory.group.create', entityId: created.id })]));
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await request(app).get('/api/inventory/groups')).status).toBe(200);
  expect((await request(app).post('/api/inventory/groups').send({ name: 'Not allowed', requestId: randomUUID() })).status).toBe(403);
});
