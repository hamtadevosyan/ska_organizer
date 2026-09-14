const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const initial = require('../database/migrations/001-persistent-meals');
const rooms = require('../database/migrations/005-rooms-and-classes');
const children = require('../database/migrations/006-child-enrollment');
const attendance = require('../database/migrations/007-daily-attendance');

test('migration preserves duplicate and invalid legacy visits and installs database constraints', async () => {
  const { connection: sequelize, schema: current } = context();
  const schema = current + '_attendance';
  await sequelize.createSchema(schema);
  try {
    await sequelize.transaction(async (transaction) => {
      const options = { sequelize, schema, transaction, DataTypes };
      await initial.up(options);
      const qi = sequelize.getQueryInterface();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await qi.bulkInsert({ tableName: 'Children', schema }, [
        { id: 'duplicate-child', firstName: 'Duplicate', lastName: 'Fixture', createdAt, updatedAt: createdAt },
        { id: 'single-child', firstName: 'Single', lastName: 'Fixture', createdAt, updatedAt: createdAt },
      ], { transaction });
      await qi.bulkInsert({ tableName: 'Attendances', schema }, [
        { id: 'open-one', childId: 'duplicate-child', roomId: 'legacy-room', checkIn: createdAt, checkOut: null },
        { id: 'open-two', childId: 'duplicate-child', roomId: 'legacy-room', checkIn: createdAt, checkOut: null },
        { id: 'missing-time', childId: 'duplicate-child', roomId: 'legacy-room', checkIn: null, checkOut: null },
        { id: 'reversed-time', childId: 'duplicate-child', roomId: 'legacy-room', checkIn: createdAt, checkOut: new Date('2025-12-31T23:00:00Z') },
        { id: 'valid-open', childId: 'single-child', roomId: 'legacy-room', checkIn: createdAt, checkOut: null },
      ], { transaction });
      await rooms.up(options); await children.up(options); await attendance.up(options);
    });
    const table = '"' + schema + '"."Attendances"';
    const [records] = await sequelize.query('SELECT * FROM ' + table + ' ORDER BY "id"');
    expect(records).toHaveLength(5);
    expect(records.filter((record) => record.needsReview).map((record) => record.id)).toEqual(['missing-time', 'open-one', 'open-two', 'reversed-time']);
    expect(records.filter((record) => record.checkOut === null)).toHaveLength(4);
    expect(records.find((record) => record.id === 'reversed-time').checkOut.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    // Bypass the API and its lock: the database itself still refuses a second valid open visit.
    await expect(sequelize.query('INSERT INTO ' + table + ' ("id", "childId", "roomId", "checkIn") VALUES (\'duplicate-new\', \'single-child\', \'legacy-room\', NOW())'))
      .rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await expect(sequelize.query('INSERT INTO ' + table + ' ("id", "childId", "roomId", "checkIn", "checkOut") VALUES (\'invalid-new\', \'single-child\', \'legacy-room\', NOW(), NOW() - INTERVAL \'1 hour\')'))
      .rejects.toMatchObject({ parent: { code: '23514' } });
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});

test('arrivals, corrections, immutable original values and daily counts survive reconnecting', async () => {
  const room = await db.createRoom({ name: 'Persistent attendance room', ageMinMonths: 18, ageMaxMonths: 72, capacity: 20 });
  const child = await db.createChild({ firstName: 'Persistent', lastName: 'Attendance', roomId: room.id, active: true });
  const arrival = await request(app).post('/api/attendance/checkin').send({ childId: child.id, roomId: room.id, requestId: 'persistent-arrival-12345' });
  expect(arrival.status).toBe(201);
  const original = arrival.body;
  const correctedTime = new Date(Date.parse(original.checkIn) - 60000).toISOString();
  const corrected = await request(app).put('/api/attendance/' + original.id + '/correction').send({ version: 1, checkIn: correctedTime, reason: 'Recorded one minute after arrival.' });
  expect(corrected.status).toBe(200);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  const loaded = await request(app).get('/api/attendance/' + original.id);
  expect(loaded.body).toMatchObject({ id: original.id, checkIn: correctedTime, version: 2, checkOut: null });
  const history = await request(app).get('/api/attendance/' + original.id + '/corrections');
  expect(history.body).toEqual([expect.objectContaining({ before: expect.objectContaining({ checkIn: original.checkIn }), after: expect.objectContaining({ checkIn: correctedTime }), reason: 'Recorded one minute after arrival.' })]);
  const roster = await request(app).get('/api/attendance/daily?roomId=' + room.id);
  expect(roster.body).toMatchObject({ presentCount: 1, rows: [expect.objectContaining({ childId: child.id, canCheckIn: false })] });
  const checkout = await request(app).post('/api/attendance/' + original.id + '/checkout').send({ version: 2 });
  expect(checkout.status).toBe(200);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect((await request(app).post('/api/attendance/' + original.id + '/checkout').send({})).body.checkOut).toBe(checkout.body.checkOut);
  await expect(db.deleteAttendance(original.id)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
});
