jest.setTimeout(30000);
const request = require('supertest');
const { spawnSync } = require('node:child_process');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const config = require('../auth/config');
const fixture = require('./helpers/authenticatedRequest');
const day = 24 * 60 * 60 * 1000;
async function login(rememberMe, username = 'test-admin', password = fixture.password) {
  const data = { username, password };
  if (rememberMe !== undefined) data.rememberMe = rememberMe;
  const response = await request(app).post('/api/auth/login').set('Origin', fixture.origin).send(data).expect(200);
  return { response, cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken };
}
const sessionId = session => auth.digest(session.cookie.split('=')[1]);
const api = (session, path, data) => request(app).post(path).set('Origin', fixture.origin)
  .set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send(data);
const check = session => request(app).get('/api/auth/session').set('Cookie', session.cookie);

test.each([undefined, false, true])('rememberMe=%s applies the selected server and cookie policy', async rememberMe => {
  const session = await login(rememberMe);
  const stored = await db.getSession(sessionId(session));
  const limit = rememberMe ? config.rememberAbsoluteMs : config.absoluteMs;
  expect(stored.remembered).toBe(rememberMe === true);
  expect(new Date(stored.expiresAt) - new Date(stored.createdAt)).toBe(limit);
  expect(session.response.headers['set-cookie'][0]).toContain(`Max-Age=${limit / 1000}`);
  expect(session.response.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Strict/);
  expect(session.response.body).not.toHaveProperty('token');
  expect(session.response.headers['cache-control']).toBe('no-store');
  await check(session).expect(200);
});

test.each(['true', 1, null, {}])('non-boolean rememberMe=%s cannot enable a long session', async rememberMe => {
  const before = await db.getSession(sessionId({ cookie: fixture.credentials().cookie }));
  await request(app).post('/api/auth/login').set('Origin', fixture.origin)
    .send({ username: 'test-admin', password: fixture.password, rememberMe }).expect(400);
  expect(await db.getSession(before.id)).toEqual(before);
});

test('remembered sessions survive ordinary idle time; checks never renew idle time', async () => {
  const ordinary = await login(false);
  const remembered = await login(true);
  for (const session of [ordinary, remembered]) {
    const lastSeenAt = new Date(Date.now() - 31 * 60 * 1000);
    await db.updateSession(sessionId(session), { lastSeenAt });
    await check(session).expect(session === ordinary ? 401 : 200);
    expect(new Date((await db.getSession(sessionId(session))).lastSeenAt)).toEqual(lastSeenAt);
  }
  await request(app).get('/api/meals').set('Cookie', remembered.cookie).expect(200);
  expect(Date.now() - new Date((await db.getSession(sessionId(remembered))).lastSeenAt)).toBeLessThan(5000);
});

test.each(['idle', 'absolute'])('remembered %s expiry is server-enforced even with a replayed cookie', async type => {
  const session = await login(true);
  await db.updateSession(sessionId(session), type === 'idle' ?
    { lastSeenAt: new Date(Date.now() - config.rememberIdleMs - 1000) } :
    { createdAt: new Date(Date.now() - config.rememberAbsoluteMs - 1000), lastSeenAt: new Date() });
  const result = await check(session).expect(401);
  expect(result.body.error.code).toBe('SESSION_EXPIRED');
  expect(result.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
});

test('logout revokes remembered access and clears its persistent cookie', async () => {
  const session = await login(true);
  const result = await api(session, '/api/auth/logout', {}).expect(204);
  expect(result.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
  expect(await db.getSession(sessionId(session))).toBeNull();
  await check(session).expect(401);
});

test('password rotation preserves the chosen policy but invalidates both old session credentials', async () => {
  const session = await login(true);
  const other = await login(true);
  const result = await api(session, '/api/auth/password', {
    currentPassword: fixture.password, password: 'Changed remembered example passphrase 20!',
  }).expect(200);
  expect(result.headers['set-cookie'][0]).toContain(`Max-Age=${config.rememberAbsoluteMs / 1000}`);
  const rotated = { cookie: result.headers['set-cookie'][0].split(';')[0] };
  expect((await db.getSession(sessionId(rotated))).remembered).toBe(true);
  await check(session).expect(401);
  await check(other).expect(401);
  await check(rotated).expect(200);
});

test.each(['disable', 'role', 'reset'])('%s revokes remembered sessions and cannot restore them', async action => {
  const admin = fixture.credentials();
  const created = await fixture(app).post('/api/admin/accounts').send({
    username: 'remember-editor', displayName: 'Remembered Example', role: 'editor', password: 'Temporary remembered passphrase 20!',
  }).expect(201);
  const session = await login(true, 'remember-editor', 'Temporary remembered passphrase 20!');
  const id = created.body.data.id;
  if (action === 'reset') await api({ cookie: admin.cookie, csrf: admin.csrf }, `/api/admin/accounts/${id}/password`, { password: 'Reset remembered example passphrase 20!' }).expect(204);
  else await fixture(app).put(`/api/admin/accounts/${id}`).send({
    displayName: 'Remembered Example', role: action === 'role' ? 'viewer' : 'editor', disabled: action === 'disable',
  }).expect(200);
  await check(session).expect(401);
  expect(await db.getSession(sessionId(session))).toBeNull();
});

test('switching to an unchecked sign-in replaces the old remembered credential with ordinary expiry', async () => {
  const session = await login(true);
  const result = await request(app).post('/api/auth/login').set('Origin', fixture.origin).set('Cookie', session.cookie)
    .send({ username: 'test-admin', password: fixture.password, rememberMe: false }).expect(200);
  expect(result.headers['set-cookie'][0]).toContain(`Max-Age=${config.absoluteMs / 1000}`);
  await check(session).expect(401);
});

test('remembered policy is configurable, production-only cookies remain Secure, and invalid limits fail closed', () => {
  const load = values => spawnSync(process.execPath, ['-e', 'require.cache[require.resolve("./config/environment")] = { exports: {}, loaded: true }; process.stdout.write(JSON.stringify(require("./auth/config")))'], {
    cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', APP_ORIGINS: 'https://app.example.test',
      REMEMBER_SESSION_ABSOLUTE_DAYS: '30', REMEMBER_SESSION_IDLE_DAYS: '7', ...values },
  });
  const valid = load({ REMEMBER_SESSION_ABSOLUTE_DAYS: '14', REMEMBER_SESSION_IDLE_DAYS: '2' });
  expect(valid.status).toBe(0);
  expect(JSON.parse(valid.stdout)).toMatchObject({ rememberAbsoluteMs: 14 * day, rememberIdleMs: 2 * day,
    cookieOptions: { httpOnly: true, secure: true, sameSite: 'strict', path: '/api' } });
  for (const values of [{ REMEMBER_SESSION_ABSOLUTE_DAYS: '0' }, { REMEMBER_SESSION_IDLE_DAYS: '91' },
    { REMEMBER_SESSION_IDLE_DAYS: '1.5' }, { REMEMBER_SESSION_ABSOLUTE_DAYS: '1', REMEMBER_SESSION_IDLE_DAYS: '2' }]) {
    expect(load(values).status).not.toBe(0);
  }
});
