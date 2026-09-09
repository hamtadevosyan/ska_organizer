const request = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const { context } = require('./databaseSetup');
const fixture = require('./helpers/authenticatedRequest');
const auth = require('../auth/service');

test('accounts, sessions, audit events, throttles and revocation survive closing every database connection', async () => {
  const credentials = fixture.credentials();
  const sessionId = auth.digest(credentials.cookie.split('=')[1]);
  await fixture(app).post('/api/meals').send({ name: 'Persistent audit example', type: 'breakfast' }).expect(201);
  await request(app).post('/api/auth/login').set('Origin', fixture.origin).send({ username: 'test-admin', password: 'Synthetic wrong passphrase' }).expect(401);
  const attemptId = auth.digest('login:user:test-admin');
  const account = await db.getAccount(credentials.account.id);
  const session = await db.getSession(sessionId);
  const attempts = await db.getLoginAttempt(attemptId);
  const events = await db.listAudit();
  async function reopen() {
    await db.close();
    await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  }
  await reopen();
  expect(await db.getAccount(account.id)).toEqual(account);
  expect(await db.getSession(sessionId)).toEqual(session);
  expect(await db.getLoginAttempt(attemptId)).toEqual(attempts);
  expect(await db.listAudit()).toEqual(events);
  await fixture(app).get('/api/meals').expect(200);
  await fixture(app).post('/api/auth/logout').send({}).expect(204);
  await reopen();
  await fixture(app).get('/api/meals').expect(401);
  expect(await db.getSession(sessionId)).toBeNull();
});
