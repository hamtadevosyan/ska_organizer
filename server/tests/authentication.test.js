jest.setTimeout(30000); // Several real scrypt operations per account-lifecycle test.
const request = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const { verifyPassword } = require('../auth/passwords');
const fixture = require('./helpers/authenticatedRequest');
const admin = () => fixture.credentials();
const origin = fixture.origin;
const tempPassword = 'Temporary example passphrase 20!';
const newPassword = 'Changed example passphrase 20!';
const api = (credentials, method, path, body = {}) => request(app)[method](path).set('Origin', origin)
  .set('Cookie', credentials.cookie).set('X-CSRF-Token', credentials.csrf).set('Content-Type', 'application/json').send(body);
async function login(username, password = tempPassword) {
  const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ username, password });
  expect(response.status).toBe(200);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken, response };
}
async function create(role = 'editor', username = role) {
  const response = await api(admin(), 'post', '/api/admin/accounts', { username, displayName: `Test ${role}`, role, password: tempPassword });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function ready(role = 'editor', username = role) {
  const account = await create(role, username);
  const first = await login(username);
  const changed = await api(first, 'post', '/api/auth/password', { currentPassword: tempPassword, password: newPassword });
  expect(changed.status).toBe(200);
  return { account, cookie: changed.headers['set-cookie'][0].split(';')[0], csrf: changed.body.csrfToken };
}

test('every operational route family rejects direct unauthenticated requests', async () => {
  for (const path of ['/dashboard', '/attendance', '/inventory/items', '/schedule/week', '/activity', '/children',
    '/rooms/room1/present-children', '/menu/generate', '/menu/plans/2026-09-07', '/shelf/final', '/meals', '/ingredients', '/admin/accounts', '/admin/audit']) {
    expect((await request(app).get(`/api${path}`)).status).toBe(401);
  }
  for (const path of ['/meals', '/ingredients', '/shopping/generate', '/shelf/check', '/menu/confirm', '/attendance/checkin', '/activity', '/children']) {
    expect((await request(app).post(`/api${path}`).set('Origin', origin).send({})).status).toBe(401);
  }
  expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok' });
  expect((await request(app).post('/api/auth/register').set('Origin', origin).send({})).status).toBe(401);
});

test('sign-in uses an HttpOnly cookie and exposes neither passwords nor the session credential', async () => {
  const session = await login('test-admin', fixture.password);
  expect(session.response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  expect(session.response.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
  expect(session.response.headers['set-cookie'][0]).toMatch(/Path=\/api/);
  expect(session.response.headers['cache-control']).toBe('no-store');
  const stored = await db.getAccount(admin().account.id);
  expect(stored.passwordHash).toMatch(/^scrypt\$131072\$8\$1\$/);
  expect(await verifyPassword(fixture.password, stored.passwordHash)).toBe(true);
  expect(await db.getSession(session.cookie.split('=')[1])).toBeNull();
  const serialized = JSON.stringify(session.response.body);
  expect(serialized).not.toContain('passwordHash');
  expect(serialized).not.toContain(fixture.password);
  expect(serialized).not.toContain(session.cookie.split('=')[1]);
});

test('trusted origins, JSON and CSRF are required for cookie-authenticated writes', async () => {
  const base = () => request(app).post('/api/meals').set('Cookie', admin().cookie);
  expect((await base().set('Origin', origin).send({})).status).toBe(403);
  expect((await base().set('X-CSRF-Token', admin().csrf).send({})).status).toBe(403);
  expect((await base().set('Origin', 'https://untrusted.example').set('X-CSRF-Token', admin().csrf).send({})).status).toBe(403);
  expect((await base().set('Origin', origin).set('X-CSRF-Token', admin().csrf).type('form').send({ name: 'Example' })).status).toBe(415);
  const preflight = await request(app).options('/api/meals').set('Origin', origin).set('Access-Control-Request-Method', 'POST');
  expect(preflight.headers['access-control-allow-origin']).toBe(origin);
  expect(preflight.headers['access-control-allow-credentials']).toBe('true');
  expect((await request(app).get('/api/meals').set('Origin', 'null').set('Cookie', admin().cookie)).status).toBe(403);
});

test('temporary passwords must be changed and rotation invalidates other sessions', async () => {
  await create();
  const first = await login('editor');
  const other = await login('editor');
  expect((await api(first, 'get', '/api/meals')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  const changed = await api(first, 'post', '/api/auth/password', { currentPassword: tempPassword, password: newPassword });
  expect(changed.status).toBe(200);
  expect(changed.body.account.mustChangePassword).toBe(false);
  expect((await api(other, 'get', '/api/meals')).status).toBe(401);
  expect((await api(first, 'get', '/api/meals')).status).toBe(401);
  expect((await api({ cookie: changed.headers['set-cookie'][0].split(';')[0], csrf: changed.body.csrfToken }, 'get', '/api/meals')).status).toBe(200);
});

test('read-only accounts can view data and calculate drafts but cannot mutate or administer', async () => {
  const viewer = await ready('viewer');
  expect((await api(viewer, 'get', '/api/meals')).status).toBe(200);
  const meal = (await api(admin(), 'post', '/api/meals', { name: 'Viewer breakfast', type: 'breakfast' })).body.data;
  const ingredient = (await api(admin(), 'post', '/api/ingredients', { name: 'Viewer oats', unit: 'g' })).body.data;
  await api(admin(), 'post', `/api/meals/${meal.id}/ingredients`, { ingredientId: ingredient.id, quantity: 30 });
  const preview = await api(viewer, 'post', '/api/shopping/generate', {
    week: [{ day: 'Monday', menu: { breakfast: meal } }], childrenCount: 1, staffCount: 0,
  });
  expect(preview.status).toBe(200);
  expect(preview.body.data.items[0].quantity).toBe(30);
  expect(await db.getConfirmedMenu()).toBeNull();
  for (const [method, path] of [['post','/api/meals'], ['put','/api/menu/plans/2026-09-07'], ['delete','/api/ingredients/missing'],
    ['post','/api/shelf/check'], ['post','/api/attendance/checkin'], ['post','/api/children'], ['post','/api/activity'], ['post','/api/schedule/week']]) {
    expect((await api(viewer, method, path)).status).toBe(403);
  }
  expect((await api(viewer, 'get', '/api/admin/accounts')).status).toBe(403);
  expect((await api(viewer, 'get', '/api/admin/audit')).status).toBe(403);
});

test('editors can change operational data but only administrators can grant access', async () => {
  const editor = await ready();
  expect((await api(editor, 'post', '/api/meals', { name: 'Oatmeal', type: 'breakfast' })).status).toBe(201);
  expect((await api(editor, 'post', '/api/admin/accounts', { username: 'outsider', role: 'admin' })).status).toBe(403);
  expect((await api(editor, 'put', `/api/admin/accounts/${editor.account.id}`, { role: 'admin' })).status).toBe(403);
});

test('disabling an account revokes sessions and prevents signing in until explicitly re-enabled', async () => {
  const editor = await ready();
  const values = { displayName: editor.account.displayName, role: 'editor', disabled: true };
  expect((await api(admin(), 'put', `/api/admin/accounts/${editor.account.id}`, values)).status).toBe(200);
  expect((await api(editor, 'get', '/api/meals')).status).toBe(401);
  const denied = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'editor', password: newPassword });
  expect(denied.status).toBe(401);
  expect(denied.body.error.message).toBe('Username or password is incorrect.');
  expect((await api(admin(), 'put', `/api/admin/accounts/${editor.account.id}`, { ...values, disabled: false })).status).toBe(200);
  expect((await api(editor, 'get', '/api/meals')).status).toBe(401);
  await login('editor', newPassword);
});

test('administrator password resets revoke sessions and require another password change', async () => {
  const editor = await ready();
  expect((await api(admin(), 'post', `/api/admin/accounts/${editor.account.id}/password`, { password: tempPassword })).status).toBe(204);
  expect((await api(editor, 'get', '/api/meals')).status).toBe(401);
  expect((await login('editor')).response.body.account.mustChangePassword).toBe(true);
  const list = await api(admin(), 'get', '/api/admin/accounts');
  expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|Temporary example|Changed example/);
});

test('changing a role revokes existing sessions and administrators cannot remove their own access', async () => {
  const editor = await ready();
  expect((await api(admin(), 'put', `/api/admin/accounts/${editor.account.id}`, { displayName: 'Viewer now', role: 'viewer', disabled: false })).status).toBe(200);
  expect((await api(editor, 'post', '/api/meals', { name: 'Forbidden', type: 'breakfast' })).status).toBe(401);
  expect((await api(admin(), 'put', `/api/admin/accounts/${admin().account.id}`, { displayName: 'Admin', role: 'viewer', disabled: false })).status).toBe(409);
  expect((await api(admin(), 'put', `/api/admin/accounts/${admin().account.id}`, { displayName: 'Admin', role: 'admin', disabled: true })).status).toBe(409);
});

test('sign-out invalidates a copied cookie on the server', async () => {
  expect((await api(admin(), 'post', '/api/auth/logout')).status).toBe(204);
  expect((await api(admin(), 'get', '/api/meals')).status).toBe(401);
});

test.each(['expiresAt', 'lastSeenAt'])('%s expiry rejects the session, and session checks do not extend idle time', async (field) => {
  const id = auth.digest(admin().cookie.split('=')[1]);
  const original = await db.getSession(id);
  await api(admin(), 'get', '/api/auth/session');
  expect((await db.getSession(id)).lastSeenAt).toEqual(original.lastSeenAt);
  await db.updateSession(id, { [field]: new Date(Date.now() - 9 * 60 * 60 * 1000) });
  const response = await api(admin(), 'get', '/api/meals');
  expect(response.status).toBe(401);
  expect(response.body.error.code).toBe('SESSION_EXPIRED');
  expect(response.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
});

test('failed sign-ins are limited per account without disclosing account existence', async () => {
  for (let i = 0; i < 5; i++) {
    const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'test-admin', password: 'wrong example password' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  }
  const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: 'test-admin', password: fixture.password });
  expect(response.status).toBe(429);
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
});

test('successful changes record actor and timestamp without secrets; rejected changes do not produce success records', async () => {
  const created = await api(admin(), 'post', '/api/meals', { name: 'Audit example', type: 'breakfast' });
  expect(created.status).toBe(201);
  await api(admin(), 'post', '/api/meals', { name: '', type: 'invalid' });
  const events = (await api(admin(), 'get', '/api/admin/audit')).body.data;
  const writes = events.filter((event) => event.action === 'meal.create');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ actorId: admin().account.id, actorUsername: 'test-admin', entityId: created.body.data.id });
  expect(Number.isNaN(Date.parse(writes[0].occurredAt))).toBe(false);
  expect(JSON.stringify(events)).not.toMatch(/passwordHash|csrfToken|Synthetic test|skao_session/);
});

test('an audit failure rolls back the operational mutation', async () => {
  const spy = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await api(admin(), 'post', '/api/meals', { name: 'Must roll back', type: 'breakfast' })).status).toBe(500);
    expect(await db.listMeals()).toEqual([]);
  } finally { spy.mockRestore(); log.mockRestore(); }
});

test('bootstrap cannot create additional accounts after initial setup', async () => {
  await expect(auth.bootstrap({ username: 'another-admin', displayName: 'Another', password: tempPassword })).rejects.toMatchObject({ status: 409 });
  expect(await db.listAccounts()).toHaveLength(1);
});

test('a disable that commits while a write waits for the auth lock prevents that write', async () => {
  const editor = await ready();
  let release, entered, writeWaiting;
  const readyLock = new Promise((resolve) => { entered = resolve; });
  const pendingWrite = new Promise((resolve) => { writeWaiting = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const lock = db.withAuthLock(async () => {
    entered(); await gate;
    await db.updateAccount(editor.account.id, { disabled: true });
    await db.revokeSessions(editor.account.id);
  });
  await readyLock;
  const original = db.withAuthLock;
  const spy = jest.spyOn(db, 'withAuthLock').mockImplementation((callback) => { writeWaiting(); return original(callback); });
  let timer;
  try {
    const response = api(editor, 'post', '/api/meals', { name: 'Must not be created', type: 'breakfast' }).then((value) => value);
    await Promise.race([pendingWrite, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The second database connection could not reach the write lock.')), 10000); })]);
    release(); await lock;
    expect((await response).status).toBe(401);
    expect(await db.listMeals()).toEqual([]);
  } finally { clearTimeout(timer); release(); await lock; spy.mockRestore(); }
});
