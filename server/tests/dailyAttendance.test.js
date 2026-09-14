const request = require('./helpers/authenticatedRequest');
const rawRequest = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const time = require('../services/facilityTime');
const previousZone = process.env.FACILITY_TIME_ZONE;
let room, otherRoom, child, otherChild;
const endpoint = '/api/attendance';
async function call(method, path, body, expected = 200) {
  const response = await request(app)[method](endpoint + path).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status: expected, error: expected < 400 ? undefined : expect.anything() });
  return response.body;
}
const checkIn = (extra = {}) => call('post', '/checkin', { childId: child.id, roomId: room.id, date: time.dateAt(), ...extra }, 201);
beforeEach(async () => {
  process.env.FACILITY_TIME_ZONE = 'America/Los_Angeles';
  room = await db.createRoom({ name: 'Daily room', ageMinMonths: 18, ageMaxMonths: 72, capacity: 20 });
  otherRoom = await db.createRoom({ name: 'Other daily room', ageMinMonths: 18, ageMaxMonths: 72, capacity: 20 });
  child = await db.createChild({ firstName: 'Synthetic', lastName: 'Attendance', roomId: room.id, active: true });
  otherChild = await db.createChild({ firstName: 'Other', lastName: 'Attendance', roomId: otherRoom.id, active: true });
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { if (previousZone === undefined) delete process.env.FACILITY_TIME_ZONE; else process.env.FACILITY_TIME_ZONE = previousZone; });

test('today lists the assigned roster and records check-in, check-out and a second visit', async () => {
  let roster = await call('get', '/daily?roomId=' + room.id);
  expect(roster).toMatchObject({ date: time.dateAt(), timeZone: 'America/Los_Angeles', presentCount: 0, attendedCount: 0 });
  expect(roster.rows).toEqual([expect.objectContaining({ childId: child.id, records: [], canCheckIn: true })]);
  const first = await checkIn({ recordedBy: 'untrusted-client-name' });
  expect(first.recordedBy).toBe(request.credentials().account.id);
  roster = await call('get', '/daily?roomId=' + room.id);
  expect(roster).toMatchObject({ presentCount: 1, attendedCount: 1 });
  expect(roster.rows[0]).toMatchObject({ canCheckIn: false, openVisits: [{ id: first.id }] });
  const closed = await call('post', '/' + first.id + '/checkout', { date: time.dateAt(), version: first.version });
  expect(closed).toMatchObject({ checkIn: first.checkIn, version: 2 });
  expect(closed.checkOut).toBeTruthy();
  const repeated = await call('post', '/' + first.id + '/checkout', { date: '2001-01-01', version: first.version });
  expect(repeated).toEqual(closed);
  const second = await checkIn();
  expect(second.id).not.toBe(first.id);
  expect((await call('get', '/daily?roomId=' + room.id)).rows[0].records).toHaveLength(2);
  expect(await call('get', '/today-headcount')).toMatchObject({ date: time.dateAt(), childrenCount: 1 });
});

test('concurrent requests and retry after a lost response cannot create duplicate open visits', async () => {
  const payload = { childId: child.id, roomId: room.id, date: time.dateAt() };
  const responses = await Promise.all(Array.from({ length: 5 }, (_, n) => request(app).post(endpoint + '/checkin').send({ ...payload, requestId: 'concurrent-request-' + n })));
  expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
  expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
  expect(await db.listAttendance({ childId: child.id, openOnly: true })).toHaveLength(1);
  const original = responses[0].body;
  const closed = await call('post', '/' + original.id + '/checkout', {});
  // Replay the key that actually created the record, even after its checkout.
  const replayed = await checkIn({ requestId: original.requestId });
  expect(replayed).toEqual(closed);
  await call('post', '/checkin', { childId: otherChild.id, roomId: otherRoom.id, requestId: original.requestId }, 409);
  expect((await checkIn({ requestId: 'new-arrival-request-123' })).id).not.toBe(original.id);
});

test('rejects wrong-room, inactive, archived-room, stale-date and malformed actions', async () => {
  await call('post', '/checkin', { childId: child.id, roomId: otherRoom.id }, 409);
  await call('post', '/checkin', { childId: child.id, roomId: room.id, date: '2001-01-01' }, 409);
  await call('post', '/checkin', { childId: child.id, roomId: room.id, requestId: 'short' }, 400);
  await db.updateChild(child.id, { active: false });
  await call('post', '/checkin', { childId: child.id, roomId: room.id }, 409);
  await db.updateChild(child.id, { active: true }); await db.updateRoom(room.id, { active: false });
  await call('post', '/checkin', { childId: child.id, roomId: room.id }, 409);
  expect(await db.listAttendance({ childId: child.id })).toEqual([]);
  for (const query of ['date=2026-02-30', 'date=9999-01-01', 'date=bad', 'date=2026-09-07&date=2026-09-08']) await call('get', '/daily?' + query, undefined, 400);
});

test('facility-day overlap filters keep historical room and enrollment, excluding the exact prior midnight departure', async () => {
  const crossing = await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-03-08T07:30:00Z', checkOut: '2026-03-08T08:30:00Z' });
  const prior = await db.createAttendance({ childId: otherChild.id, roomId: room.id, checkIn: '2026-03-08T06:00:00Z', checkOut: '2026-03-08T08:00:00Z' });
  await db.updateChild(child.id, { active: false, roomId: otherRoom.id }); await db.updateRoom(room.id, { active: false });
  const roster = await call('get', '/daily?roomId=' + room.id + '&date=2026-03-08');
  expect(roster).toMatchObject({ attendedCount: 1, presentCount: null });
  expect(roster.rows).toEqual([expect.objectContaining({ childId: child.id, canCheckIn: false, child: expect.objectContaining({ active: false, roomId: otherRoom.id }), records: [expect.objectContaining({ id: crossing.id, roomId: room.id })] })]);
  const records = await call('get', '?date=2026-03-08&roomId=' + room.id);
  expect(records.map((record) => record.id)).toEqual([crossing.id]);
  expect((await call('get', '?date=2026-03-07')).map((record) => record.id)).toContain(prior.id);
  const profile = await request(app).get('/api/children/' + child.id + '/profile');
  expect(profile.body).toMatchObject({ timeZone: 'America/Los_Angeles', recentAttendance: [expect.objectContaining({ id: crossing.id })] });
});

test('corrections retain before/after, actor and reason, reject stale edits and preserve history through void and restore', async () => {
  const original = await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-03-09T16:00:00.000Z', checkOut: '2026-03-09T23:00:00.000Z' });
  const updated = await call('put', '/' + original.id + '/correction', { version: 1, checkIn: '2026-03-09T08:30', reason: 'Arrival was entered late.' });
  expect(updated).toMatchObject({ childId: child.id, checkIn: '2026-03-09T15:30:00.000Z', version: 2 });
  let history = await call('get', '/' + original.id + '/corrections');
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ before: { checkIn: new Date(original.checkIn).toISOString(), version: 1 }, after: { checkIn: updated.checkIn, version: 2 }, reason: 'Arrival was entered late.', actorId: request.credentials().account.id, actorUsername: 'test-admin' });
  expect(Number.isFinite(Date.parse(history[0].occurredAt))).toBe(true);
  await call('put', '/' + original.id + '/correction', { version: 1, reason: 'Stale change' }, 409);
  await call('put', '/' + original.id + '/correction', { version: 2, reason: '  ' }, 400);
  await call('put', '/' + original.id + '/correction', { version: 2, reason: 'Invalid times', checkOut: '2026-03-09T08:00' }, 400);
  await call('put', '/' + original.id + '/correction', { version: 2, reason: 'Future', checkIn: '9999-01-01T09:00' }, 400);
  await call('put', '/' + original.id + '/correction', { version: 2, reason: 'Forged actor', actorId: 'other' }, 400);
  const voided = await call('put', '/' + original.id + '/correction', { version: 2, voided: true, reason: 'Mistaken visit.' });
  expect(voided).toMatchObject({ voided: true, checkIn: updated.checkIn, checkOut: updated.checkOut });
  expect((await call('get', '/daily?date=2026-03-09')).attendedCount).toBe(0);
  await call('put', '/' + original.id + '/correction', { version: 3, voided: false, reason: 'Verified the original visit.' });
  history = await call('get', '/' + original.id + '/corrections');
  expect(history.map((entry) => entry.after.version)).toEqual([2, 3, 4]);
  expect(history[0].before.checkIn).toBe(new Date(original.checkIn).toISOString());
});

test('corrections reject overlapping visits and roll back completely if history cannot be stored', async () => {
  const original = await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-03-09T16:00:00Z', checkOut: '2026-03-09T17:00:00Z' });
  await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-03-09T18:00:00Z', checkOut: '2026-03-09T19:00:00Z' });
  await call('put', '/' + original.id + '/correction', { version: 1, checkOut: '2026-03-09T11:30', reason: 'Overlaps the second visit' }, 409);
  jest.spyOn(db, 'createAttendanceCorrection').mockRejectedValueOnce(new Error('Synthetic history write failure'));
  await call('put', '/' + original.id + '/correction', { version: 1, checkIn: '2026-03-09T08:30', reason: 'Arrival correction' }, 500);
  expect(await db.getAttendanceById(original.id)).toEqual(original);
  expect(await call('get', '/' + original.id + '/corrections')).toEqual([]);
});

test('unresolved old and duplicate visits block today headcount until deliberately corrected', async () => {
  const first = await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-03-09T16:00:00Z', needsReview: true });
  const duplicate = await db.createAttendance({ childId: child.id, roomId: room.id, checkIn: '2026-03-09T17:00:00Z', needsReview: true });
  await call('get', '/today-headcount', undefined, 409);
  await call('post', '/checkin', { childId: child.id, roomId: room.id }, 409);
  expect((await call('get', '/daily?roomId=' + room.id)).rows[0].records.map((r) => r.id)).toEqual(expect.arrayContaining([first.id, duplicate.id]));
  await call('put', '/' + duplicate.id + '/correction', { version: 1, voided: true, reason: 'Duplicate legacy record.' });
  await call('put', '/' + first.id + '/correction', { version: 1, checkOut: '2026-03-09T17:00', reason: 'Verified departure from paper log.' });
  expect((await call('get', '/today-headcount')).childrenCount).toBe(0);
  await checkIn();
  expect((await call('get', '/today-headcount')).childrenCount).toBe(1);
});

test('permissions and CSRF protect mutations, and an audit failure rolls back an arrival', async () => {
  expect((await rawRequest(app).get(endpoint + '/daily')).status).toBe(401);
  expect((await rawRequest(app).post(endpoint + '/checkin').set('Origin', request.origin).set('Cookie', request.credentials().cookie).send({ childId: child.id, roomId: room.id })).status).toBe(403);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  await call('get', '/daily');
  await call('post', '/checkin', { childId: child.id, roomId: room.id }, 403);
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  await call('post', '/checkin', { childId: child.id, roomId: room.id }, 500);
  expect(await db.listAttendance({ childId: child.id })).toEqual([]);
  await checkIn();
});
