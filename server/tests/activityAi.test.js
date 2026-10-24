const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const service = require('../services/localActivityAi');
const payroll = require('../services/payrollService');
const fixture = require('./helpers/authenticatedRequest');

const payload = { roomId: 'synthetic-room', focus: 'balanced', theme: '', activityCount: 1, durationMinutes: 20 };
const result = { model: 'synthetic-local', generatedAt: '2026-10-23T00:00:00Z', sources: [], warnings: ['Unsourced educational suggestion.'], drafts: [] };
const status = { enabled: false, available: false, model: null, sourceCount: 0, code: 'AI_NOT_CONFIGURED', message: 'Local AI is not set up yet.' };
let draft, probe, key;
beforeAll(() => { key = require('./helpers/payrollKey').install(); });
afterAll(() => key.cleanup());
beforeEach(() => { draft = jest.spyOn(service, 'draft').mockResolvedValue(result); probe = jest.spyOn(service, 'status').mockResolvedValue(status); });
afterEach(() => jest.restoreAllMocks());
async function actor(role, { linked = false } = {}) {
  const administrator = await db.getAccount(fixture.credentials().account.id);
  const person = linked ? await db.createStaff({ id: randomUUID(), name: 'Confidential synthetic employee', role: 'Teacher', active: true, roomId: null, version: 1 }) : null;
  const account = await db.createAccount({ id: randomUUID(), username: 'ai-fixture-' + randomUUID(), displayName: 'Synthetic AI account',
    role, roomId: null, staffMemberId: person?.id || null, passwordHash: administrator.passwordHash, disabled: false, mustChangePassword: false });
  const token = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: account.id, remembered: false,
    createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 3600000) });
  return { account, token, person };
}
async function clock(context, action) {
  const administrator = fixture.credentials().cookie.split('=')[1];
  const staff = (await payroll.clockStatus(administrator)).staff.find(value => value.id === context.person.id);
  await payroll.managerClock(administrator, context.person.id, { action, version: staff.version, requestId: randomUUID() });
}
function request(context, method, path, body, { csrf = true } = {}) {
  const value = http(app)[method]('/api/activity-ai' + path).set('Origin', fixture.origin).set('Cookie', 'skao_session=' + context.token);
  if (csrf) value.set('X-CSRF-Token', auth.csrfToken(context.token));
  return body === undefined ? value : value.send(body);
}

test('administrator can inspect readiness and prepare an ephemeral draft behind ordinary session and CSRF controls', async () => {
  const response = await fixture(app).post('/api/activity-ai/draft').send(payload);
  expect(response.status).toBe(200); expect(response.body.data).toEqual(result);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(draft).toHaveBeenCalledWith(payload, { signal: expect.any(AbortSignal) });
  const ready = await fixture(app).get('/api/activity-ai/status');
  expect(ready.status).toBe(200); expect(ready.body.data).toEqual(status);
});

test('editor can prepare reviewed drafts but teachers and viewers cannot invoke inference or status', async () => {
  const editor = await actor('editor');
  expect((await request(editor, 'post', '/draft', payload)).status).toBe(200);
  for (const role of ['viewer', 'teacher']) {
    const context = await actor(role);
    expect((await request(context, 'post', '/draft', payload)).status).toBe(403);
    expect((await request(context, 'get', '/status')).status).toBe(403);
  }
  expect(draft).toHaveBeenCalledTimes(1); expect(probe).not.toHaveBeenCalled();
});

test('anonymous, missing-CSRF and untrusted-origin requests never reach the model', async () => {
  expect((await http(app).post('/api/activity-ai/draft').set('Origin', fixture.origin).send(payload)).status).toBe(401);
  expect((await request(await actor('editor'), 'post', '/draft', payload, { csrf: false })).status).toBe(403);
  expect((await fixture(app).post('/api/activity-ai/draft').set('Origin', 'https://external.invalid').send(payload)).status).toBe(403);
  expect(draft).not.toHaveBeenCalled();
});

test('role revocation during inference discards the prepared result', async () => {
  const editor = await actor('editor');
  draft.mockImplementation(async () => { await db.updateAccount(editor.account.id, { role: 'viewer' }); return result; });
  const response = await request(editor, 'post', '/draft', payload);
  expect(response.status).toBe(403); expect(response.body).not.toHaveProperty('data');
});

test('session revocation during inference discards the prepared result', async () => {
  const editor = await actor('editor');
  draft.mockImplementation(async () => { await db.revokeSessions(editor.account.id); return result; });
  const response = await request(editor, 'post', '/draft', payload);
  expect(response.status).toBe(401); expect(response.body).not.toHaveProperty('data');
});

test('staff-linked off-clock editor cannot inspect readiness or prepare drafts before checking in', async () => {
  const editor = await actor('editor', { linked: true });
  for (const [method, path, body] of [['get', '/status'], ['post', '/draft', payload]]) {
    const response = await request(editor, method, path, body);
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('WORK_CHECK_IN_REQUIRED'); expect(response.body).not.toHaveProperty('data');
  }
  expect(draft).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
});

test('checkout while inference is pending discards its result using fresh work status', async () => {
  const editor = await actor('editor', { linked: true }); await clock(editor, 'checkin');
  draft.mockImplementation(async () => { await clock(editor, 'checkout'); return result; });
  const response = await request(editor, 'post', '/draft', payload);
  expect(draft).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(403); expect(response.body.error.code).toBe('WORK_CHECK_IN_REQUIRED'); expect(response.body).not.toHaveProperty('data');
});

test('known AI unavailable and busy failures remain specific, bounded and separate from app availability', async () => {
  draft.mockRejectedValueOnce(Object.assign(new Error('Local AI is not set up yet.'), { status: 424, code: 'AI_NOT_CONFIGURED' }));
  const response = await fixture(app).post('/api/activity-ai/draft').send(payload);
  expect(response.status).toBe(424); expect(response.body).toEqual({ error: { code: 'AI_NOT_CONFIGURED', message: 'Local AI is not set up yet.' } });
  draft.mockRejectedValueOnce(Object.assign(new Error('Another activity request is running.'), { status: 429, code: 'AI_BUSY', retryAfter: 5 }));
  const busy = await fixture(app).post('/api/activity-ai/draft').send(payload);
  expect(busy.status).toBe(429); expect(busy.headers['retry-after']).toBe('5');
  expect((await fixture(app).get('/api/rooms')).status).toBe(200);
});
