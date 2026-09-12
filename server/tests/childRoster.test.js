const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const values = { firstName: 'Synthetic', lastName: 'Child', dateOfBirth: '2022-01-15' };
async function create(changes = {}) {
  const result = await request(app).post('/api/children').send({ ...values, ...changes });
  expect(result.status).toBe(201);
  return result.body;
}
async function room(changes = {}) {
  return db.createRoom({ name: 'Roster room', ageMinMonths: 24, ageMaxMonths: 72, capacity: 1, active: true, ...changes });
}

test('child fields are normalized and edits retain the ID and attendance', async () => {
  const originalRoom = await room();
  const child = await create({ firstName: '  Synthetic  ', preferredName: '  Sunny  ', notes: '  Uses a blue cup.  ', roomId: originalRoom.id });
  expect(child).toMatchObject({ firstName: 'Synthetic', preferredName: 'Sunny', notes: 'Uses a blue cup.', active: true });
  const record = await db.createAttendance({ childId: child.id, roomId: originalRoom.id, checkIn: '2026-09-01T09:00:00Z' });
  const updated = await request(app).put('/api/children/' + child.id).send({ lastName: 'Updated', roomId: null });
  expect(updated.status).toBe(200);
  expect(updated.body).toMatchObject({ id: child.id, lastName: 'Updated', roomId: null, dateOfBirth: values.dateOfBirth });
  const profile = await request(app).get('/api/children/' + child.id + '/profile');
  expect(profile.body.child.id).toBe(child.id);
  expect(profile.body.recentAttendance).toEqual([expect.objectContaining({ id: record.id, childId: child.id, roomId: originalRoom.id })]);
});

test.each([
  { firstName: '' }, { firstName: '   ' }, { lastName: '' }, { firstName: 'x'.repeat(101) },
  { preferredName: 'x'.repeat(101) }, { notes: 'x'.repeat(2001) }, { dateOfBirth: null },
  { dateOfBirth: '2023-02-29' }, { dateOfBirth: '2024-02-30' }, { dateOfBirth: '9999-01-01' },
  { dateOfBirth: '2024-01-01T00:00:00Z' }, { dateOfBirth: '01/01/2024' },
  { active: 'false' }, { photoConsent: 'true' }, { confirmDuplicate: 'true' }, { confirmOverCapacity: 1 },
  { roomId: '' }, { id: 'user-supplied-id' }, { createdAt: '2020-01-01' },
])('invalid child fields are rejected without storing a record: %j', async (changes) => {
  const response = await request(app).post('/api/children').send({ ...values, ...changes });
  expect(response.status).toBe(400);
  expect(response.body.error.fields).toBeDefined();
  expect(await db.countChildren()).toBe(0);
});

test('date of birth is required for a new record and a real leap date is accepted', async () => {
  expect((await request(app).post('/api/children').send({ firstName: 'New', lastName: 'Child' })).status).toBe(400);
  expect((await create({ dateOfBirth: '2024-02-29' })).dateOfBirth).toBe('2024-02-29');
});

test('invalid edits preserve existing values', async () => {
  const child = await create();
  expect((await request(app).put('/api/children/' + child.id).send({ lastName: 'Changed', dateOfBirth: '2024-02-30' })).status).toBe(400);
  expect(await db.getChildById(child.id)).toMatchObject({ lastName: values.lastName, dateOfBirth: values.dateOfBirth });
});

test('search matches full and preferred names and combines room/enrollment filters', async () => {
  const target = await room({ capacity: 5 });
  const child = await create({ firstName: 'Alice', lastName: 'Example', preferredName: 'Sunny', roomId: target.id });
  const inactive = await create({ firstName: 'Inactive', active: false });
  await create({ firstName: 'Unassigned' });
  const get = (query) => request(app).get('/api/children').query(query);
  expect((await get({ q: 'alice example', roomId: target.id })).body.items.map((row) => row.id)).toEqual([child.id]);
  expect((await get({ q: 'SUNNY' })).body.items.map((row) => row.id)).toEqual([child.id]);
  expect((await get({ active: 'false' })).body.items.map((row) => row.id)).toEqual([inactive.id]);
  expect((await get({ active: 'all' })).body.total).toBe(3);
  expect((await get({ roomId: 'unassigned' })).body.total).toBe(1);
  expect((await get({ pageSize: 1, page: 2 })).body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
  expect((await get({ active: 'unknown' })).status).toBe(400);
  expect((await get({ page: 0 })).status).toBe(400);
  expect((await get({ pageSize: 201 })).status).toBe(400);
});

test('search treats SQL wildcard characters as literal text', async () => {
  await create({ firstName: 'Percent%_Name' });
  await create({ firstName: 'Other' });
  const response = await request(app).get('/api/children').query({ q: '%_' });
  expect(response.body.total).toBe(1);
  expect(response.body.items[0].firstName).toBe('Percent%_Name');
});

test('duplicate names prompt for review, including inactive matches, but allow confirmation', async () => {
  const first = await create({ firstName: 'Mary  Jane', lastName: 'Example', active: false, notes: 'Not included in duplicate previews.' });
  const payload = { ...values, firstName: '  mary jane ', lastName: ' EXAMPLE ', dateOfBirth: '2023-01-15' };
  const duplicate = await request(app).post('/api/children').send(payload);
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe('CHILD_DUPLICATE_WARNING');
  expect(duplicate.body.error.duplicates).toEqual([expect.objectContaining({ id: first.id, active: false })]);
  expect(duplicate.body.error.duplicates[0]).not.toHaveProperty('notes');
  expect(await db.countChildren()).toBe(1);
  const second = await create({ ...payload, confirmDuplicate: true });
  expect(second.id).not.toBe(first.id);
  expect((await request(app).put('/api/children/' + second.id).send({ notes: 'Changed note.' })).status).toBe(200);
});

test('editing a name also requires duplicate acknowledgement and preserves other records', async () => {
  const first = await create();
  const second = await create({ firstName: 'Other' });
  const path = '/api/children/' + second.id;
  expect((await request(app).put(path).send({ firstName: values.firstName })).status).toBe(409);
  expect((await db.getChildById(second.id)).firstName).toBe('Other');
  expect((await request(app).put(path).send({ firstName: values.firstName, confirmDuplicate: true })).status).toBe(200);
  expect((await db.getChildById(first.id)).firstName).toBe(values.firstName);
});

test('concurrent same-name creates cannot bypass duplicate review', async () => {
  const results = await Promise.all([1, 2].map(() => request(app).post('/api/children').send(values)));
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await db.countChildren()).toBe(1);
});

test('ending enrollment frees capacity and preserves room references, profiles and open attendance', async () => {
  const target = await room();
  const child = await create({ roomId: target.id });
  const checkin = await request(app).post('/api/attendance/checkin').send({ childId: child.id, roomId: target.id });
  expect(checkin.status).toBe(201);
  const ended = await request(app).put('/api/children/' + child.id + '/enrollment').send({ active: false });
  expect(ended.status).toBe(200);
  expect(ended.body).toMatchObject({ id: child.id, active: false, roomId: target.id });
  expect((await request(app).get('/api/children')).body.items).toEqual([]);
  expect((await request(app).get('/api/rooms/' + target.id)).body.data.assignedChildCount).toBe(0);
  expect((await request(app).get('/api/rooms')).body.data[0].assignedChildCount).toBe(0);
  const profile = await request(app).get('/api/children/' + child.id + '/profile');
  expect(profile.body.recentAttendance[0].id).toBe(checkin.body.id);
  expect((await request(app).post('/api/attendance/checkin').send({ childId: child.id, roomId: target.id })).body.error.code).toBe('CHILD_INACTIVE');
  expect((await request(app).post('/api/attendance/' + checkin.body.id + '/checkout')).status).toBe(200);
  expect((await request(app).put('/api/children/' + child.id + '/room').send({ roomId: target.id })).status).toBe(409);
  expect((await request(app).get('/api/rooms/' + target.id + '/assignment-preview').query({ childId: child.id })).status).toBe(409);
  expect((await request(app).delete('/api/children/' + child.id)).status).toBe(405);
  expect(await db.getChildById(child.id)).not.toBeNull();
});

test('reactivation checks capacity again and rejects an archived retained room', async () => {
  const target = await room();
  const inactive = await create({ roomId: target.id, active: false });
  await create({ firstName: 'Enrolled', roomId: target.id });
  const path = '/api/children/' + inactive.id + '/enrollment';
  expect((await request(app).put(path).send({ active: true })).body.error.code).toBe('ROOM_CAPACITY_WARNING');
  expect((await db.getChildById(inactive.id)).active).toBe(false);
  expect((await request(app).put(path).send({ active: true, confirmOverCapacity: true })).status).toBe(200);
  expect((await request(app).get('/api/rooms/' + target.id)).body.data.assignedChildCount).toBe(2);
  await request(app).put(path).send({ active: false });
  await request(app).put('/api/rooms/' + target.id).send({ active: false });
  expect((await request(app).put(path).send({ active: true, confirmOverCapacity: true })).body.error.code).toBe('ROOM_ARCHIVED');
  expect((await request(app).put(path).send({ active: true, roomId: null })).status).toBe(200);
});

test('ending enrollment does not require inventing a missing legacy birth date', async () => {
  const old = await db.createChild({ firstName: 'Legacy', lastName: 'Child' });
  const response = await request(app).put('/api/children/' + old.id + '/enrollment').send({ active: false });
  expect(response.status).toBe(200);
  expect((await db.getChildById(old.id)).dateOfBirth == null).toBe(true);
});

test('roster permissions and audit attribution use the acting account', async () => {
  expect((await anonymous(app).get('/api/children')).status).toBe(401);
  const child = await create();
  expect((await anonymous(app).get('/api/children/' + child.id + '/profile')).status).toBe(401);
  const { account } = request.credentials();
  await db.updateAccount(account.id, { role: 'editor' });
  expect((await request(app).put('/api/children/' + child.id).send({ preferredName: 'Sunny' })).status).toBe(200);
  expect((await request(app).put('/api/children/' + child.id + '/enrollment').send({ active: false })).status).toBe(200);
  expect(await db.listAudit()).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'child.create', actorId: account.id, entityId: child.id }),
    expect.objectContaining({ action: 'child.update', actorId: account.id, entityId: child.id }),
    expect.objectContaining({ action: 'child.enrollment', actorId: account.id, entityId: child.id }),
  ]));
  await db.updateAccount(account.id, { role: 'viewer' });
  expect((await request(app).get('/api/children?active=all')).status).toBe(200);
  expect((await request(app).get('/api/children/' + child.id + '/profile')).status).toBe(200);
  expect((await request(app).put('/api/children/' + child.id).send({ lastName: 'Forbidden' })).status).toBe(403);
  expect((await request(app).put('/api/children/' + child.id + '/enrollment').send({ active: true })).status).toBe(403);
});

test('an enrollment change rolls back if its audit cannot be saved', async () => {
  const child = await create();
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await request(app).put('/api/children/' + child.id + '/enrollment').send({ active: false })).status).toBe(500);
    expect((await db.getChildById(child.id)).active).toBe(true);
    expect(log).toHaveBeenCalledWith('Request failed (internal server error).');
  } finally { audit.mockRestore(); log.mockRestore(); }
});
