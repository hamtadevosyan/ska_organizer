const { randomUUID } = require('node:crypto');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

test('copied snapshots and JSONB provenance replay survive reconnection and a changed source without changing inventory', async () => {
  const { schema } = context();
  const source = await request(app).post('/api/rooms').send({ name: 'Persistent source', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 });
  const target = await request(app).post('/api/rooms').send({ name: 'Persistent destination', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 });
  expect(source.status).toBe(201); expect(target.status).toBe(201);
  const stock = await request(app).post('/api/inventory').send({ name: 'Copy brushes', category: 'Art', location: 'Class', unit: 'count',
    openingQuantity: '8', reorderThreshold: '0', reason: 'Initial', requestId: randomUUID() });
  expect(stock.status).toBe(201);
  const activity = await request(app).post('/api/activity').send({ name: 'Original copy painting', description: 'Original saved instructions', durationMinutes: 25,
    ageMinMonths: 18, ageMaxMonths: 72, materials: [{ itemId: stock.body.data.id, quantity: '12', unit: 'count', reusable: true }] });
  expect(activity.status).toBe(201);
  const sourcePayload = { roomId: source.body.data.id, weekStart: '2026-09-14', version: 0, requestId: randomUUID(),
    entries: [{ id: randomUUID(), date: '2026-09-14', startTime: '07:45', endTime: '08:10', activityId: activity.body.data.id }] };
  const original = await request(app).post('/api/schedule/plan').send(sourcePayload); expect(original.status).toBe(200);
  expect((await request(app).put('/api/activity/' + activity.body.data.id).send({ version: 1, name: 'Updated catalog',
    materials: [{ itemId: stock.body.data.id, quantity: '1', unit: 'count', reusable: true }] })).status).toBe(200);
  const copied = { id: randomUUID(), date: '2026-09-21', startTime: '07:45', endTime: '08:10', activityId: activity.body.data.id,
    copyFrom: { roomId: sourcePayload.roomId, weekStart: sourcePayload.weekStart, version: 1, entryId: sourcePayload.entries[0].id } };
  const destinationPayload = { roomId: target.body.data.id, weekStart: '2026-09-21', version: 0, requestId: randomUUID(), entries: [copied] };
  const saved = await request(app).post('/api/schedule/plan').send(destinationPayload); expect(saved.status).toBe(200);
  expect(saved.body.data.entries[0].activity).toEqual(original.body.data.entries[0].activity);
  expect(saved.body.data.materials[0]).toMatchObject({ needed: '12', available: '8', shortage: '4' });
  expect((await request(app).get('/api/schedule/plan').query({ roomId: sourcePayload.roomId, weekStart: sourcePayload.weekStart })).body.data).toEqual(original.body.data);
  const header = await db.getScheduleWeek(destinationPayload.roomId, destinationPayload.weekStart);
  expect(header.request.entries[0].copyFrom).toEqual(copied.copyFrom);
  expect((await request(app).post('/api/schedule/plan').send({ ...sourcePayload, version: 1, requestId: randomUUID(), entries: [] })).status).toBe(200);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema });
  const retry = await request(app).post('/api/schedule/plan').send({ ...destinationPayload, entries: [{ ...copied,
    copyFrom: { entryId: copied.copyFrom.entryId, version: 1, weekStart: sourcePayload.weekStart, roomId: sourcePayload.roomId } }] });
  expect(retry.status).toBe(200); expect(retry.body.data).toEqual({ ...saved.body.data, replayed: true });
  const altered = await request(app).post('/api/schedule/plan').send({ ...destinationPayload, entries: [{ ...copied, copyFrom: { ...copied.copyFrom, version: 2 } }] });
  expect(altered.status).toBe(409);
  expect(Number((await db.getInventoryById(stock.body.data.id)).quantity)).toBe(8);
  expect(await db.countInventoryMovements(stock.body.data.id)).toBe(1);
});
