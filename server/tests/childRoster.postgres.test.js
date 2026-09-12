const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const initial = require('../database/migrations/001-persistent-meals');
const rooms = require('../database/migrations/005-rooms-and-classes');
const enrollment = require('../database/migrations/006-child-enrollment');

test('enrollment migration preserves legacy IDs, missing birth dates and attendance', async () => {
  const { connection: sequelize, schema: current } = context();
  const schema = current + '_children';
  await sequelize.createSchema(schema);
  try {
    await sequelize.transaction(async (transaction) => {
      await initial.up({ sequelize, schema, transaction, DataTypes });
      const qi = sequelize.getQueryInterface();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await qi.bulkInsert({ tableName: 'Children', schema }, [{ id: 'legacy-child', firstName: 'Legacy', lastName: 'Child', createdAt, updatedAt: createdAt }], { transaction });
      await qi.bulkInsert({ tableName: 'Attendances', schema }, [
        { id: 'known-attendance', childId: 'legacy-child', roomId: 'old-room', checkIn: createdAt },
        { id: 'orphan-attendance', childId: 'historical-missing-child', roomId: 'old-room', checkIn: createdAt },
      ], { transaction });
      await rooms.up({ sequelize, schema, transaction, DataTypes });
      await enrollment.up({ sequelize, schema, transaction, DataTypes });
    });
    const [children] = await sequelize.query('SELECT "id", "dateOfBirth", "active" FROM "' + schema + '"."Children"');
    expect(children).toEqual([{ id: 'legacy-child', dateOfBirth: null, active: true }]);
    const [records] = await sequelize.query('SELECT "id", "childId" FROM "' + schema + '"."Attendances" ORDER BY "id"');
    expect(records).toEqual([{ id: 'known-attendance', childId: 'legacy-child' }, { id: 'orphan-attendance', childId: 'historical-missing-child' }]);
    await expect(sequelize.query('DELETE FROM "' + schema + '"."Children" WHERE "id" = \'legacy-child\''))
      .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});

test('inactive profiles and prior attendance survive reconnecting to PostgreSQL', async () => {
  const room = await db.createRoom({ name: 'Persistent roster room', ageMinMonths: 24, ageMaxMonths: 72, capacity: 12 });
  const created = await request(app).post('/api/children').send({ firstName: 'Persistent', lastName: 'Roster', dateOfBirth: '2022-06-15', preferredName: 'Sunny', roomId: room.id, notes: 'Uses a blue cup.' });
  expect(created.status).toBe(201);
  const child = created.body;
  const record = await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-09-01T09:00:00Z' });
  expect((await request(app).put('/api/children/' + child.id + '/enrollment').send({ active: false })).status).toBe(200);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect((await request(app).get('/api/children')).body.total).toBe(0);
  const loaded = await request(app).get('/api/children/' + child.id + '/profile');
  expect(loaded.body.child).toMatchObject({ id: child.id, active: false, roomId: room.id, preferredName: 'Sunny', notes: 'Uses a blue cup.' });
  expect(loaded.body.recentAttendance).toEqual([expect.objectContaining({ id: record.id, childId: child.id, roomId: room.id })]);
  expect((await request(app).get('/api/children?active=false&q=sunny')).body.items[0].id).toBe(child.id);
  await expect(db.deleteChild(child.id)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
});
