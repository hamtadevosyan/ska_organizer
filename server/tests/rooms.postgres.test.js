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
  const child = await request(app).post('/api/children').send({ firstName: 'Persistent', lastName: 'Child', dateOfBirth: '2022-01-15', roomId });
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

test('strict room-age migration preserves legacy data, blocks invalid new writes and permits corrections', async () => {
  const { connection: sequelize, schema: current } = context();
  const schema = current + '_ages';
  const strict = require('../database/migrations/015-strict-room-ages');
  await sequelize.createSchema(schema);
  const table = (name) => ({ tableName: name, schema });
  const qualified = (name) => sequelize.getQueryInterface().queryGenerator.quoteTable(table(name));
  const qi = sequelize.getQueryInterface();
  try {
    await sequelize.transaction(async (transaction) => {
      await initial.up({ sequelize, schema, transaction, DataTypes });
      await migration.up({ sequelize, schema, transaction, DataTypes });
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await qi.bulkInsert(table('Rooms'), [
        { id: 'equal-zero', name: 'Legacy zero', ageMinMonths: 0, ageMaxMonths: 0, capacity: 1, active: true, createdAt, updatedAt: createdAt },
        { id: 'equal-24', name: 'Legacy equal', ageMinMonths: 24, ageMaxMonths: 24, capacity: 10, active: false, createdAt, updatedAt: createdAt },
        { id: 'valid', name: 'Valid ages', ageMinMonths: 24, ageMaxMonths: 60, capacity: 10, active: true, createdAt, updatedAt: createdAt },
        { id: 'imported', name: 'Unknown legacy settings', ageMinMonths: null, ageMaxMonths: null, capacity: null, active: false, createdAt, updatedAt: createdAt },
      ], { transaction });
      await qi.bulkInsert(table('Children'), [{ id: 'age-child', firstName: 'Synthetic', roomId: 'equal-zero', createdAt, updatedAt: createdAt }], { transaction });
      await qi.bulkInsert(table('Attendances'), [{ id: 'age-attendance', childId: 'age-child', roomId: 'equal-zero', checkIn: createdAt }], { transaction });
      await qi.bulkInsert(table('Activities'), [{ id: 'age-art', name: 'Synthetic legacy art', roomId: 'equal-zero', createdAt, updatedAt: createdAt }], { transaction });
      await qi.bulkInsert(table('ScheduleEntries'), [{ id: 'age-schedule', roomId: 'equal-zero', activityId: 'age-art', date: '2026-01-05', timeBlock: 'morning', createdAt, updatedAt: createdAt }], { transaction });
    });
    const snapshot = async () => {
      const values = {};
      for (const name of ['Rooms', 'Children', 'Attendances', 'Activities', 'ScheduleEntries']) {
        const [rows] = await sequelize.query(`SELECT * FROM ${qualified(name)} ORDER BY "id"`);
        values[name] = rows;
      }
      return values;
    };
    const before = await snapshot();
    await sequelize.transaction((transaction) => strict.up({ sequelize, schema, transaction }));
    expect(await snapshot()).toEqual(before);
    for (const [minimum, maximum] of [[0, 0], [24, 24], [60, 24]]) {
      await expect(sequelize.query(`INSERT INTO ${qualified('Rooms')} ("id", "name", "ageMinMonths", "ageMaxMonths", "capacity", "active", "createdAt", "updatedAt")
        VALUES ('invalid', 'Invalid', :minimum, :maximum, 1, true, NOW(), NOW())`, { replacements: { minimum, maximum } }))
        .rejects.toMatchObject({ original: { code: '23514' } });
      await expect(sequelize.query(`UPDATE ${qualified('Rooms')} SET "ageMinMonths"=:minimum, "ageMaxMonths"=:maximum WHERE "id"='valid'`, { replacements: { minimum, maximum } }))
        .rejects.toMatchObject({ original: { code: '23514' } });
    }
    expect(await snapshot()).toEqual(before);
    await sequelize.query(`UPDATE ${qualified('Rooms')} SET "ageMaxMonths"=12 WHERE "id"='equal-zero'`);
    await sequelize.query(`UPDATE ${qualified('Rooms')} SET "ageMaxMonths"=60 WHERE "id"='equal-24'`);
    const after = await snapshot();
    expect(after.Rooms.find((room) => room.id === 'equal-zero')).toEqual({ ...before.Rooms.find((room) => room.id === 'equal-zero'), ageMaxMonths: 12 });
    expect(after.Rooms.find((room) => room.id === 'equal-24')).toEqual({ ...before.Rooms.find((room) => room.id === 'equal-24'), ageMaxMonths: 60 });
    for (const name of ['Children', 'Attendances', 'Activities', 'ScheduleEntries']) expect(after[name]).toEqual(before[name]);
    await sequelize.query(`ALTER TABLE ${qualified('Rooms')} VALIDATE CONSTRAINT "room_age_range_strict"`);
    expect(await require('../database/migrate').migrate(sequelize, current)).toEqual([]);
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});
