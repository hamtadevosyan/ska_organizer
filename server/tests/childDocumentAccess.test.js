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

test('existing administrators always have effective full document access', async () => {
  const admin = fixture.credentials();
  expect(auth.publicAccount({ ...admin.account, documentAccess: 'none' }).documentAccess).toBe('edit');
  expect((await documents(admin, 'get', '/read')).body.access).toBe('edit');
  expect((await documents(admin, 'post', '/write')).status).toBe(200);
});

test('ordinary roster access does not grant document listing or writing', async () => {
  const editor = await actor('editor', undefined);
  expect(editor.account.documentAccess).toBe('none');
  expect((await api(editor, 'get', '/api/children')).status).toBe(200);
  expect((await documents(editor, 'get', '/read')).body.error.code).toBe('DOCUMENT_ACCESS_REQUIRED');
  expect((await documents(editor, 'post', '/write')).status).toBe(403);
  // Middleware ignores an account captured before the fresh session check.
  expect((await documents(editor, 'get', '/stale')).status).toBe(403);
});

test('view permission allows reads only, and read-only role never permits a write', async () => {
  for (const [role, storedAccess] of [['editor', 'view'], ['viewer', 'view'], ['viewer', 'edit']]) {
    const user = await actor(role, storedAccess);
    expect(user.account.documentAccess).toBe('view');
    expect((await documents(user, 'get', '/read')).status).toBe(200);
    expect((await documents(user, 'post', '/write')).status).toBe(403);
  }
});

test('an explicit upload grant revokes prior sessions and takes effect after sign-in', async () => {
  const editor = await actor('editor', 'none');
  const granted = await update(editor.account, { documentAccess: 'edit' });
  expect(granted.status).toBe(200);
  expect(granted.body.data.documentAccess).toBe('edit');
  expect((await api(editor, 'get', '/api/children')).status).toBe(401);
  expect((await documents(editor, 'get', '/read')).status).toBe(401);
  const authorized = await signIn(editor.account.username);
  expect((await documents(authorized, 'post', '/write')).status).toBe(200);
  const audit = await db.listAudit({ limit: 100, offset: 0 });
  expect(audit.filter(event => event.action === 'account.update_access')).toEqual([
    expect.objectContaining({ actorId: fixture.credentials().account.id, entityId: editor.account.id }),
  ]);
});

test('revoking document permission invalidates copied cookies and denies a new session', async () => {
  const editor = await actor('editor', 'edit');
  expect((await update(editor.account, { documentAccess: 'none' })).status).toBe(200);
  expect((await documents(editor, 'get', '/read')).status).toBe(401);
  expect((await documents(editor, 'post', '/write')).status).toBe(401);
  const revoked = await signIn(editor.account.username);
  expect((await documents(revoked, 'get', '/read')).status).toBe(403);
  expect((await api(revoked, 'get', '/api/children')).status).toBe(200);
});

test('invalid permissions and read-only upload grants are rejected before account creation', async () => {
  const token = fixture.credentials().cookie.split('=')[1];
  for (const [role, documentAccess] of [['editor', null], ['editor', 'administrator'], ['viewer', 'edit']]) {
    await expect(auth.createAccount(token, { username: `invalid-${randomUUID().slice(0, 8)}`,
      displayName: 'Synthetic invalid access', role, documentAccess, password: fixture.password })).rejects.toMatchObject({ status: 400 });
  }
  expect(await db.listAccounts()).toHaveLength(1);
  const editor = await actor('editor', 'view');
  const invalid = await update(editor.account, { documentAccess: 'all' });
  expect(invalid.status).toBe(400);
  expect((await documents(editor, 'get', '/read')).status).toBe(200);
});

test('metadata-only account updates preserve document access; read-only demotion downgrades uploads', async () => {
  const editor = await actor('editor', 'edit');
  const preserved = await update(editor.account, { displayName: 'Synthetic renamed operator' });
  expect(preserved.status).toBe(200);
  expect(preserved.body.data.documentAccess).toBe('edit');
  expect((await documents(editor, 'post', '/write')).status).toBe(200);
  const demoted = await update(editor.account, { role: 'viewer' });
  expect(demoted.status).toBe(200);
  expect(demoted.body.data.documentAccess).toBe('view');
  expect((await documents(editor, 'post', '/write')).status).toBe(401);
  const viewer = await signIn(editor.account.username);
  expect((await documents(viewer, 'get', '/read')).status).toBe(200);
  expect((await documents(viewer, 'post', '/write')).status).toBe(403);
});

test('an administrator cannot accidentally remove their own effective document access', async () => {
  const admin = fixture.credentials();
  const response = await update(admin.account, { documentAccess: 'none' });
  expect(response.status).toBe(200);
  expect(response.body.data.documentAccess).toBe('edit');
  expect((await documents(admin, 'post', '/write')).status).toBe(200);
});

test('inherent administrator document access is not copied into a demoted account', async () => {
  const legacyAdmin = await actor('admin', 'none');
  expect(legacyAdmin.account.documentAccess).toBe('edit');
  const renamed = await update(legacyAdmin.account, { displayName: 'Synthetic renamed administrator' });
  expect(renamed.status).toBe(200);
  expect((await db.getAccount(legacyAdmin.account.id)).documentAccess).toBe('none');
  const demoted = await update(legacyAdmin.account, { role: 'editor' });
  expect(demoted.status).toBe(200);
  expect(demoted.body.data.documentAccess).toBe('none');
  const editor = await signIn(legacyAdmin.account.username);
  expect((await documents(editor, 'get', '/read')).status).toBe(403);
  expect((await api(editor, 'get', '/api/children')).status).toBe(200);
});
