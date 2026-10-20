const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const staff = require('../services/staffService');
const fixture = require('./helpers/authenticatedRequest');
const request = () => fixture(app);
const token = () => fixture.credentials().cookie.split('=')[1];
const room = name => db.createRoom({ name, active: true, ageMinMonths: 0, ageMaxMonths: 120, capacity: 20 });
const employee = (roomId = null) => staff.create({ name: 'Synthetic employee', role: 'Teacher', roomId });
const input = (changes = {}) => ({ username: 'linked-' + randomUUID().slice(0, 8), displayName: 'Synthetic employee', role: 'teacher', password: fixture.password, ...changes });
async function session(account, remembered = false) {
  const value = randomBytes(32).toString('hex'); const now = new Date();
  await db.createSession({ id: auth.digest(value), accountId: account.id, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 3600000), remembered });
  return value;
}
async function create(person, role = 'teacher') {
  return auth.createAccount(token(), input({ staffMemberId: person.id, role }));
}
test('an explicitly linked Teacher gets the employee class, not job-title-derived permissions', async () => {
  const own = await room('Own'); const person = await employee(own.id);
  const account = await create(person);
  expect(account).toMatchObject({ role: 'teacher', roomId: own.id, staffMemberId: person.id, linkedStaff: { id: person.id, active: true } });
  const readOnlyEmployee = await employee(own.id);
  const viewer = await create(readOnlyEmployee, 'viewer');
  expect(viewer.role).toBe('viewer');
  const viewerToken = await session(viewer);
  expect((await http(app).get('/api/classroom/attendance').set('Cookie', 'skao_session=' + viewerToken)).status).toBe(403);
  await db.updateAccount(account.id, { mustChangePassword: false });
  const teacherToken = await session(account);
  expect((await http(app).get('/api/classroom/attendance').set('Cookie', 'skao_session=' + teacherToken)).status).toBe(200);
  expect((await http(app).get('/api/admin/staff-options').set('Cookie', 'skao_session=' + teacherToken)).status).toBe(403);
});
test('forged classes, missing employees and duplicate employee links are rejected', async () => {
  const own = await room('Own'); const foreign = await room('Foreign'); const person = await employee(own.id);
  await expect(auth.createAccount(token(), input({ staffMemberId: person.id, roomId: foreign.id }))).rejects.toMatchObject({ status: 409 });
  await expect(auth.createAccount(token(), input({ staffMemberId: 'missing' }))).rejects.toMatchObject({ status: 409 });
  const results = await Promise.allSettled([create(person), create(person)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')[0].reason.status).toBe(409);
  expect((await db.listAccounts()).filter(account => account.staffMemberId === person.id)).toHaveLength(1);
});
test('moving staff changes the linked class and revokes ordinary and remembered sessions', async () => {
  const own = await room('Own'); const next = await room('Next'); const person = await employee(own.id); const account = await create(person);
  const tokens = await Promise.all([session(account), session(account, true)]);
  await staff.update(person.id, { roomId: next.id, version: person.version });
  expect(await db.getAccount(account.id)).toMatchObject({ roomId: next.id, staffMemberId: person.id });
  for (const value of tokens) await expect(auth.sessionAccount(value)).rejects.toMatchObject({ status: 401 });
  const signedIn = await auth.login({ username: account.username, password: fixture.password }, '127.1.1.1');
  expect(signedIn.account.roomId).toBe(next.id);
});
test('deactivation disables linked login; reactivation requires an explicit account enable', async () => {
  const person = await employee(); const account = await create(person); const value = await session(account);
  const inactive = await staff.update(person.id, { active: false, version: person.version });
  expect((await db.getAccount(account.id)).disabled).toBe(true);
  await expect(auth.sessionAccount(value)).rejects.toMatchObject({ status: 401 });
  await expect(auth.login({ username: account.username, password: fixture.password }, '127.1.1.1')).rejects.toMatchObject({ status: 401 });
  await expect(auth.updateAccount(token(), account.id, { ...account, disabled: false })).rejects.toMatchObject({ status: 409 });
  await staff.update(person.id, { active: true, version: inactive.version });
  expect((await db.getAccount(account.id)).disabled).toBe(true);
  await auth.updateAccount(token(), account.id, { ...account, disabled: false });
  expect((await auth.login({ username: account.username, password: fixture.password }, '127.1.1.1')).account.staffMemberId).toBe(person.id);
});
test('live authorization fails closed for an inactive employee even with a stale enabled account and session', async () => {
  const person = await employee(); const account = await create(person); const value = await session(account);
  await db.updateStaff(person.id, { active: false });
  await expect(auth.sessionAccount(value)).rejects.toMatchObject({ status: 401 });
  await expect(auth.login({ username: account.username, password: fixture.password }, '127.1.1.1')).rejects.toMatchObject({ status: 401 });
});
test('linking, relinking and unlinking revoke sessions while preserving existing account identity', async () => {
  const own = await room('Own'); const first = await employee(own.id); const second = await employee(own.id);
  const account = await auth.createAccount(token(), input({ roomId: own.id }));
  for (const staffMemberId of [first.id, second.id, null]) {
    const value = await session(account);
    const saved = await auth.updateAccount(token(), account.id, { ...account, disabled: false, staffMemberId });
    expect(saved).toMatchObject({ id: account.id, username: account.username, roomId: own.id, staffMemberId });
    await expect(auth.sessionAccount(value)).rejects.toMatchObject({ status: 401 });
  }
});
test('deactivating the last enabled administrator through Staff is blocked', async () => {
  const person = await employee(); const admin = fixture.credentials().account;
  await auth.updateAccount(token(), admin.id, { ...admin, staffMemberId: person.id, disabled: false });
  await expect(staff.update(person.id, { active: false, version: person.version })).rejects.toMatchObject({ status: 409 });
  expect((await db.getStaffById(person.id)).active).toBe(true);
  const signedIn = await auth.login({ username: admin.username, password: fixture.password }, '127.1.1.1');
  expect((await auth.sessionAccount(signedIn.token)).id).toBe(admin.id);
});
test('staff choices include all employees and minimal linked account summaries, without credentials', async () => {
  for (let i = 0; i < 55; i++) await employee();
  const person = await employee(); const account = await create(person, 'editor');
  const response = await request().get('/api/admin/staff-options');
  expect(response.status).toBe(200); expect(response.body.data).toHaveLength(56);
  const option = response.body.data.find(item => item.id === person.id);
  expect(option).toMatchObject({ account: { id: account.id, role: 'editor', username: account.username } });
  expect(JSON.stringify(response.body)).not.toMatch(/password|csrf|documentAccess|expiresAt/);
  const list = await request().get('/api/admin/accounts');
  expect(list.body.data.find(item => item.id === account.id)).toMatchObject({ staffMemberId: person.id, linkedStaff: { name: person.name } });
});
test('unlinked employee and account names do not silently grant access or change existing assignments', async () => {
  const own = await room('Own'); await employee(own.id);
  const account = await auth.createAccount(token(), input({ role: 'viewer', roomId: null }));
  expect(account).toMatchObject({ role: 'viewer', staffMemberId: null, roomId: null, linkedStaff: null });
});

test('a staff audit failure rolls back the employee change, linked account and session revocation together', async () => {
  const own = await room('Own'); const next = await room('Next'); const person = await employee(own.id); const account = await create(person); const value = await session(account);
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await request().put('/api/staff/' + person.id).send({ roomId: next.id, active: false, version: person.version })).status).toBe(500);
  } finally { audit.mockRestore(); log.mockRestore(); }
  expect(await db.getStaffById(person.id)).toMatchObject({ roomId: own.id, active: true, version: person.version });
  expect(await db.getAccount(account.id)).toMatchObject({ roomId: own.id, disabled: false });
  expect((await auth.sessionAccount(value)).roomId).toBe(own.id);
});
