const express = require('express');
const request = require('supertest');
const { randomBytes } = require('node:crypto');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const config = require('../auth/config');
const { verifyPassword } = require('../auth/passwords');
const fixture = require('./helpers/authenticatedRequest');

const tokenFrom = credentials => credentials.cookie.slice(credentials.cookie.indexOf('=') + 1);
const storedSession = credentials => db.getSession(auth.digest(tokenFrom(credentials)));
afterEach(() => jest.restoreAllMocks());

test('the fixture uses a real password hash and a fresh hashed session with the ordinary lifetime', async () => {
  const credentials = fixture.credentials();
  const token = tokenFrom(credentials);
  const account = await db.getAccount(credentials.account.id);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(account.passwordHash).toMatch(/^scrypt\$131072\$8\$1\$/);
  expect(await verifyPassword(fixture.password, account.passwordHash)).toBe(true);
  expect(await db.getSession(token)).toBeNull();
  const session = await storedSession(credentials);
  expect(session).toMatchObject({ id: auth.digest(token), accountId: account.id, remembered: false });
  expect(new Date(session.lastSeenAt).getTime()).toBe(new Date(session.createdAt).getTime());
  expect(new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime()).toBe(config.absoluteMs);
  expect(credentials.csrf).toBe(auth.csrfToken(token));
}, 30000); // Verify the real password once; resource fixtures no longer repeat it.

test('fixture credentials pass real session validation and still require trusted-origin CSRF for writes', async () => {
  const credentials = fixture.credentials();
  const session = await fixture(app).get('/api/auth/session');
  expect(session.status).toBe(200);
  expect(session.headers['cache-control']).toBe('no-store');
  expect(session.body).toMatchObject({ account: { id: credentials.account.id, role: 'admin' }, csrfToken: credentials.csrf });
  expect(JSON.stringify(session.body)).not.toContain(tokenFrom(credentials));
  expect(JSON.stringify(session.body)).not.toContain(credentials.account.passwordHash);

  const write = () => request(app).post('/api/meals').set('Cookie', credentials.cookie)
    .send({ name: 'Synthetic fixture breakfast', type: 'breakfast' });
  expect((await write().set('Origin', fixture.origin)).status).toBe(403);
  expect((await write().set('Origin', fixture.origin).set('X-CSRF-Token', '0'.repeat(64))).status).toBe(403);
  expect((await write().set('Origin', 'https://untrusted.example').set('X-CSRF-Token', credentials.csrf)).status).toBe(403);
  expect(await db.listMeals()).toEqual([]);
  expect(await db.listAudit()).toEqual([]);

  const allowed = await fixture(app).post('/api/meals').send({ name: 'Synthetic fixture breakfast', type: 'breakfast' });
  expect(allowed.status).toBe(201);
  expect(await db.listAudit({ actions: ['meal.create'] })).toMatchObject([{ actorId: credentials.account.id, entityId: allowed.body.data.id }]);
});

test('seeding a resource fixture invents neither sign-in events nor login-rate attempts', async () => {
  expect(await db.listAudit()).toEqual([]);
  for (const key of ['login:user:test-admin', 'login:ip:127.0.0.1', 'login:ip:::ffff:127.0.0.1', 'login:ip:::1']) {
    expect(await db.getLoginAttempt(auth.digest(key))).toBeNull();
  }
  expect((await fixture(app).get('/api/rooms')).status).toBe(200);
  expect(await db.listAudit()).toEqual([]);
});

test('another explicit initialization creates a new token and validates it through the real HTTP route', async () => {
  const previous = fixture.credentials();
  // Global setup normally resets storage first. Reuse only the existing account
  // here so the second initialization cannot collide with its unique username.
  jest.spyOn(db, 'createAccount').mockResolvedValueOnce(previous.account);
  await fixture.initialize(app);
  const current = fixture.credentials();
  expect(current.cookie).not.toBe(previous.cookie);
  expect(current.csrf).not.toBe(previous.csrf);
  expect(await storedSession(current)).toMatchObject({ accountId: previous.account.id, remembered: false });
  expect((await fixture(app).get('/api/auth/session')).body).toMatchObject({
    account: { id: previous.account.id, role: 'admin' }, csrfToken: current.csrf,
  });
  expect(await db.listAudit()).toEqual([]);
});

test.each(['forged', 'revoked', 'idle-expired', 'absolute-expired', 'disabled'])('%s fixture access is rejected without automatic reauthentication', async kind => {
  const credentials = fixture.credentials();
  const id = auth.digest(tokenFrom(credentials));
  if (kind === 'revoked') await db.deleteSession(id);
  if (kind === 'idle-expired') await db.updateSession(id, { lastSeenAt: new Date(Date.now() - config.idleMs - 1000) });
  if (kind === 'absolute-expired') await db.updateSession(id, { expiresAt: new Date(Date.now() - 1000) });
  if (kind === 'disabled') await db.updateAccount(credentials.account.id, { disabled: true });
  const cookie = kind === 'forged' ? config.cookieName + '=' + randomBytes(32).toString('hex') : credentials.cookie;
  for (const path of ['/api/auth/session', '/api/rooms']) {
    const response = await request(app).get(path).set('Origin', fixture.origin).set('Cookie', cookie);
    expect(response.status).toBe(401);
  }
  expect(fixture.credentials()).toBe(credentials);
  expect(fixture.credentials().cookie).toBe(credentials.cookie);
  expect(await db.getLoginAttempt(auth.digest('login:user:test-admin'))).toBeNull();
  expect(await db.listAudit()).toEqual([]);
});

test('failed account creation clears old fixture credentials before initialization starts', async () => {
  expect(fixture.credentials()).toBeDefined();
  const failure = new Error('Synthetic fixture account creation failure');
  jest.spyOn(db, 'createAccount').mockRejectedValueOnce(failure);
  await expect(fixture.initialize(app)).rejects.toBe(failure);
  expect(fixture.credentials()).toBeUndefined();
  expect(() => fixture(app).get('/api/rooms')).toThrow('Test authentication has not been initialized.');
});

test.each(['status', 'identity', 'role', 'csrf'])('invalid session %s prevents credentials from being published', async fault => {
  const previous = fixture.credentials();
  jest.spyOn(db, 'createAccount').mockResolvedValueOnce(previous.account);
  const validation = express();
  let suppliedToken;
  validation.get('/api/auth/session', (req, res) => {
    suppliedToken = req.get('Cookie').slice(req.get('Cookie').indexOf('=') + 1);
    res.status(fault === 'status' ? 401 : 200).json({
      account: { id: fault === 'identity' ? 'wrong-synthetic-account' : previous.account.id, role: fault === 'role' ? 'viewer' : 'admin' },
      csrfToken: fault === 'csrf' ? 'wrong-synthetic-csrf' : auth.csrfToken(suppliedToken),
      privateMarker: 'Synthetic response details must not be echoed',
    });
  });
  let failure;
  try { await fixture.initialize(validation); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('Test administrator session validation failed before resource tests started.');
  expect(failure.message).not.toContain(suppliedToken);
  expect(failure.message).not.toContain('Synthetic response details');
  expect(fixture.credentials()).toBeUndefined();
  expect(() => fixture(app).get('/api/rooms')).toThrow('Test authentication has not been initialized.');
});
