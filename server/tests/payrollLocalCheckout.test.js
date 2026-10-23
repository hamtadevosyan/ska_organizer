const { randomBytes, randomUUID } = require('node:crypto');
const http = require('supertest');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const service = require('../services/payrollService');
const vault = require('../services/payrollVault');
const fixture = require('./helpers/authenticatedRequest');
const app = require('../index');

let key;
beforeAll(() => { key = require('./helpers/payrollKey').install(); });
afterAll(() => key.cleanup());
afterEach(() => jest.useRealTimers());

function freeze(instant) {
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'] });
  jest.setSystemTime(new Date(instant));
}
async function token(account) {
  const value = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(value), accountId: account.id, remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 30 * 86400000) });
  return value;
}
async function clock(context, action, instant) {
  jest.setSystemTime(new Date(instant));
  const own = (await service.clockStatus(context.admin)).staff.find(row => row.id === context.staff.id);
  await service.managerClock(context.admin, context.staff.id, { action, version: own.version, requestId: randomUUID() });
}
async function setup(start = '2026-10-19T15:00:00Z', now = '2026-10-20T01:00:00Z') {
  freeze(start);
  const staff = await db.createStaff({ id: randomUUID(), name: 'Synthetic missed-checkout employee', role: 'Teacher', active: true, roomId: null, version: 1 });
  const teacherAccount = await db.createAccount({ id: randomUUID(), username: 'local-checkout-' + randomUUID(), displayName: 'Synthetic teacher', role: 'teacher', staffMemberId: staff.id, disabled: false, mustChangePassword: false, passwordHash: 'not used', roomId: null });
  const context = { staff, admin: await token(fixture.credentials().account), teacher: await token(teacherAccount) };
  await clock(context, 'checkin', start);
  jest.setSystemTime(new Date(now));
  return context;
}
const stored = context => db.getPayrollRecord('ledger:' + context.staff.id);
async function request(context, changes = {}) {
  const row = await stored(context), ledger = vault.open(row), session = ledger.sessions[0];
  return { version: row.version, sessionId: session.id, start: session.start, endLocal: '2026-10-19T17:00', voided: false, reason: 'Administrator verified the missed departure time', ...changes };
}

test('a facility-local missed checkout closes the original session and preserves history and legacy metadata', async () => {
  const context = await setup(), raw = await stored(context), ledger = vault.open(raw);
  ledger.sessions[0].breaks = [{ id: 'historical-paid-entry', start: '2026-10-19T16:00:00.000Z', end: '2026-10-19T16:15:00.000Z', paid: true, actorId: 'historical-actor' }];
  await db.savePayrollRecord({ ...raw, ciphertext: vault.seal(raw, ledger) });
  const before = structuredClone(ledger.sessions[0]), body = await request(context);
  expect((await service.clockStatus(context.admin)).staff.find(row => row.id === context.staff.id).checkedIn).toBe(true);
  await expect(service.correct(context.admin, context.staff.id, body)).resolves.toEqual({ saved: true });
  const after = vault.open(await stored(context)), session = after.sessions[0];
  expect(session).toMatchObject({ id: before.id, start: before.start, end: '2026-10-20T00:00:00.000Z', version: before.version + 1, original: before.original, breaks: before.breaks });
  expect(after.history.at(-1)).toMatchObject({ type: 'correction', before, after: session, reason: body.reason, actorId: fixture.credentials().account.id });
  expect((await service.clockStatus(context.admin)).staff.find(row => row.id === context.staff.id).checkedIn).toBe(false);
});

test('local checkout uses the ledger time zone instead of the current facility setting', async () => {
  const context = await setup('2026-10-19T12:00:00Z', '2026-10-19T23:00:00Z');
  const raw = await stored(context), ledger = vault.open(raw);
  ledger.timeZone = 'America/New_York';
  await db.savePayrollRecord({ ...raw, ciphertext: vault.seal(raw, ledger) });
  const previousZone = process.env.FACILITY_TIME_ZONE;
  process.env.FACILITY_TIME_ZONE = 'America/Los_Angeles';
  try {
    await service.correct(context.admin, context.staff.id, await request(context));
    expect(vault.open(await stored(context)).sessions[0].end).toBe('2026-10-19T21:00:00.000Z');
  } finally {
    if (previousZone === undefined) delete process.env.FACILITY_TIME_ZONE;
    else process.env.FACILITY_TIME_ZONE = previousZone;
  }
});

test('a nonexistent spring-forward local checkout is rejected without writing', async () => {
  const context = await setup('2026-03-08T08:00:00Z', '2026-03-08T15:00:00Z'), before = await stored(context);
  await expect(service.correct(context.admin, context.staff.id, await request(context, { endLocal: '2026-03-08T02:30' }))).rejects.toMatchObject({ status: 400 });
  expect(await stored(context)).toEqual(before);
});

test('a repeated fall-back local checkout requires an explicit occurrence without writing', async () => {
  const context = await setup('2026-11-01T07:00:00Z', '2026-11-01T12:00:00Z'), before = await stored(context);
  await expect(service.correct(context.admin, context.staff.id, await request(context, { endLocal: '2026-11-01T01:30' }))).rejects.toMatchObject({ status: 400 });
  expect(await stored(context)).toEqual(before);
});

test.each([['earlier', '2026-11-01T08:30:00.000Z'], ['later', '2026-11-01T09:30:00.000Z']])('a repeated local checkout preserves the selected %s occurrence', async (endOccurrence, expected) => {
  const context = await setup('2026-11-01T07:00:00Z', '2026-11-01T12:00:00Z');
  await service.correct(context.admin, context.staff.id, await request(context, { endLocal: '2026-11-01T01:30', endOccurrence }));
  expect(vault.open(await stored(context)).sessions[0].end).toBe(expected);
});

test.each([
  ['future checkout', { endLocal: '2026-10-20T17:00' }],
  ['checkout at check-in', { endLocal: '2026-10-19T08:00' }],
  ['checkout before check-in', { endLocal: '2026-10-19T07:59' }],
  ['both local and instant checkout', { end: '2026-10-20T00:00:00Z' }],
  ['numeric local checkout', { endLocal: 123 }],
  ['null local checkout', { endLocal: null }],
  ['invalid wall clock', { endLocal: '2026-10-19T25:00' }],
  ['invalid calendar date', { endLocal: '2026-02-30T17:00' }],
  ['invalid occurrence', { endOccurrence: 'guess' }],
  ['blank correction reason', { reason: '   ' }],
])('invalid %s is rejected without changing the ledger', async (label, changes) => {
  const context = await setup(), before = await stored(context);
  await expect(service.correct(context.admin, context.staff.id, await request(context, changes))).rejects.toMatchObject({ status: 400 });
  expect(await stored(context)).toEqual(before);
});

test('a checkout occurrence cannot accompany only an ISO checkout', async () => {
  const context = await setup(), before = await stored(context), body = await request(context, { end: '2026-10-20T00:00:00Z', endOccurrence: 'earlier' });
  delete body.endLocal;
  await expect(service.correct(context.admin, context.staff.id, body)).rejects.toMatchObject({ status: 400 });
  expect(await stored(context)).toEqual(before);
});

test('a local correction cannot overlap another recorded work session', async () => {
  const context = await setup();
  await clock(context, 'checkout', '2026-10-19T17:00:00Z');
  await clock(context, 'checkin', '2026-10-19T18:00:00Z');
  await clock(context, 'checkout', '2026-10-19T19:00:00Z');
  jest.setSystemTime(new Date('2026-10-19T22:00:00Z'));
  const before = await stored(context);
  await expect(service.correct(context.admin, context.staff.id, await request(context, { endLocal: '2026-10-19T11:30' }))).rejects.toMatchObject({ status: 409 });
  expect(await stored(context)).toEqual(before);
});

test('an audit failure rolls back the local checkout and its correction history', async () => {
  const context = await setup(), before = await stored(context), body = await request(context);
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic checkout-correction audit failure'));
  try { await expect(service.correct(context.admin, context.staff.id, body)).rejects.toThrow('Synthetic checkout-correction audit failure'); }
  finally { audit.mockRestore(); }
  expect(await stored(context)).toEqual(before);
});

test('inline local checkout still requires administrator access and CSRF', async () => {
  const context = await setup(), before = await stored(context), body = await request(context);
  await expect(service.correct(context.teacher, context.staff.id, body)).rejects.toMatchObject({ status: 403 });
  const response = await http(app).post('/api/payroll/staff/' + context.staff.id + '/corrections')
    .set('Cookie', 'skao_session=' + context.admin).set('Origin', fixture.origin).send(body);
  expect(response.status).toBe(403);
  expect(await stored(context)).toEqual(before);
});
