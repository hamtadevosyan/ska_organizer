const { DataTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

test('activity upgrade preserves older year ranges and saved entries without inventing material amounts', async () => {
  const { connection: sequelize, schema: current } = context();
  const schema = current + '_activities';
  await sequelize.createSchema(schema);
  try {
    await sequelize.transaction(async (transaction) => {
      await require('../database/migrations/001-persistent-meals').up({ sequelize, schema, transaction, DataTypes });
      const qi = sequelize.getQueryInterface(); const now = new Date();
      await qi.bulkInsert({ tableName: 'Activities', schema }, [{ id: 'old-art', name: 'Old art', ageMin: 2, ageMax: 5, roomId: 'old-room', createdAt: now, updatedAt: now }], { transaction });
      await require('../database/migrations/005-rooms-and-classes').up({ sequelize, schema, transaction, DataTypes });
      await qi.bulkInsert({ tableName: 'ScheduleEntries', schema }, [{ id: 'old-entry', roomId: 'old-room', date: '2026-09-14', timeBlock: 'morning', activityId: 'old-art', createdAt: now, updatedAt: now }], { transaction });
      await require('../database/migrations/012-activity-planner').up({ sequelize, schema, transaction, DataTypes });
      await require('../database/migrations/013-full-day-activities').up({ sequelize, schema, transaction, DataTypes });
    });
    const [activities] = await sequelize.query(`SELECT * FROM "${schema}"."Activities"`);
    expect(activities[0]).toMatchObject({ id: 'old-art', ageMin: 2, ageMax: 5, ageMinMonths: 24, ageMaxMonths: 60, durationMinutes: null, materials: [], version: 1 });
    const [entries] = await sequelize.query(`SELECT * FROM "${schema}"."ScheduleEntries"`);
    expect(entries[0]).toMatchObject({ id: 'old-entry', roomId: 'old-room', activityId: 'old-art', startTime: null, endTime: null, timeBlock: 'morning', activitySnapshot: { name: 'Old art', materials: [] } });
    await expect(sequelize.query(`UPDATE "${schema}"."ScheduleEntries" SET "startTime" = '09:00', "endTime" = '08:00', "timeBlock" = NULL`)).rejects.toMatchObject({ original: { code: '23514' } });
    const [weeks] = await sequelize.query(`SELECT * FROM "${schema}"."ScheduleWeeks"`);
    expect(weeks[0]).toMatchObject({ roomId: 'old-room', version: 1 });
    await expect(sequelize.query(`UPDATE "${schema}"."Activities" SET "ageMinMonths" = 0, "ageMaxMonths" = 0`)).rejects.toMatchObject({ original: { code: '23514' } });
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});

test('saved activity snapshots, week versions, retry identifiers and materials survive database reconnection', async () => {
  const { connection, schema } = context();
  const room = await request(app).post('/api/rooms').send({ name: 'Persistent activity room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 });
  expect(room.status).toBe(201);
  const material = await request(app).post('/api/inventory').send({ name: 'Brushes', category: 'Art', location: 'Class', unit: 'count', openingQuantity: '8', reorderThreshold: '0', reason: 'Initial', requestId: randomUUID() });
  expect(material.status).toBe(201);
  const activity = await request(app).post('/api/activity').send({ name: 'Persistent painting', description: 'Make a tree', durationMinutes: 20, ageMinMonths: 24, ageMaxMonths: 72,
    materials: [{ itemId: material.body.data.id, quantity: '12', unit: 'count', reusable: true }] });
  expect(activity.status).toBe(201);
  const payload = { roomId: room.body.data.id, weekStart: '2026-09-14', version: 0, requestId: randomUUID(),
    entries: [{ id: randomUUID(), date: '2026-09-14', startTime: '07:45', endTime: '08:10', activityId: activity.body.data.id }] };
  const saved = await request(app).post('/api/schedule/plan').send(payload); expect(saved.status).toBe(200);
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema });
  const retry = await request(app).post('/api/schedule/plan').send(payload);
  expect(retry.status).toBe(200); expect(retry.body.data).toMatchObject({ version: 1, replayed: true, materials: [{ needed: '12', available: '8', shortage: '4' }] });
  expect((await request(app).put('/api/activity/' + activity.body.data.id).send({ version: 1, name: 'Edited afterward' })).status).toBe(200);
  const reloaded = await request(app).get('/api/schedule/plan').query({ roomId: payload.roomId, weekStart: payload.weekStart });
  expect(reloaded.body.data.entries[0]).toMatchObject({ id: payload.entries[0].id, startTime: '07:45', endTime: '08:10', activity: { name: 'Persistent painting' } });
  expect(Number((await db.getInventoryById(material.body.data.id)).quantity)).toBe(8);
  expect(await db.countInventoryMovements(material.body.data.id)).toBe(1);
});
