const { randomUUID } = require('node:crypto');
const { context } = require('./databaseSetup');
const request = require('./helpers/authenticatedRequest');
const db = require('../services/dbAdapter');
const app = require('../index');

test('native PostgreSQL generation uses historical room activity dates without writes and explicitly saved suggestions survive reconnecting', async () => {
  const { connection, schema } = context();
  const target = await request(app).post('/api/rooms').send({ name: 'Native generator room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 });
  expect(target.status).toBe(201); const roomId = target.body.data.id;
  const stock = await request(app).post('/api/inventory').send({ name: 'Paint paper', category: 'Art', location: 'Class', unit: 'count',
    openingQuantity: '10', reorderThreshold: '0', reason: 'Initial count', requestId: randomUUID() });
  expect(stock.status).toBe(201); const itemId = stock.body.data.id;
  const create = async (name) => {
    const response = await request(app).post('/api/activity').send({ name, durationMinutes: 20, ageMinMonths: 18, ageMaxMonths: 72,
      materials: [{ itemId, quantity: '3', unit: 'count', reusable: false }] });
    expect(response.status).toBe(201); return response.body.data;
  };
  const recent = await create('A recent'); const older = await create('B older'); const unseen = await create('C unseen');
  for (const [value, weekStart] of [[recent, '2026-10-05'], [recent, '2026-09-21'], [older, '2026-09-28']]) {
    const saved = await request(app).post('/api/schedule/plan').send({ roomId, weekStart, version: 0, requestId: randomUUID(),
      entries: [{ id: randomUUID(), date: weekStart, startTime: '09:00', endTime: '09:20', activityId: value.id, activityVersion: value.version }] });
    expect(saved.status).toBe(200);
  }
  const before = await db.getInventoryById(itemId); const audits = await db.listAudit({});
  const response = await request(app).post('/api/schedule/plan/generate').send({ roomId, weekStart: '2026-10-12', version: 0, entries: [],
    slots: ['2026-10-12', '2026-10-13', '2026-10-14'].map((date) => ({ id: randomUUID(), date, startTime: '09:00', endTime: '09:30' })) });
  expect(response.status).toBe(200);
  expect(response.body.data.entries.map((entry) => entry.activityId)).toEqual([unseen.id, older.id, recent.id]);
  expect(response.body.data.materials[0]).toMatchObject({ needed: '9', available: '10', shortage: '0' });
  const [rows] = await connection.query(`SELECT count(*)::int AS count FROM "${schema}"."ScheduleEntries" WHERE "roomId" = :roomId AND "date" >= '2026-10-12'`, { replacements: { roomId } });
  expect(rows[0].count).toBe(0);
  expect(await db.getScheduleWeek(roomId, '2026-10-12')).toBeNull();
  expect(await db.getInventoryById(itemId)).toEqual(before); expect(await db.countInventoryMovements(itemId)).toBe(1);
  expect(await db.listAudit({})).toEqual(audits);
  const entries = response.body.data.entries.map(({ activity, ...entry }) => entry);
  const saved = await request(app).post('/api/schedule/plan').send({ roomId, weekStart: '2026-10-12', version: 0, entries, requestId: randomUUID() });
  expect(saved.status).toBe(200);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema });
  const reopened = await request(app).get('/api/schedule/plan').query({ roomId, weekStart: '2026-10-12' });
  expect(reopened.body.data).toEqual(saved.body.data);
  expect(await db.listActivityUseBefore(roomId, '2026-10-19')).toEqual(expect.arrayContaining([
    { activityId: recent.id, lastUsed: '2026-10-14' }, { activityId: older.id, lastUsed: '2026-10-13' }, { activityId: unseen.id, lastUsed: '2026-10-12' },
  ]));
});
