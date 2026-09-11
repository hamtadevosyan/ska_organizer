const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const initial = require('../database/migrations/001-persistent-meals');
const migration = require('../database/migrations/005-rooms-and-classes');

test('room upgrade preserves legacy references without inventing age ranges or capacities', async () => {
  const { connection: sequelize, schema: current } = context();
  const schema = current + '_rooms';
  await sequelize.createSchema(schema);
  try {
    await sequelize.transaction(async (transaction) => {
      await initial.up({ sequelize, schema, transaction, DataTypes });
      const qi = sequelize.getQueryInterface();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await qi.bulkInsert({ tableName: 'Activities', schema }, [{
        id: 'legacy-activity', name: 'Historical activity', roomId: 'old-room', createdAt, updatedAt: createdAt,
      }], { transaction });
      await qi.bulkInsert({ tableName: 'Attendances', schema }, [{
        id: 'legacy-attendance', childId: 'legacy-child', roomId: 'old-room', checkIn: createdAt,
      }], { transaction });
      // Simulate a table created with the older manual schedule migration.
      await qi.createTable({ tableName: 'ScheduleEntries', schema }, {
        id: { type: DataTypes.STRING, primaryKey: true }, roomId: DataTypes.STRING,
        date: DataTypes.DATEONLY, timeBlock: DataTypes.STRING, activityId: DataTypes.STRING,
        createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE,
      }, { transaction });
      await qi.bulkInsert({ tableName: 'ScheduleEntries', schema }, [{
        id: 'legacy-schedule', roomId: 'other-old-room', date: '2026-01-05', timeBlock: 'morning',
        activityId: 'legacy-activity', createdAt, updatedAt: createdAt,
      }], { transaction });
      await migration.up({ sequelize, schema, transaction, DataTypes });
    });
    const [rooms] = await sequelize.query('SELECT * FROM "' + schema + '"."Rooms" ORDER BY "id"');
    expect(rooms).toHaveLength(2);
    expect(rooms.every((room) => !room.active && room.capacity === null && room.ageMinMonths === null && room.ageMaxMonths === null)).toBe(true);
    const [history] = await sequelize.query('SELECT "roomId" FROM "' + schema + '"."ScheduleEntries"');
    expect(history).toEqual([{ roomId: 'other-old-room' }]);
    const [attendance] = await sequelize.query('SELECT "childId", "roomId" FROM "' + schema + '"."Attendances"');
    expect(attendance).toEqual([{ childId: 'legacy-child', roomId: 'old-room' }]);
    await expect(sequelize.query('DELETE FROM "' + schema + '"."Rooms" WHERE "id" = \'old-room\''))
      .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});

test('rooms, current assignments and archived history survive reconnecting to PostgreSQL', async () => {
  const created = await request(app).post('/api/rooms').send({ name: 'Persistent room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 10 });
  expect(created.status).toBe(201);
  const roomId = created.body.data.id;
  const child = await request(app).post('/api/children').send({ firstName: 'Persistent', lastName: 'Child', roomId });
  expect(child.status).toBe(201);
  expect((await request(app).put('/api/rooms/' + roomId).send({ active: false })).status).toBe(200);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  const loaded = await request(app).get('/api/rooms/' + roomId);
  expect(loaded.body.data).toMatchObject({ id: roomId, active: false, assignedChildCount: 1, capacity: 10 });
  expect((await db.getChildById(child.body.id)).roomId).toBe(roomId);
  expect((await request(app).put('/api/rooms/' + roomId).send({ active: true })).status).toBe(200);
  expect((await request(app).get('/api/rooms')).body.data.map((room) => room.id)).toContain(roomId);
});
