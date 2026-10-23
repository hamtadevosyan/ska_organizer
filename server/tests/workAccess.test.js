const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const payroll = require('../services/payrollService');
const classroom = require('../services/classroomService');
const care = require('../services/teacherCareService');
const vault = require('../services/payrollVault');
const fixture = require('./helpers/authenticatedRequest');

const HOUR = 3600000;
const clockRequired = { status: 403, code: 'WORK_CHECK_IN_REQUIRED' };
const clockUnavailable = { status: 503, code: 'WORK_ACCESS_UNAVAILABLE' };
let key;
beforeAll(() => { key = require('./helpers/payrollKey').install(); });
afterAll(() => key.cleanup());
const adminToken = () => fixture.credentials().cookie.split('=')[1];
const room = name => db.createRoom({ name, active: true, ageMinMonths: 0, ageMaxMonths: 120, capacity: 20 });
async function actor(role = 'teacher', { linked = true, roomId = null } = {}) {
  const person = linked ? await db.createStaff({ id: randomUUID(), name: 'Confidential synthetic employee',
    role: 'Teacher', active: true, roomId, version: 1 }) : null;
  const administrator = await db.getAccount(fixture.credentials().account.id);
  const account = await db.createAccount({ id: randomUUID(), username: 'work-gate-' + randomUUID(),
    displayName: 'Synthetic signed-in identity', role, staffMemberId: person?.id || null,
    // Only class accounts store a room; an editor's linked employee may still belong to one.
    roomId: ['teacher', 'viewer'].includes(role) ? roomId : null,
    documentAccess: 'none', passwordHash: administrator.passwordHash, disabled: false, mustChangePassword: false });
  const token = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: account.id, remembered: false,
    createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + HOUR) });
  return { person, account, token };
}
function request(context, method, path, body, { csrf = true } = {}) {
  const value = http(app)[method]('/api' + path).set('Origin', fixture.origin)
    .set('Cookie', 'skao_session=' + context.token);
  if (csrf) value.set('X-CSRF-Token', auth.csrfToken(context.token));
  return body === undefined ? value : value.send(body);
}
function session(start = Date.now() - HOUR, end = null, changes = {}) {
  const value = { id: randomUUID(), start: new Date(start).toISOString(),
    end: end === null ? null : new Date(end).toISOString(), breaks: [], version: 1,
    actorId: fixture.credentials().account.id, voided: false, ...changes };
  value.original = { start: value.start, end: value.end };
  return value;
}
async function ledger(context, sessions, changes = {}) {
  const previous = await db.getPayrollRecord('ledger:' + context.person.id), now = new Date();
  const row = { id: 'ledger:' + context.person.id, staffId: context.person.id, kind: 'ledger',
    version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now };
  const value = { sessions, approvals: {}, history: [], requests: [], timeZone: 'America/Los_Angeles', ...changes };
  await db.savePayrollRecord({ ...row, ciphertext: vault.seal(row, value) });
  return value;
}
async function checkIn(context) {
  const state = (await payroll.clockStatus(adminToken())).staff.find(person => person.id === context.person.id);
  await payroll.managerClock(adminToken(), context.person.id, { action: 'checkin', version: state.version, requestId: randomUUID() });
}
async function checkOut(context) {
  const state = (await payroll.clockStatus(adminToken())).staff.find(person => person.id === context.person.id);
  await payroll.managerClock(adminToken(), context.person.id, { action: 'checkout', version: state.version, requestId: randomUUID() });
}
function expectSafeBlocked(response, expected = clockRequired) {
  expect(response.status).toBe(expected.status);
  expect(response.body).toMatchObject({ error: { code: expected.code } });
  expect(response.body).not.toHaveProperty('data');
  expect(JSON.stringify(response.body)).not.toMatch(/Confidential|ciphertext|PAYROLL_KEY_FILE|SELECT |passwordHash|ledger:/);
}

test.each(['editor', 'teacher', 'viewer'])('a staff-linked %s with no ledger cannot read or modify protected data before checking in', async role => {
  const own = await room('Synthetic assigned class');
  const context = await actor(role, { roomId: own.id });
  await expect(auth.sessionAccount(context.token)).rejects.toMatchObject(clockRequired);
  expectSafeBlocked(await request(context, 'get', role === 'editor' ? '/children' : '/classroom/children'));
  const before = await db.listRooms({ includeArchived: true });
  expectSafeBlocked(await request(context, 'post', '/rooms', { name: 'Blocked room', ageMinMonths: 0, ageMaxMonths: 24, capacity: 10 }));
  expect(await db.listRooms({ includeArchived: true })).toEqual(before);
  const response = await request(context, 'get', '/auth/session');
  expect(response.status).toBe(200);
  expect(response.body.account.workAccess).toEqual({ required: true, checkedIn: false, available: true });
  expect(response.body.account).toMatchObject({ staffMemberId: null, roomId: null, linkedStaff: null, documentAccess: 'none' });
});

test('off-clock sign-in retains only safe account identity and a session without class or employee details', async () => {
  const own = await room('Private assigned room');
  const context = await actor('teacher', { roomId: own.id });
  const response = await http(app).post('/api/auth/login').set('Origin', fixture.origin)
    .send({ username: context.account.username, password: fixture.password });
  expect(response.status).toBe(200);
  expect(response.headers['set-cookie'].join(';')).toMatch(/skao_session=/);
  expect(response.body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.account).toMatchObject({ id: context.account.id, username: context.account.username,
    displayName: context.account.displayName, role: 'teacher', staffMemberId: null, roomId: null, linkedStaff: null,
    documentAccess: 'none', workAccess: { required: true, checkedIn: false, available: true } });
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toContain(context.person.id);
  expect(serialized).not.toContain(context.person.name);
  expect(serialized).not.toContain(own.id);
  expect(serialized).not.toMatch(/passwordHash|ciphertext/);
});

test.each(['teacher', 'viewer'])('a manager check-in restores the %s class scope without granting wider permissions', async role => {
  const own = await room('Own class'), other = await room('Other private class');
  const pupil = await db.createChild({ firstName: 'Own', lastName: 'Child', active: true, roomId: own.id, dateOfBirth: '2023-01-01' });
  const foreign = await db.createChild({ firstName: 'Private foreign', lastName: 'Child', active: true, roomId: other.id, dateOfBirth: '2023-01-01' });
  const context = await actor(role, { roomId: own.id });
  expectSafeBlocked(await request(context, 'get', '/classroom/children'));
  await checkIn(context);
  const response = await request(context, 'get', '/classroom/children');
  expect(response.status).toBe(200);
  expect(response.body.data.items.map(child => child.id)).toEqual([pupil.id]);
  expect(JSON.stringify(response.body)).not.toContain(foreign.id);
  expect((await request(context, 'get', '/children')).status).toBe(403);
  const safeSession = await request(context, 'get', '/auth/session');
  expect(safeSession.body.account).toMatchObject({ roomId: own.id, staffMemberId: context.person.id,
    workAccess: { required: true, checkedIn: true, available: true } });
  expect((await request(context, 'get', '/classroom/attendance')).status).toBe(role === 'teacher' ? 200 : 403);
  expect((await request(context, 'get', '/time-clock')).status).toBe(403);
  expect((await request(context, 'post', '/time-clock', { action: 'checkin', requestId: randomUUID(), version: 0 })).status).toBe(403);
});

test('a checked-in editor can work and the next read and write are blocked immediately after manager checkout', async () => {
  const context = await actor('editor');
  await ledger(context, [session()]);
  expect((await request(context, 'get', '/children')).status).toBe(200);
  const created = await request(context, 'post', '/children', { firstName: 'Editor-created', lastName: 'Child', dateOfBirth: '2023-01-01' });
  expect(created.status).toBe(201);
  await checkOut(context);
  expectSafeBlocked(await request(context, 'get', '/children'));
  expectSafeBlocked(await request(context, 'post', '/children', { firstName: 'After-checkout', lastName: 'Child', dateOfBirth: '2023-01-01' }));
  expect((await db.listChildren({ page: 1, pageSize: 200 })).map(item => item.firstName)).not.toContain('After-checkout');
  expect((await request(context, 'get', '/auth/session')).body.account.workAccess).toEqual({ required: true, checkedIn: false, available: true });
});

test('direct classroom, child-care and manager services cannot reuse a session after checkout', async () => {
  const own = await room('Own class'), teacher = await actor('teacher', { roomId: own.id }), editor = await actor('editor');
  await ledger(teacher, [session()]); await ledger(editor, [session()]);
  expect((await classroom.children(teacher.token)).state).toBe('assigned');
  expect(await payroll.workTime(editor.token)).toHaveProperty('items');
  await checkOut(teacher); await checkOut(editor);
  await expect(classroom.children(teacher.token)).rejects.toMatchObject(clockRequired);
  await expect(care.roster(teacher.token)).rejects.toMatchObject(clockRequired);
  await expect(payroll.workTime(editor.token)).rejects.toMatchObject(clockRequired);
  await expect(auth.sessionAccount(editor.token)).rejects.toMatchObject(clockRequired);
});

test('a write that passed middleware cannot commit after checkout wins the authorization lock', async () => {
  const context = await actor('editor'); await ledger(context, [session()]);
  const state = (await payroll.clockStatus(adminToken())).staff.find(person => person.id === context.person.id);
  let reachedMiddleware, resumeMiddleware, enteredLock, releaseLock;
  const middlewareReached = new Promise(resolve => { reachedMiddleware = resolve; });
  const middlewareResume = new Promise(resolve => { resumeMiddleware = resolve; });
  const lockEntered = new Promise(resolve => { enteredLock = resolve; });
  const lockRelease = new Promise(resolve => { releaseLock = resolve; });
  const original = auth.sessionAccount;
  let employeeChecks = 0;
  const authorization = jest.spyOn(auth, 'sessionAccount').mockImplementation(async (token, options) => {
    const account = await original(token, options);
    if (token === context.token && ++employeeChecks === 2) {
      reachedMiddleware(); await middlewareResume;
    }
    return account;
  });
  try {
    // Pause after both route middleware checks but before audited() obtains
    // its transaction. A concurrent checkout must commit on that same lock
    // before the stale middleware result is allowed to reach the write.
    const write = request(context, 'post', '/children', { firstName: 'Queued after checkout', lastName: 'Child', dateOfBirth: '2023-01-01' }).then(value => value);
    await middlewareReached;
    const blocker = db.withAuthLock(async () => { enteredLock(); await lockRelease; });
    await lockEntered;
    const checkout = payroll.managerClock(adminToken(), context.person.id, { action: 'checkout', version: state.version, requestId: randomUUID() });
    releaseLock(); await blocker; await checkout;
    resumeMiddleware();
    expectSafeBlocked(await write);
    expect(authorization.mock.calls.filter(([token]) => token === context.token).length).toBeGreaterThanOrEqual(3);
    expect((await db.listChildren({ page: 1, pageSize: 200 })).map(child => child.firstName)).not.toContain('Queued after checkout');
  } finally { resumeMiddleware(); releaseLock(); authorization.mockRestore(); }
});

test.each([
  { title: 'a voided open clock', rows: () => [session(Date.now() - HOUR, null, { voided: true })], expected: clockRequired },
  { title: 'overlapping completed clocks', rows: () => [session(Date.now() - 3 * HOUR, Date.now() - HOUR), session(Date.now() - 2 * HOUR, Date.now() - .5 * HOUR)], expected: clockUnavailable },
  { title: 'a future check-in', rows: () => [session(Date.now() + HOUR)], expected: clockUnavailable },
  { title: 'multiple open clocks', rows: () => [session(Date.now() - 2 * HOUR), session(Date.now() - HOUR)], expected: clockUnavailable },
])('$title cannot grant protected access', async ({ rows, expected }) => {
  const context = await actor('editor'); await ledger(context, rows());
  await expect(auth.sessionAccount(context.token)).rejects.toMatchObject(expected);
  expectSafeBlocked(await request(context, 'get', '/children'), expected);
  const safe = await request(context, 'get', '/auth/session');
  expect(safe.status).toBe(200);
  expect(safe.body.account).toMatchObject({ staffMemberId: null, roomId: null, linkedStaff: null,
    workAccess: { required: true, checkedIn: false, available: expected.status !== 503 } });
});

test('a valid prior-day open clock remains checked in without fabricating a checkout', async () => {
  const context = await actor('editor'); const open = session(Date.now() - 26 * HOUR);
  await ledger(context, [open]);
  const before = await db.getPayrollRecord('ledger:' + context.person.id);
  expect((await auth.sessionAccount(context.token)).workAccess).toEqual({ required: true, checkedIn: true, available: true });
  expect((await request(context, 'get', '/children')).status).toBe(200);
  expect(await db.getPayrollRecord(before.id)).toEqual(before);
  expect(vault.open(before).sessions[0]).toMatchObject({ start: open.start, end: null });
});

test('administrator and unlinked accounts stay usable without a clock encryption key', async () => {
  const administrator = await actor('admin'), editor = await actor('editor', { linked: false });
  const previous = process.env.PAYROLL_KEY_FILE;
  delete process.env.PAYROLL_KEY_FILE;
  try {
    for (const context of [administrator, editor]) {
      expect((await auth.sessionAccount(context.token)).workAccess).toMatchObject({ required: false, available: true });
      expect((await request(context, 'get', '/rooms')).status).toBe(200);
      expect((await request(context, 'get', '/auth/session')).body.account.workAccess).toMatchObject({ required: false, available: true });
    }
  } finally { process.env.PAYROLL_KEY_FILE = previous; }
});

test('an unavailable original encryption key fails protected access closed but keeps safe sign-in and session available', async () => {
  const context = await actor('teacher'); await ledger(context, [session()]);
  const previous = process.env.PAYROLL_KEY_FILE;
  process.env.PAYROLL_KEY_FILE = previous + '-unavailable';
  try {
    await expect(auth.sessionAccount(context.token)).rejects.toMatchObject(clockUnavailable);
    expectSafeBlocked(await request(context, 'get', '/classroom/children'), clockUnavailable);
    const safe = await request(context, 'get', '/auth/session');
    expect(safe.status).toBe(200);
    expect(safe.body.account).toMatchObject({ staffMemberId: null, roomId: null, linkedStaff: null,
      workAccess: { required: true, checkedIn: false, available: false } });
    const login = await http(app).post('/api/auth/login').set('Origin', fixture.origin)
      .send({ username: context.account.username, password: fixture.password });
    expect(login.status).toBe(200);
    expect(login.body.account.workAccess).toEqual({ required: true, checkedIn: false, available: false });
    expect(JSON.stringify(login.body)).not.toContain(previous);
  } finally { process.env.PAYROLL_KEY_FILE = previous; }
});

test('malformed encrypted bytes and invalid decrypted ledger shapes expose only an unavailable clock state', async () => {
  for (const malformed of ['ciphertext', 'metadata']) {
    const context = await actor('editor'); await ledger(context, [session()]);
    const row = await db.getPayrollRecord('ledger:' + context.person.id);
    const ciphertext = malformed === 'ciphertext' ? 'SYNTHETIC PRIVATE CORRUPT CIPHERTEXT'
      : vault.seal(row, { sessions: 'SYNTHETIC PRIVATE INVALID METADATA', timeZone: 'America/Los_Angeles' });
    await db.savePayrollRecord({ ...row, ciphertext });
    await expect(auth.sessionAccount(context.token)).rejects.toMatchObject(clockUnavailable);
    expectSafeBlocked(await request(context, 'get', '/children'), clockUnavailable);
    const safe = await request(context, 'get', '/auth/session');
    expect(safe.status).toBe(200);
    expect(safe.body.account.workAccess).toEqual({ required: true, checkedIn: false, available: false });
    expect(JSON.stringify(safe.body)).not.toMatch(/PRIVATE|METADATA|CIPHERTEXT|ledger:/);
  }
});

test('off-clock and unavailable-clock users can change their password and sign out with valid CSRF only', async () => {
  for (const unavailable of [false, true]) {
    const context = await actor('teacher');
    const previous = process.env.PAYROLL_KEY_FILE;
    if (unavailable) process.env.PAYROLL_KEY_FILE = previous + '-unavailable';
    try {
      const password = 'Synthetic changed passphrase ' + randomUUID() + '!';
      const payload = { currentPassword: fixture.password, password };
      const missingCsrf = await request(context, 'post', '/auth/password', payload, { csrf: false });
      expect(missingCsrf.status).toBe(403);
      expect(missingCsrf.body.error.code).toBe('CSRF_INVALID');
      const changed = await request(context, 'post', '/auth/password', payload);
      expect(changed.status).toBe(200);
      expect(changed.body.account.workAccess).toEqual({ required: true, checkedIn: false, available: !unavailable });
      const cookie = changed.headers['set-cookie'].find(value => value.startsWith('skao_session=')).split(';')[0];
      const next = { ...context, token: cookie.split('=')[1] };
      expect((await request(next, 'get', '/auth/session')).status).toBe(200);
      const logoutWithoutCsrf = await request(next, 'post', '/auth/logout', {}, { csrf: false });
      expect(logoutWithoutCsrf.status).toBe(403);
      expect(logoutWithoutCsrf.body.error.code).toBe('CSRF_INVALID');
      expect((await request(next, 'post', '/auth/logout', {})).status).toBe(204);
      expect((await request(next, 'get', '/auth/session')).status).toBe(401);
    } finally { process.env.PAYROLL_KEY_FILE = previous; }
  }
});
