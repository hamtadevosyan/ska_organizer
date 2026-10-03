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

test('remembered policy survives reconnection and logout stays revoked after another reconnect', async () => {
  const response = await request(app).post('/api/auth/login').set('Origin', fixture.origin)
    .send({ username: 'test-admin', password: fixture.password, rememberMe: true }).expect(200);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const id = auth.digest(cookie.split('=')[1]);
  // Simulate reopening after an ordinary session's idle deadline.
  await db.updateSession(id, { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) });
  const stored = await db.getSession(id);
  expect(stored.remembered).toBe(true);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect(await db.getSession(id)).toEqual(stored);
  await request(app).get('/api/auth/session').set('Cookie', cookie).expect(200);
  await request(app).post('/api/auth/logout').set('Origin', fixture.origin).set('Cookie', cookie)
    .set('X-CSRF-Token', response.body.csrfToken).send({}).expect(204);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  await request(app).get('/api/auth/session').set('Cookie', cookie).expect(401);
});

function checkInNewProcess(token) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').fork(require('node:path').join(__dirname, 'fixtures/rememberedSessionProcess.js'), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DB_SCHEMA: context().schema },
    });
    let message;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('message', value => { message = value; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && message) resolve(message);
      else reject(new Error('Remembered-session restart fixture failed or timed out.'));
    });
    child.send({ token });
  });
}

test('a new Node process accepts the remembered credential and a later process rejects its revoked credential', async () => {
  const response = await request(app).post('/api/auth/login').set('Origin', fixture.origin)
    .send({ username: 'test-admin', password: fixture.password, rememberMe: true }).expect(200);
  const token = response.headers['set-cookie'][0].split(';')[0].split('=')[1];
  expect(await checkInNewProcess(token)).toEqual({ accountId: fixture.credentials().account.id });
  await request(app).post('/api/auth/logout').set('Origin', fixture.origin).set('Cookie', `skao_session=${token}`)
    .set('X-CSRF-Token', response.body.csrfToken).send({}).expect(204);
  expect(await checkInNewProcess(token)).toEqual({ rejected: true });
});

test('migration 014 preserves an existing account and ordinary session without opting it in', async () => {
  const { connection: sequelize, schema: current } = context();
  const schema = current + '_remember';
  const { DataTypes } = require('sequelize');
  await sequelize.createSchema(schema);
  try {
    await sequelize.transaction(async transaction => {
      await require('../database/migrations/004-accounts-and-sessions').up({ sequelize, schema, transaction, DataTypes });
      const q = sequelize.getQueryInterface();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await q.bulkInsert({ tableName: 'Accounts', schema }, [{ id: 'legacy-account', username: 'legacy-user',
        displayName: 'Synthetic Existing Account', passwordHash: 'synthetic-not-used', role: 'viewer',
        disabled: false, mustChangePassword: false, createdAt, updatedAt: createdAt }], { transaction });
      await q.bulkInsert({ tableName: 'Sessions', schema }, [{ id: 'legacy-session-digest', accountId: 'legacy-account',
        createdAt, lastSeenAt: createdAt, expiresAt: new Date(createdAt.getTime() + 8 * 3600000) }], { transaction });
      await require('../database/migrations/014-remembered-sessions').up({ sequelize, schema, transaction, DataTypes });
    });
    const [sessions] = await sequelize.query(`SELECT * FROM "${schema}"."Sessions"`);
    expect(sessions).toEqual([{ id: 'legacy-session-digest', accountId: 'legacy-account', remembered: false,
      createdAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T08:00:00Z') }]);
    const [accounts] = await sequelize.query(`SELECT "username", "role" FROM "${schema}"."Accounts"`);
    expect(accounts).toEqual([{ username: 'legacy-user', role: 'viewer' }]);
    expect(await require('../database/migrate').migrate(sequelize, current)).toEqual([]);
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});
