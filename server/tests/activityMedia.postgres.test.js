const { randomUUID } = require('node:crypto');
const { DataTypes } = require('sequelize');
const { PNG } = require('pngjs');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const png = require('../services/activityMediaPng');
const media = require('../services/activityMedia');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

const name = 'Arrange paper shapes', description = 'Place large paper shapes on the table.';
async function preview(changes = {}) {
  const image = new PNG({ width: 4, height: 3 }); image.data.fill(210);
  return db.createActivityMedia({ id: randomUUID(), ownerAccountId: request.credentials().account.id,
    fingerprint: media.fingerprint(name, description), step: 1, caption: description,
    ...png.normalize(PNG.sync.write(image)), claimed: false, createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000), ...changes });
}
test('image migration gives existing activities an empty list and enforces bounded database values', async () => {
  const { connection, schema: main } = context(), schema = main + '_media';
  await connection.createSchema(schema);
  try {
    await connection.transaction(async transaction => {
      const qi = connection.getQueryInterface();
      await qi.createTable({ tableName: 'Accounts', schema }, { id: { type: DataTypes.STRING, primaryKey: true } }, { transaction });
      await qi.createTable({ tableName: 'Activities', schema }, { id: { type: DataTypes.STRING, primaryKey: true }, name: DataTypes.STRING }, { transaction });
      await qi.bulkInsert({ tableName: 'Activities', schema }, [{ id: 'existing', name: 'Existing instructions' }], { transaction });
      await require('../database/migrations/032-activity-media').up({ sequelize: connection, schema, transaction, DataTypes });
    });
    const [rows] = await connection.query(`SELECT * FROM "${schema}"."Activities"`);
    expect(rows).toEqual([{ id: 'existing', name: 'Existing instructions', illustrations: [] }]);
    await expect(connection.query(`UPDATE "${schema}"."Activities" SET "illustrations" = '{}'::jsonb`)).rejects.toMatchObject({ original: { code: '23514' } });
    await expect(connection.query(`UPDATE "${schema}"."Activities" SET "illustrations" = '[{},{},{},{},{},{},{}]'::jsonb`)).rejects.toMatchObject({ original: { code: '23514' } });
  } finally { await connection.dropSchema(schema, { cascade: true }); }
  await expect(preview({ width: 1025 })).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(preview({ byteLength: 0 })).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(preview({ step: 7 })).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(preview({ ownerAccountId: randomUUID() })).rejects.toMatchObject({ original: { code: '23503' } });
});

test('saved illustrations and original PNG bytes survive reconnect, catalog changes and saved-plan retention', async () => {
  const { schema } = context();
  const file = await preview(), bytes = Buffer.from((await db.getActivityMediaContent(file.id)).content);
  expect(file).not.toHaveProperty('content');
  const created = await request(app).post('/api/activity').send({ name, description, durationMinutes: 20, illustrations: [{ id: file.id }] });
  expect(created.status).toBe(201);
  const dto = { id: file.id, step: 1, caption: description, width: 4, height: 3 };
  expect(created.body.data.illustrations).toEqual([dto]);
  const room = await db.createRoom({ name: 'Image class', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, active: true });
  const plan = { roomId: room.id, weekStart: '2026-11-02', version: 0, requestId: randomUUID(),
    entries: [{ id: randomUUID(), date: '2026-11-02', startTime: '09:00', endTime: '09:20', activityId: created.body.data.id }] };
  expect((await request(app).post('/api/schedule/plan').send(plan)).status).toBe(200);
  const edited = await request(app).put('/api/activity/' + created.body.data.id).send({ version: 1, name: 'Changed activity', description: 'New instructions.', illustrations: [] });
  expect(edited.status).toBe(200);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema });
  expect((await db.getActivityMedia(file.id)).claimed).toBe(true);
  expect((await db.getActivityMediaContent(file.id)).content).toEqual(bytes);
  expect((await db.getActivityById(created.body.data.id)).illustrations).toEqual([]);
  const saved = await request(app).get('/api/schedule/plan').query({ roomId: room.id, weekStart: plan.weekStart });
  expect(saved.body.data.entries[0].activity.illustrations).toEqual([dto]);
  expect(await db.activityMediaInRoom(file.id, room.id)).toBe(true);
  expect(await db.activityMediaInRoom(file.id, randomUUID())).toBe(false);
  expect(await db.activityMediaAttached(file.id)).toBe(true);
  await db.deleteExpiredActivityMedia(new Date(Date.now() + 2 * 86400000));
  expect((await db.getActivityMediaContent(file.id)).content).toEqual(bytes);
  const response = await request(app).get('/api/activity-ai/images/' + file.id);
  expect(response.status).toBe(200); expect(response.body).toEqual(bytes);
});

test('expiry deletes only never-attached previews and metadata reads omit every PNG byte', async () => {
  const neverAttached = await preview({ expiresAt: new Date(Date.now() - 1000) });
  const attached = await preview({ expiresAt: new Date(Date.now() - 1000), claimed: true });
  expect(await db.activityMediaUsage(request.credentials().account.id)).toEqual({ count: 1, bytes: neverAttached.byteLength });
  expect(await db.getActivityMedia(attached.id)).not.toHaveProperty('content');
  expect(await db.deleteExpiredActivityMedia(new Date())).toBe(1);
  expect(await db.getActivityMedia(neverAttached.id)).toBeNull();
  expect((await db.getActivityMedia(attached.id)).id).toBe(attached.id);
});
