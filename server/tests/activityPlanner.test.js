const { randomUUID } = require('node:crypto');
const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const weekStart = '2026-09-14';
async function room(values = {}) {
  const response = await request(app).post('/api/rooms').send({ name: 'Activity room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, ...values });
  expect(response.status).toBe(201); return response.body.data;
}
async function activity(values = {}) {
  const response = await request(app).post('/api/activity').send({ name: 'Paint a tree', description: 'Paint leaves on paper.', durationMinutes: 20, ageMinMonths: 18, ageMaxMonths: 72, materials: [], ...values });
  expect(response.status).toBe(201); return response.body.data;
}
async function stock() {
  const response = await request(app).post('/api/inventory').send({ name: 'Paper', category: 'Art', location: 'Class cupboard', unit: 'count', openingQuantity: '10', reorderThreshold: '0', reason: 'Initial count', requestId: randomUUID() });
  expect(response.status).toBe(201); return response.body.data;
}
const entry = (value, date = weekStart, extra = {}) => ({ id: value.id + ':' + date + ':' + (extra.startTime || '09:00'), date, startTime: '09:00', endTime: '09:20', activityId: value.id, ...extra });
const body = (target, entries, extra = {}) => ({ roomId: target.id, weekStart, entries, version: 0, requestId: randomUUID(), ...extra });
const save = (values) => request(app).post('/api/schedule/plan').send(values);
const get = (target, start = weekStart) => request(app).get('/api/schedule/plan').query({ roomId: target.id, weekStart: start });

test('simple activities create and edit with a version, age validation and material quantities', async () => {
  const item = await stock();
  const created = await activity({ materials: [{ itemId: item.id, quantity: '0.25', unit: item.unit, reusable: false }] });
  expect(created.materials[0]).toMatchObject({ name: 'Paper', location: 'Class cupboard', quantity: '0.25' });
  const edited = await request(app).put('/api/activity/' + created.id).send({ name: 'Tree painting', durationMinutes: 30, version: 1 });
  expect(edited.status).toBe(200); expect(edited.body.data).toMatchObject({ version: 2, durationMinutes: 30, name: 'Tree painting' });
  expect((await request(app).put('/api/activity/' + created.id).send({ name: 'Stale', version: 1 })).status).toBe(409);
  expect((await request(app).get('/api/activity')).body.data).toHaveLength(1);
});

test.each([
  { name: ' ' }, { durationMinutes: 0 }, { durationMinutes: 1.5 }, { durationMinutes: 1441 },
  { ageMinMonths: 0, ageMaxMonths: 0 }, { ageMinMonths: null, ageMaxMonths: 72 },
  { ageMinMonths: 73, ageMaxMonths: 72 }, { ageMaxMonths: 217 }, { materials: {} }, { actorId: 'spoofed' },
])('activity validation rejects %j without writing data', async (invalid) => {
  const response = await request(app).post('/api/activity').send({ name: 'Activity', durationMinutes: 20, ...invalid });
  expect(response.status).toBe(400); expect(await db.listActivities()).toEqual([]);
});

test('materials reject unknown items, duplicate items, nonpositive amounts and mismatched units', async () => {
  const item = await stock();
  const valid = { itemId: item.id, quantity: '2', unit: 'count', reusable: false };
  for (const materials of [[{ ...valid, itemId: 'missing' }], [valid, valid], [{ ...valid, quantity: '0' }], [{ ...valid, quantity: '-1' }], [{ ...valid, unit: 'pack' }]]) {
    const response = await request(app).post('/api/activity').send({ name: 'Invalid material', durationMinutes: 20, materials });
    expect([400, 409]).toContain(response.status);
  }
  expect(await db.listActivities()).toEqual([]);
});

test('weeks stay separate by room and date, empty saved weeks persist and reads never generate a plan', async () => {
  const target = await room(); const other = await room({ name: 'Other room' }); const value = await activity();
  const empty = await get(target); expect(empty.body.data).toMatchObject({ version: 0, savedAt: null, entries: [], materials: [] });
  expect((await save(body(target, [entry(value)]))).body.data).toMatchObject({ version: 1, entries: [{ activityId: value.id, activity: { name: value.name } }] });
  expect((await get(target)).body.data.entries[0].activity.name).toBe(value.name);
  expect((await get(other)).body.data.entries).toEqual([]);
  expect((await get(target, '2026-09-21')).body.data.entries).toEqual([]);
  const cleared = await save(body(target, [], { version: 1 }));
  expect(cleared.status).toBe(200); expect(cleared.body.data).toMatchObject({ version: 2, entries: [] });
  expect((await get(target)).body.data.savedAt).toBeTruthy();
});

test('preview and save add consumables, reuse equipment and do not consume or reserve stock', async () => {
  const target = await room(); const item = await stock();
  const use = await activity({ materials: [{ itemId: item.id, quantity: '6.25', unit: item.unit, reusable: false }] });
  const reuse = await activity({ name: 'Reusable paper shapes', materials: [{ itemId: item.id, quantity: '2', unit: item.unit, reusable: true }] });
  const entries = [entry(use), entry(use, '2026-09-15'), entry(reuse, '2026-09-16'), entry(reuse, '2026-09-17')];
  const preview = await request(app).post('/api/schedule/plan/preview').send({ roomId: target.id, weekStart, entries });
  expect(preview.status).toBe(200);
  expect(preview.body.data.materials[0]).toMatchObject({ needed: '14.5', available: '10', shortage: '4.5' });
  expect((await get(target)).body.data.version).toBe(0);
  const saved = await save(body(target, entries)); expect(saved.status).toBe(200);
  expect(saved.body.data.materials).toEqual(preview.body.data.materials);
  expect(Number((await db.getInventoryById(item.id)).quantity)).toBe(10);
  expect(await db.countInventoryMovements(item.id)).toBe(1);
});

test('catalog corrections preserve saved snapshots until an explicit update and reject stale activity choices', async () => {
  const target = await room(); const value = await activity();
  expect((await save(body(target, [entry(value)]))).status).toBe(200);
  expect((await request(app).put('/api/activity/' + value.id).send({ name: 'Corrected name', version: value.version })).status).toBe(200);
  const retained = await save(body(target, [entry(value)], { version: 1 }));
  expect(retained.status).toBe(200); expect(retained.body.data.entries[0].activity.name).toBe(value.name);
  const stale = await save(body(target, [entry(value, weekStart, { useLatest: true, activityVersion: 1 })], { version: 2 }));
  expect(stale.status).toBe(409);
  const updated = await save(body(target, [entry(value, weekStart, { useLatest: true, activityVersion: 2 })], { version: 2 }));
  expect(updated.status).toBe(200); expect(updated.body.data.entries[0].activity.name).toBe('Corrected name');
  expect((await request(app).delete('/api/activity/' + value.id)).status).toBe(409);
});

test('concurrent saves detect conflicts and a lost response can be retried without duplicating a week', async () => {
  const target = await room(); const value = await activity(); const values = body(target, [entry(value)]);
  const responses = await Promise.all([save(values), save({ ...values, requestId: randomUUID() })]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = responses[0].status === 200 ? values : null;
  if (winner) {
    const retry = await save(winner); expect(retry.status).toBe(200); expect(retry.body.data).toMatchObject({ version: 1, replayed: true });
    expect((await save({ ...winner, entries: [] })).status).toBe(409);
  }
  const latest = await get(target);
  const next = body(target, [], { version: latest.body.data.version });
  expect((await save(next)).status).toBe(200);
  expect((await save(next)).body.data).toMatchObject({ version: 2, replayed: true });
  expect((await request(app).post('/api/schedule/week').send({ roomId: target.id, weekStart, entries: [] })).status).toBe(409);
});

test('invalid identifiers and dates, foreign rooms and incompatible ages cannot replace a saved week', async () => {
  const target = await room(); const other = await room({ name: 'Other' }); const value = await activity();
  const foreign = await activity({ roomId: other.id }); const older = await activity({ ageMinMonths: 72, ageMaxMonths: 120 });
  const first = await save(body(target, [entry(value)])); expect(first.status).toBe(200);
  for (const entries of [[entry(value), entry(value)], [entry(value, '2026-09-21')], [entry(value, weekStart, { timeBlock: 'night' })], [entry(foreign)], [entry(older)], [entry({ id: 'missing' })]]) {
    expect((await save(body(target, entries, { version: 1 }))).status).toBe(400);
  }
  expect((await get(target)).body.data.version).toBe(1);
});

test('archived rooms keep printable weeks; viewers read plans and materials but cannot change them', async () => {
  const target = await room(); const value = await activity(); const values = body(target, [entry(value)]);
  expect((await save(values)).status).toBe(200);
  expect((await request(app).put('/api/rooms/' + target.id).send({ active: false })).status).toBe(200);
  expect((await get(target)).body.data.entries).toHaveLength(1);
  expect((await save(body(target, [], { version: 1 }))).status).toBe(409);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await get(target)).status).toBe(200);
  expect((await request(app).post('/api/schedule/plan/preview').send({ roomId: target.id, weekStart, entries: values.entries })).status).toBe(200);
  expect((await save(values)).status).toBe(403);
  expect((await request(app).post('/api/activity').send({ name: 'Blocked', durationMinutes: 20 })).status).toBe(403);
  expect((await anonymous(app).get('/api/schedule/plan').query({ roomId: target.id, weekStart })).status).toBe(401);
});

test('failed audit rolls back the week header and entries together', async () => {
  const target = await room(); const value = await activity();
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  try { expect((await save(body(target, [entry(value)]))).status).toBe(500); }
  finally { audit.mockRestore(); }
  expect((await get(target)).body.data).toMatchObject({ version: 0, entries: [] });
});

test('live stock changes refresh material checks without rewriting saved activity details', async () => {
  const target = await room(); const item = await stock();
  const value = await activity({ materials: [{ itemId: item.id, quantity: '12', unit: item.unit, reusable: false }] });
  const saved = await save(body(target, [entry(value)])); expect(saved.status).toBe(200);
  const addition = await request(app).post('/api/inventory/' + item.id + '/movements').send({ type: 'addition', quantity: '5', unit: item.unit, reason: 'Delivery', requestId: randomUUID(), version: item.version });
  expect(addition.status).toBe(200);
  const loaded = await get(target); expect(loaded.body.data.materials[0]).toMatchObject({ needed: '12', available: '15', shortage: '0' });
  expect(loaded.body.data.entries).toEqual(saved.body.data.entries);
  expect(loaded.body.data.version).toBe(1); expect(await db.countInventoryMovements(item.id)).toBe(2);
  const changedWeek = await save(body(target, [], { version: 1 })); expect(changedWeek.status).toBe(200);
  expect((await request(app).post('/api/schedule/plan/preview').send({ roomId: target.id, weekStart, version: 1, entries: [entry(value)] })).status).toBe(409);
});

test('a full day accepts more than three activities and a week more than twenty-one, in chronological order', async () => {
  const target = await room(); const value = await activity();
  const clock = (minutes) => String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  const entries = Array.from({ length: 30 }, (_, index) => entry(value, weekStart, { id: randomUUID(), startTime: clock(360 + index * 20), endTime: clock(380 + index * 20) }));
  const values = body(target, [...entries].reverse());
  const saved = await save(values); expect(saved.status).toBe(200);
  expect(saved.body.data.entries).toHaveLength(30);
  expect(saved.body.data.entries.map((item) => item.id)).toEqual(entries.map((item) => item.id));
  expect((await get(target)).body.data.entries).toEqual(saved.body.data.entries);
  expect((await save(values)).body.data).toMatchObject({ version: 1, replayed: true });
  const moved = await save(body(target, [{ ...entries[0], startTime: '23:40', endTime: '24:00' }, ...entries.slice(1)], { version: 1 }));
  expect(moved.status).toBe(200);
  expect(moved.body.data.entries.at(-1)).toMatchObject({ id: entries[0].id, startTime: '23:40', endTime: '24:00' });
});

test('invalid times never overwrite saved data and midnight can end a full-day activity', async () => {
  const target = await room(); const value = await activity({ durationMinutes: 1440 });
  const first = entry(value, weekStart, { startTime: '00:00', endTime: '24:00' });
  expect((await save(body(target, [first]))).status).toBe(200);
  for (const times of [{ startTime: '9:00' }, { endTime: '25:00' }, { startTime: '24:00' },
    { startTime: '09:00', endTime: '09:00' }, { startTime: '09:00', endTime: '08:00' }, { startTime: '09:60' },
    { startTime: null }, { endTime: null }, { startTime: null, endTime: null }, { startTime: ['09:00'] }]) {
    expect((await save(body(target, [{ ...first, ...times }], { version: 1 }))).status).toBe(400);
  }
  expect((await get(target)).body.data).toMatchObject({ version: 1, entries: [{ startTime: '00:00', endTime: '24:00' }] });
});

test('setting legacy times or moving a saved activity preserves its identity and snapshot', async () => {
  const target = await room(); const value = await activity();
  const first = await save(body(target, [{ date: weekStart, timeBlock: 'morning', activityId: value.id }]));
  expect(first.status).toBe(200);
  const original = first.body.data.entries[0];
  expect(original).toMatchObject({ startTime: null, endTime: null, timeBlock: 'morning' });
  await request(app).put('/api/activity/' + value.id).send({ name: 'New catalog name', version: 1 });
  const timed = entry(value, '2026-09-15', { id: original.id, startTime: '07:15', endTime: '08:00' });
  const updated = await save(body(target, [timed], { version: 1 }));
  expect(updated.status).toBe(200);
  expect(updated.body.data.entries[0]).toMatchObject({ ...timed, timeBlock: null, activity: { name: value.name, version: 1 } });
  const repeated = await save(body(target, [timed, entry(value, '2026-09-15', { id: randomUUID(), startTime: '08:00', endTime: '08:20' })], { version: 2 }));
  expect(repeated.status).toBe(200);
  expect(repeated.body.data.entries.map((item) => item.activity.name)).toEqual([value.name, 'New catalog name']);
});

test('overlapping activities are allowed and reusable equipment covers their peak simultaneous demand', async () => {
  const target = await room(); const item = await stock();
  const value = await activity({ materials: [{ itemId: item.id, quantity: '6', unit: item.unit, reusable: true }] });
  const entries = [entry(value, weekStart, { startTime: '09:00', endTime: '10:00' }),
    entry(value, weekStart, { startTime: '09:30', endTime: '10:30' }),
    entry(value, weekStart, { startTime: '10:30', endTime: '11:00' }), entry(value, '2026-09-15')];
  const saved = await save(body(target, entries));
  expect(saved.status).toBe(200); expect(saved.body.data.materials[0]).toMatchObject({ needed: '12', available: '10', shortage: '2' });
  const separated = await save(body(target, entries.filter((item) => item.startTime !== '09:30'), { version: 1 }));
  expect(separated.body.data.materials[0]).toMatchObject({ needed: '6', shortage: '0' });
  expect(Number((await db.getInventoryById(item.id)).quantity)).toBe(10);
  expect(await db.countInventoryMovements(item.id)).toBe(1);
});

test('a scheduled identifier cannot be stolen from another room or week', async () => {
  const target = await room(); const other = await room({ name: 'Other' }); const value = await activity();
  const scheduled = entry(value);
  expect((await save(body(target, [scheduled]))).status).toBe(200);
  expect((await save(body(other, [scheduled]))).status).toBe(409);
  expect((await save(body(target, [{ ...scheduled, date: '2026-09-21' }], { weekStart: '2026-09-21' }))).status).toBe(409);
  expect((await get(target)).body.data.entries).toHaveLength(1);
  expect((await get(other)).body.data.entries).toEqual([]);
});
