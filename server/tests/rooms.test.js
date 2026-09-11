const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const roomValues = { name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 1, active: true };
const activityValues = { name: 'Art', category: 'foundational', repeatWindowWeeks: 1, type: 'art', location: 'indoor', ageMin: 2, ageMax: 5, energyLevel: 'low' };
async function room(values = {}) {
  const result = await request(app).post('/api/rooms').send({ ...roomValues, ...values });
  expect(result.status).toBe(201);
  return result.body.data;
}
async function child(values = {}) {
  const result = await request(app).post('/api/children').send({ firstName: 'Synthetic', lastName: 'Child', ...values });
  expect(result.status).toBe(201);
  return result.body;
}

test('rooms can be created, edited, archived and reactivated with stable IDs', async () => {
  const created = await room({ name: '  Sunflower  ' });
  expect(created).toMatchObject({ name: 'Sunflower', assignedChildCount: 0, availablePlaces: 1, needsConfiguration: false });
  const updated = await request(app).put('/api/rooms/' + created.id).send({ name: 'Sunflower class', capacity: 12, active: false });
  expect(updated.status).toBe(200);
  expect(updated.body.data).toMatchObject({ id: created.id, name: 'Sunflower class', capacity: 12, active: false });
  expect((await request(app).get('/api/rooms')).body.data).toEqual([]);
  expect((await request(app).get('/api/rooms?includeArchived=true')).body.data).toHaveLength(1);
  expect((await request(app).put('/api/rooms/' + created.id).send({ active: true })).status).toBe(200);
  expect((await request(app).delete('/api/rooms/' + created.id)).status).toBe(404);
});

test.each([
  { name: '   ' }, { name: 'x'.repeat(101) }, { ageMinMonths: -1 }, { ageMinMonths: 25.5 },
  { ageMaxMonths: 18 }, { ageMaxMonths: 217 }, { capacity: 0 }, { capacity: 2.5 },
  { capacity: '20' }, { active: 'false' }, { id: 'custom-id' },
])('room validation rejects invalid settings %j without storing a room', async (invalid) => {
  const result = await request(app).post('/api/rooms').send({ ...roomValues, ...invalid });
  expect(result.status).toBe(400);
  expect(result.body.error.fields).toBeDefined();
  expect(await db.listRooms({ includeArchived: true })).toHaveLength(0);
});

test('capacity warning is previewed, requires confirmation, and counts transfers only once', async () => {
  const target = await room();
  const first = await child({ roomId: target.id });
  const second = await child();
  const preview = await request(app).get('/api/rooms/' + target.id + '/assignment-preview?childId=' + second.id);
  expect(preview.body.data).toMatchObject({ proposedChildCount: 2, exceedsCapacity: true, alreadyAssigned: false });
  const assign = (payload) => request(app).put('/api/children/' + second.id + '/room').send(payload);
  expect((await assign({ roomId: target.id })).body.error.code).toBe('ROOM_CAPACITY_WARNING');
  expect((await db.getChildById(second.id)).roomId).toBeNull();
  expect((await assign({ roomId: target.id, confirmOverCapacity: true })).status).toBe(200);
  expect((await request(app).get('/api/rooms/' + target.id)).body.data).toMatchObject({ assignedChildCount: 2, overCapacity: true, availablePlaces: 0 });
  expect((await assign({ roomId: target.id })).status).toBe(200);
  const other = await room({ name: 'Other' });
  expect((await assign({ roomId: other.id })).status).toBe(200);
  expect((await request(app).get('/api/children?roomId=' + target.id)).body.items.map((item) => item.id)).toEqual([first.id]);
  expect((await assign({ roomId: null })).status).toBe(200);
  expect((await request(app).get('/api/rooms/' + other.id)).body.data.assignedChildCount).toBe(0);
});

test('assigned counts include children beyond the default list page', async () => {
  const target = await room({ capacity: 100 });
  for (let i = 0; i < 55; i++) await db.createChild({ firstName: 'Synthetic ' + i, lastName: 'Child', roomId: target.id });
  expect((await request(app).get('/api/children')).body.items).toHaveLength(50);
  expect((await request(app).get('/api/rooms/' + target.id)).body.data.assignedChildCount).toBe(55);
  expect((await request(app).get('/api/rooms')).body.data[0].assignedChildCount).toBe(55);
});

test('two simultaneous assignments cannot silently bypass the capacity warning', async () => {
  const target = await room();
  const first = await child();
  const second = await child();
  const results = await Promise.all([first, second].map((person) =>
    request(app).put('/api/children/' + person.id + '/room').send({ roomId: target.id })));
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await db.countChildren({ roomId: target.id })).toBe(1);
});

test('archival preserves children, attendance, activities and schedules and rejects new assignments', async () => {
  const target = await room();
  const enrolled = await child({ roomId: target.id });
  const unassigned = await child();
  const activity = await request(app).post('/api/activity').send({ ...activityValues, roomId: target.id });
  expect(activity.status).toBe(201);
  const week = { roomId: target.id, weekStart: '2026-09-07', entries: [{ date: '2026-09-07', timeBlock: 'morning', activityId: activity.body.data.id }] };
  expect((await request(app).post('/api/schedule/week').send(week)).status).toBe(200);
  const attendance = await request(app).post('/api/attendance/checkin').send({ childId: enrolled.id, roomId: target.id });
  expect(attendance.status).toBe(201);
  expect((await request(app).put('/api/rooms/' + target.id).send({ active: false })).status).toBe(200);
  expect((await db.getChildById(enrolled.id)).roomId).toBe(target.id);
  expect((await request(app).get('/api/rooms/' + target.id)).body.data.assignedChildCount).toBe(1);
  expect((await request(app).get('/api/schedule/week?roomId=' + target.id + '&start=2026-09-07')).body).toHaveLength(1);
  expect((await request(app).get('/api/activity/' + activity.body.data.id)).status).toBe(200);
  expect((await request(app).put('/api/children/' + unassigned.id + '/room').send({ roomId: target.id })).status).toBe(409);
  expect((await request(app).post('/api/children').send({ firstName: 'New', lastName: 'Child', roomId: target.id })).status).toBe(409);
  expect((await request(app).put('/api/children/' + unassigned.id).send({ firstName: 'New', lastName: 'Child', roomId: target.id })).status).toBe(409);
  expect((await request(app).post('/api/activity').send({ ...activityValues, roomId: target.id })).status).toBe(409);
  expect((await request(app).post('/api/schedule/week').send(week)).status).toBe(409);
  expect((await request(app).post('/api/activity/week').send({ roomId: target.id, weekStart: week.weekStart, week: week.entries })).status).toBe(409);
  expect((await request(app).post('/api/attendance/checkin').send({ childId: enrolled.id, roomId: target.id })).status).toBe(409);
  expect((await request(app).put('/api/children/' + enrolled.id).send({ firstName: 'Updated', lastName: 'Child', roomId: target.id })).status).toBe(200);
  expect((await request(app).post('/api/attendance/' + attendance.body.id + '/checkout')).status).toBe(200);
});

test('unknown rooms are rejected by assignments and present-child lookups', async () => {
  const person = await child();
  expect((await request(app).put('/api/children/' + person.id + '/room').send({ roomId: 'missing' })).status).toBe(404);
  expect((await request(app).get('/api/rooms/missing/present-children?date=2026-09-07')).status).toBe(404);
});

test('all rooms require sign-in, only administrators manage rooms, and viewers cannot assign', async () => {
  expect((await anonymous(app).get('/api/rooms')).status).toBe(401);
  const target = await room();
  const person = await child();
  const { account } = request.credentials();
  await db.updateAccount(account.id, { role: 'editor' });
  expect((await request(app).get('/api/rooms')).status).toBe(200);
  expect((await request(app).post('/api/rooms').send(roomValues)).status).toBe(403);
  expect((await request(app).put('/api/rooms/' + target.id).send({ active: false })).status).toBe(403);
  expect((await request(app).put('/api/children/' + person.id + '/room').send({ roomId: target.id })).status).toBe(200);
  await db.updateAccount(account.id, { role: 'viewer' });
  expect((await request(app).get('/api/rooms')).status).toBe(200);
  expect((await request(app).put('/api/children/' + person.id + '/room').send({ roomId: null })).status).toBe(403);
});

test('room changes have attributed audits and roll back when the audit cannot commit', async () => {
  const target = await room();
  expect(await db.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'room.create', entityId: target.id, actorId: request.credentials().account.id })]));
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  try { expect((await request(app).put('/api/rooms/' + target.id).send({ active: false })).status).toBe(500); }
  finally { audit.mockRestore(); }
  expect((await db.getRoomById(target.id)).active).toBe(true);
});

test('schedule and activity selectors use the selected room and preserve week data', async () => {
  const target = await room();
  const other = await room({ name: 'Other' });
  const activity = await request(app).post('/api/activity').send({ ...activityValues, roomId: target.id });
  const foreign = await request(app).post('/api/activity').send({ ...activityValues, name: 'Other art', roomId: other.id });
  expect((await request(app).get('/api/activity/generate?roomId=' + target.id + '&weekStart=2026-09-07')).body.data[0].activity).toBe('Art');
  const week = { roomId: target.id, weekStart: '2026-09-07', entries: [{ date: '2026-09-07', timeBlock: 'morning', activityId: foreign.body.data.id }] };
  expect((await request(app).post('/api/schedule/week').send(week)).status).toBe(400);
  week.entries[0].activityId = activity.body.data.id;
  expect((await request(app).post('/api/schedule/week').send(week)).status).toBe(200);
  expect((await request(app).get('/api/schedule/week?roomId=' + target.id + '&start=2026-09-07')).body[0].activityId).toBe(activity.body.data.id);
  expect((await request(app).get('/api/schedule/week?roomId=' + other.id + '&start=2026-09-07')).body).toEqual([]);
  expect((await request(app).get('/api/schedule/suggestions?roomId=' + target.id + '&start=bad-date')).status).toBe(400);
});
