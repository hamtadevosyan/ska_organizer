const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const care = require('../services/teacherCareService');
const time = require('../services/facilityTime');
const fixture = require('./helpers/authenticatedRequest');
const safety = require('../services/childSafetyService');
const origin = fixture.origin;
const room = () => db.createRoom({ name: 'Synthetic class', active: true, ageMinMonths: 24, ageMaxMonths: 60, capacity: 30 });
const child = (roomId, changes = {}) => db.createChild({ firstName: 'Own', lastName: 'Child', active: true, roomId,
  dateOfBirth: '2023-01-01', notes: 'PRIVATE CONTRACT NOTES', ...changes });
const adminToken = () => fixture.credentials().cookie.split('=')[1];
async function actor(role, roomId = null) {
  const admin = await db.getAccount(fixture.credentials().account.id);
  const account = await db.createAccount({ id: randomUUID(), username: 'synthetic-' + randomUUID(), displayName: 'Synthetic ' + role,
    role, roomId, documentAccess: 'none', passwordHash: admin.passwordHash, mustChangePassword: false, disabled: false });
  const token = randomBytes(32).toString('hex'); const now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: account.id, createdAt: now, lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3600000), remembered: false });
  return { account, token, request(method, path, body) {
    return http(app)[method]('/api' + path).set('Origin', origin).set('Cookie', 'skao_session=' + token)
      .set('X-CSRF-Token', auth.csrfToken(token)).send(body);
  } };
}
const details = (changes = {}) => ({ version: 0, reviewed: true, allergyStatus: 'recorded', allergies: 'Peanut allergy', dietaryRestrictions: 'No peanuts',
  medicalAlerts: 'Approved asthma care plan', careInstructions: 'Follow the current signed care plan.', medicationInstructions: 'Only as authorized in the signed plan.',
  medicationLocation: 'Locked staff cabinet', physicianName: 'Synthetic physician', physicianPhone: '555-0100', pickupRestrictions: 'Verify authorized adult identity',
  emergencyContacts: [{ name: 'Synthetic parent', relationship: 'Parent', phone: '555-0101' }],
  authorizedPickup: [{ name: 'Synthetic guardian', relationship: 'Guardian', phone: '555-0102' }], treatmentConsent: 'on-file', ...changes });
async function setup() {
  const own = await room(); const other = await room(); const pupil = await child(own.id); const foreign = await child(other.id, { firstName: 'PRIVATE OTHER' });
  return { own, other, pupil, foreign, teacher: await actor('teacher', own.id) };
}
test('Teacher accounts require explicit active-class assignment and retain it on display-name edits', async () => {
  const assigned = await room();
  const created = await auth.createAccount(adminToken(), { username: 'teacher-created', displayName: 'Teacher', role: 'teacher', roomId: assigned.id, password: 'Synthetic teacher passphrase 20!' });
  expect(created).toMatchObject({ role: 'teacher', roomId: assigned.id, documentAccess: 'none' });
  const updated = await auth.updateAccount(adminToken(), created.id, { displayName: 'New name', role: 'teacher', disabled: false });
  expect(updated.roomId).toBe(assigned.id);
  const unassigned = await auth.createAccount(adminToken(), { username: 'teacher-unassigned', displayName: assigned.name, role: 'teacher', password: 'Synthetic teacher passphrase 20!' });
  expect(unassigned.roomId).toBeNull();
});
test('Teacher can use existing saved class projections while every legacy operational route remains blocked', async () => {
  const { teacher, own } = await setup();
  expect((await teacher.request('get', '/classroom/children')).body.data.items).toHaveLength(1);
  expect((await teacher.request('get', '/classroom')).body.data.room.id).toBe(own.id);
  for (const path of ['/children', '/staff', '/rooms', '/attendance/daily', '/inventory', '/reports/config', '/menu/generate', '/admin/accounts', '/registration-forms']) {
    expect((await teacher.request('get', path)).status).toBe(403);
    expect((await teacher.request('head', path)).status).toBe(403);
  }
  expect((await teacher.request('post', '/shopping/generate', {})).status).toBe(403);
});
test('Teacher roster shows active assigned children and minimal current visits only', async () => {
  const { teacher, own, pupil } = await setup();
  await child(own.id, { active: false });
  const checked = await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date: time.dateAt(), requestId: randomUUID() });
  expect(checked.status).toBe(200);
  const response = await teacher.request('get', '/classroom/attendance');
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data.rows).toHaveLength(1);
  const row = response.body.data.rows[0];
  expect(row).toMatchObject({ child: { id: pupil.id }, canCheckIn: false, canCheckOut: true, needsAdminReview: false });
  expect(Object.keys(row.records[0]).sort()).toEqual(['checkIn', 'checkOut', 'id', 'needsReview', 'version', 'voided']);
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|recordedBy|requestId|dateOfBirth|notes|password|document/);
});
test('arrivals and departures use server times, actor attribution, stable retries and one audit per actual change', async () => {
  const { teacher, pupil } = await setup(); const requestId = randomUUID(); const date = time.dateAt();
  const before = Date.now();
  const first = await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date, requestId });
  expect(first.status).toBe(200);
  const id = first.body.data.record.id;
  expect((await db.getAttendanceById(id)).recordedBy).toBe(teacher.account.id);
  expect(new Date(first.body.data.record.checkIn).getTime()).toBeGreaterThanOrEqual(before);
  expect((await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date, requestId })).body.data.record.id).toBe(id);
  const out = await teacher.request('post', '/classroom/attendance/' + id + '/checkout', { date, version: 1 });
  expect(out.status).toBe(200); expect(out.body.data.record.version).toBe(2);
  expect((await teacher.request('post', '/classroom/attendance/' + id + '/checkout', { date, version: 1 })).body.data.record).toEqual(out.body.data.record);
  const events = await db.listAudit({ actions: ['attendance.check_in', 'attendance.check_out'] });
  expect(events).toHaveLength(2); expect(events.every(event => event.actorId === teacher.account.id)).toBe(true);
});
test('foreign children, foreign visits, inactive children and forged action fields cannot modify attendance', async () => {
  const { teacher, pupil, foreign, own } = await setup(); const date = time.dateAt();
  const foreignVisit = await db.createAttendance({ childId: foreign.id, roomId: foreign.roomId, checkIn: new Date().toISOString(), checkOut: null });
  expect((await teacher.request('post', '/classroom/children/' + foreign.id + '/checkin', { date, requestId: randomUUID() })).status).toBe(404);
  expect((await teacher.request('post', '/classroom/attendance/' + foreignVisit.id + '/checkout', { date, version: 1 })).status).toBe(404);
  for (const extra of [{ roomId: own.id }, { recordedBy: 'forged' }, { checkIn: '2020-01-01' }, { signature: 'forged' }]) {
    expect((await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date, requestId: randomUUID(), ...extra })).status).toBe(400);
  }
  await db.updateChild(pupil.id, { active: false });
  expect((await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date, requestId: randomUUID() })).status).toBe(404);
  expect(await db.listAttendance({ childId: pupil.id })).toHaveLength(0);
});
test('today-only attendance rejects stale dates, wrong versions, historical visits and corrections', async () => {
  const { teacher, pupil, own } = await setup(); const date = time.dateAt();
  expect((await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date: '2020-01-01', requestId: randomUUID() })).status).toBe(409);
  const current = await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date, requestId: randomUUID() });
  const id = current.body.data.record.id;
  expect((await teacher.request('post', '/classroom/attendance/' + id + '/checkout', { date, version: 7 })).status).toBe(409);
  expect((await teacher.request('put', '/attendance/' + id + '/correction', { version: 1, reason: 'forged' })).status).toBe(403);
  await db.updateAttendance(id, { checkIn: '2020-01-01T10:00:00Z' });
  expect((await teacher.request('post', '/classroom/attendance/' + id + '/checkout', { date, version: 1 })).status).toBe(409);
  expect((await teacher.request('get', '/classroom/attendance')).body.data.rows[0]).toMatchObject({ needsAdminReview: true, canCheckOut: false, canCheckIn: false });
  expect((await db.getAttendanceById(id)).roomId).toBe(own.id);
});
test('Class viewer keeps read-only names and cannot use attendance actions or safety cards', async () => {
  const { own, pupil } = await setup(); const viewer = await actor('viewer', own.id);
  for (const path of ['/classroom/attendance', '/classroom/children/' + pupil.id + '/safety', '/children/' + pupil.id + '/safety']) expect((await viewer.request('get', path)).status).toBe(403);
  expect((await viewer.request('post', '/classroom/children/' + pupil.id + '/checkin', { date: time.dateAt(), requestId: randomUUID() })).status).toBe(403);
});
test.each([null, 'archived'])('missing or %s assignments reveal no records and permit no action', async kind => {
  const { teacher, own, pupil } = await setup();
  if (kind === null) await db.updateAccount(teacher.account.id, { roomId: null }); else await db.updateRoom(own.id, { active: false });
  const data = (await teacher.request('get', '/classroom/attendance')).body.data;
  expect(data).toMatchObject({ room: null, rows: [] });
  expect((await teacher.request('post', '/classroom/children/' + pupil.id + '/checkin', { date: time.dateAt(), requestId: randomUUID() })).status).toBe(403);
  expect((await teacher.request('get', '/classroom/children/' + pupil.id + '/safety')).status).toBe(403);
});
test('safety starts unknown and is not inferred from notes or registration documents', async () => {
  const { teacher, pupil } = await setup();
  const result = await teacher.request('get', '/classroom/children/' + pupil.id + '/safety');
  expect(result.status).toBe(200);
  expect(result.body.data.card).toMatchObject({ version: 0, reviewedAt: null, allergyStatus: 'unknown', allergies: '', emergencyContacts: [], treatmentConsent: 'unknown' });
  expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|notes|document|insurance/);
});
test('administrator reviews safety details; teacher can read only the dedicated minimal card', async () => {
  const { teacher, pupil, foreign } = await setup();
  const saved = await safety.save(adminToken(), pupil.id, details());
  expect(saved).toMatchObject({ version: 1, allergies: 'Peanut allergy', reviewedAt: expect.anything() });
  const profile = await db.getChildSafetyProfile(pupil.id);
  await db.saveChildSafetyProfile({ ...profile, details: { ...profile.details, insurance: 'PRIVATE INSURANCE', contract: 'PRIVATE CONTRACT' } });
  const read = await teacher.request('get', '/classroom/children/' + pupil.id + '/safety');
  expect(read.status).toBe(200); expect(read.headers['cache-control']).toBe('no-store');
  expect(read.body.data.card).toMatchObject({ version: 1, allergies: 'Peanut allergy', emergencyContacts: [{ name: 'Synthetic parent', phone: '555-0101' }] });
  expect(JSON.stringify(read.body)).not.toMatch(/PRIVATE|reviewedBy|passwordHash|dateOfBirth|notes/);
  expect((await teacher.request('get', '/classroom/children/' + foreign.id + '/safety')).status).toBe(404);
  expect((await teacher.request('put', '/children/' + pupil.id + '/safety', details())).status).toBe(403);
  const reads = await db.listAudit({ actions: ['child.safety.view'] });
  expect(reads).toHaveLength(1); expect(reads[0].actorId).toBe(teacher.account.id);
});
test('safety editing rejects unreviewed, unknown, inconsistent and stale content; editor can only read', async () => {
  const { pupil } = await setup(); const editor = await actor('editor');
  for (const changes of [{ reviewed: false }, { allergyStatus: 'none' }, { careInstructions: 'x'.repeat(4001) }, { insurance: 'forbidden' }, { emergencyContacts: [{ name: 'No phone', relationship: '' }] }]) {
    await expect(safety.save(adminToken(), pupil.id, details(changes))).rejects.toMatchObject({ status: 400 });
  }
  expect(await db.getChildSafetyProfile(pupil.id)).toBeNull();
  await safety.save(adminToken(), pupil.id, details());
  await expect(safety.save(adminToken(), pupil.id, details())).rejects.toMatchObject({ status: 409, code: 'SAFETY_VERSION_CONFLICT' });
  expect((await editor.request('get', '/children/' + pupil.id + '/safety')).status).toBe(200);
  expect((await editor.request('put', '/children/' + pupil.id + '/safety', details({ version: 1 }))).status).toBe(403);
});
test('health data never appears in global child lists or ordinary class projections', async () => {
  const { teacher, pupil } = await setup(); await safety.save(adminToken(), pupil.id, details());
  expect(JSON.stringify((await fixture(app).get('/api/children')).body)).not.toMatch(/Peanut|555-0101|medicalAlerts|careInstructions/);
  expect(JSON.stringify((await teacher.request('get', '/classroom/children')).body)).not.toMatch(/Peanut|555-0101|medicalAlerts|careInstructions/);
});
test('attendance and safety writes roll back completely if audit insertion fails', async () => {
  const { teacher, pupil } = await setup();
  const spy = jest.spyOn(db, 'appendAudit').mockRejectedValue(new Error('Synthetic audit outage'));
  try {
    await expect(safety.save(adminToken(), pupil.id, details())).rejects.toThrow('Synthetic audit outage');
    await expect(care.checkIn(teacher.token, pupil.id, { date: time.dateAt(), requestId: randomUUID() })).rejects.toThrow('Synthetic audit outage');
  } finally { spy.mockRestore(); }
  expect(await db.getChildSafetyProfile(pupil.id)).toBeNull();
  expect(await db.listAttendance({ childId: pupil.id })).toHaveLength(0);
});
test('scope-changing edits revoke teacher sessions and a waiting request uses the live class', async () => {
  const { teacher, pupil, other } = await setup();
  const value = { displayName: teacher.account.displayName, role: 'teacher', disabled: false, roomId: other.id };
  await auth.updateAccount(adminToken(), teacher.account.id, value);
  expect((await teacher.request('get', '/classroom/children/' + pupil.id + '/safety')).status).toBe(401);
  const next = await actor('teacher', pupil.roomId);
  const original = db.withRoomLock; let waiting; let release;
  const blocked = new Promise(resolve => { waiting = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const lock = jest.spyOn(db, 'withRoomLock').mockImplementationOnce(async operation => { waiting(); await gate; return original(operation); });
  try {
    const read = care.safety(next.token, pupil.id, {});
    await blocked;
    await db.updateAccount(next.account.id, { roomId: other.id });
    release();
    await expect(read).rejects.toMatchObject({ status: 404 });
  } finally { release(); lock.mockRestore(); }
});
test('queries cannot override class scope, and attendance mutations still require CSRF and Origin', async () => {
  const { teacher, other, pupil } = await setup();
  expect((await teacher.request('get', '/classroom/attendance?roomId=' + other.id)).status).toBe(400);
  expect((await teacher.request('get', '/classroom/children/' + pupil.id + '/safety?includeDocuments=true')).status).toBe(400);
  expect((await http(app).post('/api/classroom/children/' + pupil.id + '/checkin').set('Cookie', 'skao_session=' + teacher.token).set('Origin', origin).send({ date: time.dateAt(), requestId: randomUUID() })).status).toBe(403);
  expect((await http(app).post('/api/classroom/children/' + pupil.id + '/checkin').set('Cookie', 'skao_session=' + teacher.token).set('X-CSRF-Token', auth.csrfToken(teacher.token)).send({ date: time.dateAt(), requestId: randomUUID() })).status).toBe(403);
});


test('an invalid legacy timestamp is flagged for administrator review without breaking the roster', async () => {
  const { teacher, pupil, own } = await setup();
  const record = await db.createAttendance({ childId: pupil.id, roomId: own.id, checkIn: new Date().toISOString(), checkOut: null });
  // PostgreSQL itself rejects invalid timestamp strings; simulate a legacy read.
  const original = db.listAttendance;
  const spy = jest.spyOn(db, 'listAttendance').mockImplementation(async filters => (await original(filters)).map(row => row.id === record.id ? { ...row, checkIn: 'invalid' } : row));
  try {
    const response = await teacher.request('get', '/classroom/attendance');
    expect(response.status).toBe(200); expect(response.body.data.rows[0]).toMatchObject({ needsAdminReview: true, canCheckIn: false, canCheckOut: false });
  } finally { spy.mockRestore(); }
});
test('authorized pickup names may be recorded without a phone, while emergency contacts require one', async () => {
  const { pupil } = await setup();
  const saved = await safety.save(adminToken(), pupil.id, details({ authorizedPickup: [{ name: 'Authorized relative', relationship: 'Relative', phone: '' }] }));
  expect(saved.authorizedPickup[0]).toEqual({ name: 'Authorized relative', relationship: 'Relative', phone: '' });
});
