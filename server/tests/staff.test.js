const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');

const details = { name: 'Synthetic Teacher', role: 'Teacher', active: true, roomId: null };
async function staff(values = {}) {
  const response = await request(app).post('/api/staff').send({ ...details, ...values });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function room(name = 'Staff room') {
  const response = await request(app).post('/api/rooms').send({ name, ageMinMonths: 24, ageMaxMonths: 60, capacity: 10 });
  expect(response.status).toBe(201);
  return response.body.data;
}
const update = (person, values) => request(app).put('/api/staff/' + person.id).send({ ...values, version: person.version });

test('staff can be created, edited, deactivated and reactivated with stable references and live totals', async () => {
  expect((await request(app).get('/api/dashboard')).body.totalStaff).toBe(0);
  const assigned = await room();
  const created = await staff({ name: '  Synthetic   Teacher  ', roomId: assigned.id });
  expect(created).toMatchObject({ name: 'Synthetic Teacher', active: true, version: 1, room: { id: assigned.id, name: assigned.name } });
  const changed = await update(created, { name: 'Updated Teacher', role: 'Lead teacher' });
  expect(changed.status).toBe(200);
  expect(changed.body.data).toMatchObject({ id: created.id, roomId: assigned.id, name: 'Updated Teacher', role: 'Lead teacher', version: 2 });
  expect((await request(app).get('/api/dashboard')).body.totalStaff).toBe(1);
  const inactive = await update(changed.body.data, { active: false });
  expect(inactive.status).toBe(200);
  expect((await request(app).get('/api/staff')).body).toMatchObject({ items: [], activeTotal: 0, total: 0 });
  const preserved = (await request(app).get('/api/staff?active=false')).body.items[0];
  expect(preserved).toMatchObject({ id: created.id, roomId: assigned.id, active: false, version: 3 });
  expect((await request(app).get('/api/dashboard')).body.totalStaff).toBe(0);
  expect((await update(preserved, { active: true })).status).toBe(200);
  expect((await request(app).get('/api/staff/' + created.id)).body.data).toMatchObject({ id: created.id, active: true, version: 4 });
  expect((await request(app).delete('/api/staff/' + created.id)).status).toBe(404);
  expect(await db.getStaffById(created.id)).not.toBeNull();
});

test('name, status and room filters combine, treat punctuation literally and count beyond one page', async () => {
  const assigned = await room();
  const percent = await staff({ name: 'Synthetic 100%_Teacher', roomId: assigned.id });
  await staff({ name: 'Synthetic 100XXTeacher', roomId: assigned.id });
  const inactive = await staff({ name: 'Synthetic Inactive', active: false, roomId: assigned.id });
  await staff({ name: 'Synthetic Unassigned' });
  for (let index = 0; index < 52; index++) await db.createStaff({ ...details, name: 'Page Person ' + String(index).padStart(2, '0') });
  const filtered = await request(app).get('/api/staff').query({ q: 'TEACHER 100%_', roomId: assigned.id, active: 'all' });
  expect(filtered.status).toBe(200);
  expect(filtered.body.items.map((person) => person.id)).toEqual([percent.id]);
  expect(filtered.body).toMatchObject({ total: 1, activeTotal: 55 });
  expect((await request(app).get('/api/staff').query({ active: 'false', roomId: assigned.id })).body.items.map((person) => person.id)).toEqual([inactive.id]);
  expect((await request(app).get('/api/staff?roomId=unassigned')).body.total).toBe(53);
  const first = (await request(app).get('/api/staff')).body;
  const second = (await request(app).get('/api/staff?page=2')).body;
  expect(first).toMatchObject({ total: 55, activeTotal: 55, page: 1, pageSize: 50 });
  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(5);
  expect(new Set([...first.items, ...second.items].map((person) => person.id)).size).toBe(55);
  expect((await request(app).get('/api/dashboard')).body.totalStaff).toBe(55);
});

test('invalid settings, unknown fields and invalid filters are rejected without partial writes', async () => {
  const invalid = [{ name: '' }, { name: 'x'.repeat(101) }, { role: '  ' }, { role: 42 },
    { active: 'false' }, { roomId: '' }, { roomId: [] }, { id: 'custom' }, { version: 1 },
    { username: 'login' }, { password: 'not-a-real-password' }, { accountId: 'account' }];
  for (const values of invalid) {
    const response = await request(app).post('/api/staff').send({ ...details, ...values });
    expect(response.status).toBe(400);
    expect(response.body.error.fields).toBeDefined();
  }
  expect((await request(app).post('/api/staff').send([])).status).toBe(400);
  expect((await request(app).post('/api/staff').send({})).status).toBe(400);
  expect(await db.countStaff()).toBe(0);
  for (const query of [{ active: 'yes' }, { active: ['true', 'false'] }, { page: '0' }, { page: '1.5' },
    { pageSize: '101' }, { q: 'x'.repeat(101) }, { roomId: '' }, { unknown: 'value' }]) {
    expect((await request(app).get('/api/staff').query(query)).status).toBe(400);
  }
  expect((await request(app).get('/api/staff/missing')).status).toBe(404);
  expect((await request(app).put('/api/staff/missing').send({ name: 'Missing', version: 1 })).status).toBe(404);
});

test('archived rooms retain staff references but block new assignments and reactivation into them', async () => {
  const assigned = await room();
  const person = await staff({ roomId: assigned.id });
  expect((await request(app).put('/api/rooms/' + assigned.id).send({ active: false })).status).toBe(200);
  const edited = await update(person, { role: 'Retained assignment' });
  expect(edited.status).toBe(200);
  expect(edited.body.data).toMatchObject({ roomId: assigned.id, room: { id: assigned.id, active: false } });
  const rejected = await request(app).post('/api/staff').send({ ...details, roomId: assigned.id });
  expect(rejected.status).toBe(409);
  expect(rejected.body.error.fields.roomId).toBeDefined();
  const unassigned = await staff();
  expect((await update(unassigned, { roomId: assigned.id })).status).toBe(409);
  const inactive = await update(edited.body.data, { active: false });
  expect(inactive.status).toBe(200);
  expect((await update(inactive.body.data, { active: true })).status).toBe(409);
  expect((await update(inactive.body.data, { active: true, roomId: null })).status).toBe(200);
  expect((await request(app).post('/api/staff').send({ ...details, roomId: 'missing' })).status).toBe(404);
});

test('stale or simultaneous edits cannot overwrite another staff update', async () => {
  const person = await staff();
  const results = await Promise.all(['Lead teacher', 'Assistant teacher'].map((role) => update(person, { role })));
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  expect(results.find((result) => result.status === 409).body.error.code).toBe('STAFF_CONFLICT');
  const saved = await db.getStaffById(person.id);
  expect(saved.version).toBe(2);
  expect((await update(person, { active: false })).status).toBe(409);
  expect((await db.getStaffById(person.id)).active).toBe(true);
  expect((await request(app).put('/api/staff/' + person.id).send({ name: 'Without version' })).status).toBe(400);
});

test('only administrators can change staff; all operational users can read', async () => {
  expect((await anonymous(app).get('/api/staff')).status).toBe(401);
  const person = await staff();
  const { account } = request.credentials();
  for (const role of ['editor', 'viewer']) {
    await db.updateAccount(account.id, { role });
    expect((await request(app).get('/api/staff')).status).toBe(200);
    expect((await request(app).get('/api/staff/' + person.id)).status).toBe(200);
    expect((await request(app).post('/api/staff').send(details)).status).toBe(403);
    expect((await update(person, { active: false })).status).toBe(403);
  }
  expect(await db.countStaff()).toBe(1);
  expect((await db.getStaffById(person.id)).active).toBe(true);
});

test('staff job roles, edits and deactivation never create or change login accounts', async () => {
  const before = await db.listAccounts();
  const person = await staff({ name: before[0].displayName, role: 'admin' });
  expect(person).not.toHaveProperty('accountId');
  expect(person).not.toHaveProperty('passwordHash');
  const edited = await update(person, { name: 'Different staff name', role: 'Principal', active: false });
  expect(edited.status).toBe(200);
  expect((await update(edited.body.data, { username: 'grant-access', role: 'editor' })).status).toBe(400);
  expect(await db.listAccounts()).toEqual(before);
});

test('staff mutations have attributed audits and roll back when the audit fails', async () => {
  const person = await staff();
  expect(await db.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({
    action: 'staff.create', entityId: person.id, actorId: request.credentials().account.id,
  })]));
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { expect((await update(person, { active: false })).status).toBe(500); }
  finally { audit.mockRestore(); log.mockRestore(); }
  expect(await db.getStaffById(person.id)).toMatchObject({ active: true, version: 1 });
  expect((await update(person, { role: 'Lead teacher' })).status).toBe(200);
  expect(await db.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'staff.update', entityId: person.id })]));
});

test('dashboard reports a database failure instead of a fabricated staff count', async () => {
  const count = jest.spyOn(db, 'countStaff').mockRejectedValueOnce(new Error('Synthetic read failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await request(app).get('/api/dashboard');
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('totalStaff');
    expect(response.body.error.message).toBe('Internal server error.');
  } finally { count.mockRestore(); log.mockRestore(); }
});
