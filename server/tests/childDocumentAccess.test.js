const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const { originGuard, requireSession, requireDocumentAccess } = require('../auth/middleware');
const fixture = require('./helpers/authenticatedRequest');
const protectedApp = express();
protectedApp.use(express.json(), originGuard, requireSession);
protectedApp.get('/read', requireDocumentAccess(), (req, res) => res.json({ access: auth.publicAccount(req.account).documentAccess }));
protectedApp.post('/write', requireDocumentAccess(true), (req, res) => res.json({ saved: true }));
protectedApp.get('/stale', (req, res, next) => { req.account = { role: 'admin', mustChangePassword: false }; next(); },
  requireDocumentAccess(), (req, res) => res.json({ visible: true }));
protectedApp.use((error, req, res, next) => res.status(error.status || 500).json({ error: { message: error.message, code: error.code } }));
const api = (credentials, method, path, body = {}) => request(app)[method](path).set('Origin', fixture.origin)
  .set('Cookie', credentials.cookie).set('X-CSRF-Token', credentials.csrf).send(body);
const documents = (credentials, method, path) => request(protectedApp)[method](path).set('Origin', fixture.origin)
  .set('Cookie', credentials.cookie).set('X-CSRF-Token', credentials.csrf).send({});
async function signIn(username) {
  const response = await request(app).post('/api/auth/login').set('Origin', fixture.origin).send({ username, password: fixture.password });
  expect(response.status).toBe(200);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken, account: response.body.account };
}
async function actor(role, access) {
  const administrator = await db.getAccount(fixture.credentials().account.id);
  const account = await db.createAccount({ id: randomUUID(), username: `document-${randomUUID().slice(0, 8)}`,
    displayName: 'Synthetic document operator', passwordHash: administrator.passwordHash, role, documentAccess: access,
    disabled: false, mustChangePassword: false });
  return signIn(account.username);
}
const update = (account, values = {}) => api(fixture.credentials(), 'put', `/api/admin/accounts/${account.id}`, {
  displayName: account.displayName, role: account.role, disabled: false, ...values,
});

test('administrators have full document access without a transferable grant', async () => {
  const admin = fixture.credentials();
  expect(auth.publicAccount({ ...admin.account, documentAccess: 'none' }).documentAccess).toBe('edit');
  expect((await documents(admin, 'get', '/read')).status).toBe(200);
  expect((await documents(admin, 'post', '/write')).status).toBe(200);
});

test.each(['editor', 'viewer'])('%s cannot read or write documents with any legacy stored grant', async role => {
  for (const access of [undefined, 'none', 'view', 'edit']) {
    const user = await actor(role, access);
    expect(user.account.documentAccess).toBe('none');
    expect((await api(user, 'get', '/api/children')).status).toBe(200);
    expect((await documents(user, 'get', '/read')).status).toBe(403);
    expect((await documents(user, 'post', '/write')).status).toBe(403);
    expect((await documents(user, 'get', '/stale')).status).toBe(403);
  }
});

test('account creation and updates cannot grant documentation access to teachers or readers', async () => {
  const token = fixture.credentials().cookie.split('=')[1];
  for (const role of ['editor', 'viewer']) {
    for (const documentAccess of ['view', 'edit']) {
      await expect(auth.createAccount(token, { username: `invalid-${randomUUID().slice(0, 8)}`,
        displayName: 'Synthetic invalid grant', role, documentAccess, password: fixture.password })).rejects.toMatchObject({ status: 400 });
    }
    const user = await actor(role, 'none');
    for (const documentAccess of ['view', 'edit', 'all', null]) expect((await update(user.account, { documentAccess })).status).toBe(400);
    expect((await documents(user, 'get', '/read')).status).toBe(403);
  }
});

test('ordinary account updates clear old grants while keeping operational access', async () => {
  const user = await actor('editor', 'edit');
  const result = await update(user.account, { displayName: 'Synthetic teacher' });
  expect(result.status).toBe(200);
  expect(result.body.data.documentAccess).toBe('none');
  expect((await db.getAccount(user.account.id)).documentAccess).toBe('none');
  expect((await api(user, 'get', '/api/children')).status).toBe(200);
  expect((await documents(user, 'get', '/read')).status).toBe(403);
});

test('administrator demotion revokes copied cookies and removes documentation access after sign-in', async () => {
  const user = await actor('admin', 'edit');
  expect((await documents(user, 'get', '/read')).status).toBe(200);
  const demoted = await update(user.account, { role: 'editor' });
  expect(demoted.status).toBe(200);
  expect(demoted.body.data.documentAccess).toBe('none');
  expect((await documents(user, 'get', '/read')).status).toBe(401);
  const teacher = await signIn(user.account.username);
  expect((await documents(teacher, 'get', '/read')).status).toBe(403);
  expect((await documents(teacher, 'post', '/write')).status).toBe(403);
  expect((await api(teacher, 'get', '/api/children')).status).toBe(200);
});

test('administrators retain inherent access when updating their account', async () => {
  const admin = fixture.credentials();
  const response = await update(admin.account, { documentAccess: 'none' });
  expect(response.status).toBe(200);
  expect(response.body.data.documentAccess).toBe('edit');
  expect((await documents(admin, 'post', '/write')).status).toBe(200);
});
