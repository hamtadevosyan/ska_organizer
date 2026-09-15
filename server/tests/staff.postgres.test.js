const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

test('staff migration is repeatable and inactive records, room references and accounts survive reconnection', async () => {
  const { connection, schema } = context();
  const accounts = await db.listAccounts();
  const room = await request(app).post('/api/rooms').send({ name: 'Persistent staff room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 });
  expect(room.status).toBe(201);
  const created = await request(app).post('/api/staff').send({ name: 'Persistent Teacher', role: 'Teacher', roomId: room.body.data.id });
  expect(created.status).toBe(201);
  const person = created.body.data;
  const inactive = await request(app).put('/api/staff/' + person.id).send({ active: false, version: person.version });
  expect(inactive.status).toBe(200);
  expect((await request(app).put('/api/rooms/' + person.roomId).send({ active: false })).status).toBe(200);
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  const loaded = await request(app).get('/api/staff/' + person.id);
  expect(loaded.body.data).toMatchObject({ id: person.id, active: false, role: 'Teacher', version: 2,
    roomId: person.roomId, room: { id: person.roomId, active: false }, createdAt: person.createdAt });
  expect((await request(app).get('/api/dashboard')).body.totalStaff).toBe(0);
  expect(await db.listAccounts()).toEqual(accounts);
  await expect(connection.query('DELETE FROM "' + schema + '"."Rooms" WHERE "id" = :id', { replacements: { id: person.roomId } }))
    .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query('UPDATE "' + schema + '"."StaffMembers" SET "name" = :name WHERE "id" = :id', { replacements: { name: '   ', id: person.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  expect((await db.getStaffById(person.id)).name).toBe('Persistent Teacher');
});
