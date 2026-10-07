const { randomUUID } = require('node:crypto');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const sourceWeek = '2026-09-14';
const targetWeek = '2026-09-21';
async function room(values = {}) {
  const response = await request(app).post('/api/rooms').send({ name: 'Reuse room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, ...values });
  expect(response.status).toBe(201); return response.body.data;
}
async function activity(values = {}) {
  const response = await request(app).post('/api/activity').send({ name: 'Saved painting', description: 'The original instructions.', durationMinutes: 20,
    ageMinMonths: 18, ageMaxMonths: 72, materials: [], ...values });
  expect(response.status).toBe(201); return response.body.data;
}
const entry = (value, date = sourceWeek, values = {}) => ({ id: randomUUID(), date, startTime: '09:00', endTime: '09:20', activityId: value.id, ...values });
const payload = (target, weekStart, entries, values = {}) => ({ roomId: target.id, weekStart, entries, version: 0, requestId: randomUUID(), ...values });
const save = (values) => request(app).post('/api/schedule/plan').send(values);
const get = (target, weekStart) => request(app).get('/api/schedule/plan').query({ roomId: target.id, weekStart });
const preview = ({ requestId, ...values }) => request(app).post('/api/schedule/plan/preview').send(values);
function copy(source, saved, original, date = targetWeek, values = {}) {
  return { id: randomUUID(), date, startTime: original.startTime, endTime: original.endTime, timeBlock: original.timeBlock,
    activityId: original.activityId, copyFrom: { roomId: source.id, weekStart: saved.weekStart, version: saved.version, entryId: original.id }, ...values };
}
async function sourcePlan(source, value, values = {}) {
  const response = await save(payload(source, sourceWeek, [entry(value, sourceWeek, values)]));
  expect(response.status).toBe(200); return response.body.data;
}

test('copying a saved activity preserves its exact snapshot and times across rooms and weeks, with fresh identities', async () => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Destination' }); const value = await activity();
  const original = await sourcePlan(source, value, { startTime: '07:45', endTime: '08:10' });
  expect((await request(app).put('/api/activity/' + value.id).send({ version: 1, name: 'New catalog name', description: 'Changed instructions', durationMinutes: 35 })).status).toBe(200);
  const copied = copy(source, original, original.entries[0]);
  const response = await save(payload(target, targetWeek, [copied]));
  expect(response.status).toBe(200);
  expect(response.body.data.entries[0]).toEqual({ id: copied.id, date: targetWeek, startTime: '07:45', endTime: '08:10', timeBlock: null,
    activityId: value.id, activity: original.entries[0].activity });
  expect(response.body.data.entries[0]).not.toHaveProperty('copyFrom');
  expect((await get(source, sourceWeek)).body.data).toEqual(original);
  expect((await get(target, targetWeek)).body.data.entries).toEqual(response.body.data.entries);
});

test('copies from the same saved week and legacy block schedules keep the source unchanged', async () => {
  const target = await room(); const value = await activity();
  const original = await sourcePlan(target, value, { startTime: null, endTime: null, timeBlock: 'morning' });
  const copied = copy(target, original, original.entries[0], '2026-09-15');
  const response = await save(payload(target, sourceWeek, [
    { ...original.entries[0], activity: undefined }, copied,
  ], { version: 1 }));
  expect(response.status).toBe(200);
  expect(response.body.data.entries).toHaveLength(2);
  expect(response.body.data.entries[0]).toEqual(original.entries[0]);
  expect(response.body.data.entries[1]).toMatchObject({ id: copied.id, date: '2026-09-15', startTime: null, endTime: null, timeBlock: 'morning', activity: original.entries[0].activity });
  expect(response.body.data.entries[1].id).not.toBe(original.entries[0].id);
});

test('preview uses saved material quantities and current stock without writing either source or destination', async () => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Destination' });
  const inventory = await request(app).post('/api/inventory').send({ name: 'Brushes', category: 'Art', location: 'Cupboard', unit: 'count',
    openingQuantity: '10', reorderThreshold: '0', reason: 'Initial count', requestId: randomUUID() });
  expect(inventory.status).toBe(201); const item = inventory.body.data;
  const value = await activity({ materials: [{ itemId: item.id, quantity: '6', unit: 'count', reusable: true }] });
  const original = await sourcePlan(source, value);
  expect((await request(app).put('/api/activity/' + value.id).send({ version: 1, materials: [{ itemId: item.id, quantity: '1', unit: 'count', reusable: true }] })).status).toBe(200);
  expect((await request(app).post('/api/inventory/' + item.id + '/movements').send({ type: 'usage', quantity: '6', unit: 'count', reason: 'Used elsewhere', requestId: randomUUID(), version: item.version })).status).toBe(200);
  const beforeSource = (await get(source, sourceWeek)).body.data;
  const entries = [copy(source, original, original.entries[0]), copy(source, original, original.entries[0], targetWeek, { startTime: '09:10', endTime: '09:30' })];
  const response = await preview({ roomId: target.id, weekStart: targetWeek, version: 0, entries });
  expect(response.status).toBe(200);
  expect(response.body.data.materials[0]).toMatchObject({ needed: '12', available: '4', shortage: '8' });
  expect((await get(target, targetWeek)).body.data).toMatchObject({ version: 0, savedAt: null, entries: [] });
  expect((await get(source, sourceWeek)).body.data).toEqual(beforeSource);
  expect(Number((await db.getInventoryById(item.id)).quantity)).toBe(4);
  expect(await db.countInventoryMovements(item.id)).toBe(2);
});

test('source version changes or missing source entries reject preview and save without modifying the destination', async () => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Destination' }); const value = await activity();
  const original = await sourcePlan(source, value);
  const existing = await sourcePlan(target, value); // Preserve an already saved destination too.
  const copied = copy(source, original, original.entries[0], sourceWeek);
  expect((await save(payload(source, sourceWeek, [], { version: 1 }))).status).toBe(200);
  for (const sourceChoice of [copied.copyFrom, { ...copied.copyFrom, version: 2 }, { ...copied.copyFrom, roomId: 'missing-room' }]) {
    const values = payload(target, sourceWeek, [existing.entries[0], { ...copied, copyFrom: sourceChoice }].map(({ activity, ...entry }) => entry), { version: 1 });
    for (const operation of [preview, save]) {
      const response = await operation(values);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ACTIVITY_COPY_SOURCE_CONFLICT');
    }
  }
  expect((await get(target, sourceWeek)).body.data).toEqual(existing);
});

test('a lost copy response can be retried after the source and catalog change, but its provenance cannot be substituted', async () => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Destination' }); const value = await activity();
  const original = await sourcePlan(source, value);
  const copied = copy(source, original, original.entries[0]);
  const values = payload(target, targetWeek, [copied]);
  const first = await save(values); expect(first.status).toBe(200);
  expect((await save(payload(source, sourceWeek, [], { version: 1 }))).status).toBe(200);
  expect((await request(app).put('/api/activity/' + value.id).send({ version: 1, ageMinMonths: 72, ageMaxMonths: 120 })).status).toBe(200);
  const retry = await save({ ...values, entries: [{ ...copied, copyFrom: { entryId: copied.copyFrom.entryId, version: 1, weekStart: sourceWeek, roomId: source.id } }] });
  expect(retry.status).toBe(200);
  expect(retry.body.data).toEqual({ ...first.body.data, replayed: true });
  const substituted = await save({ ...values, entries: [{ ...copied, copyFrom: { ...copied.copyFrom, version: 2 } }] });
  expect(substituted.status).toBe(409);
  expect((await get(target, targetWeek)).body.data).toEqual(first.body.data);
});

test('archived sources remain reusable while archived destinations reject new saves', async () => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Destination' }); const value = await activity();
  const original = await sourcePlan(source, value);
  expect((await request(app).put('/api/rooms/' + source.id).send({ active: false })).status).toBe(200);
  const entries = [copy(source, original, original.entries[0])];
  expect((await save(payload(target, targetWeek, entries))).status).toBe(200);
  expect((await request(app).put('/api/rooms/' + target.id).send({ active: false })).status).toBe(200);
  const blocked = await save(payload(target, targetWeek, entries, { version: 1 }));
  expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('ROOM_ARCHIVED');
  expect((await get(source, sourceWeek)).body.data.entries).toEqual(original.entries);
});

test.each(['current', 'saved'])('%s activity room eligibility prevents unsuitable copies and an explicit catalog replacement can resolve it', async (which) => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Destination' });
  const value = await activity({ roomId: which === 'saved' ? source.id : null });
  const original = await sourcePlan(source, value);
  expect((await request(app).put('/api/activity/' + value.id).send({ version: 1, roomId: which === 'current' ? source.id : null })).status).toBe(200);
  const entries = [copy(source, original, original.entries[0])];
  for (const operation of [preview, save]) {
    const response = await operation(payload(target, targetWeek, entries));
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('ACTIVITY_COPY_UNSUITABLE');
  }
  const replacement = which === 'saved' ? value : await activity({ name: 'Suitable replacement' });
  const replaced = await save(payload(target, targetWeek, [{ ...entries[0], activityId: replacement.id, copyFrom: undefined, useLatest: true, activityVersion: which === 'saved' ? 2 : 1 }]));
  expect(replaced.status).toBe(200); expect(replaced.body.data.entries[0].activity.roomId).toBeNull();
});

test.each(['current', 'saved'])('%s activity age eligibility is required for the full destination room age range', async (which) => {
  const source = await room({ name: 'Source' }); const target = await room({ name: 'Older destination', ageMinMonths: 72, ageMaxMonths: 108 });
  const value = await activity({ ageMinMonths: 18, ageMaxMonths: which === 'saved' ? 72 : 144 });
  const original = await sourcePlan(source, value);
  expect((await request(app).put('/api/activity/' + value.id).send({ version: 1, ageMaxMonths: which === 'current' ? 72 : 144 })).status).toBe(200);
  const response = await save(payload(target, targetWeek, [copy(source, original, original.entries[0])]));
  expect(response.status).toBe(409); expect(response.body.error.code).toBe('ACTIVITY_COPY_UNSUITABLE');
  expect((await get(target, targetWeek)).body.data.entries).toEqual([]);
});

test('unavailable catalog activities require skipping or replacing, while moving a saved entry retains its snapshot', async () => {
  const source = await room(); const target = await room({ name: 'Destination' }); const value = await activity();
  const original = await sourcePlan(source, value);
  const catalog = jest.spyOn(db, 'getActivityById').mockResolvedValue(null);
  try {
    const response = await save(payload(target, targetWeek, [copy(source, original, original.entries[0])]));
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('ACTIVITY_COPY_UNAVAILABLE');
    const moved = await save(payload(source, sourceWeek, [{ ...original.entries[0], activity: undefined, date: '2026-09-15' }], { version: 1 }));
    expect(moved.status).toBe(200);
    expect(moved.body.data.entries[0]).toEqual({ ...original.entries[0], date: '2026-09-15' });
  } finally { catalog.mockRestore(); }
});

test('copy identities, source activity matching and client supplied snapshots cannot be used to overwrite saved details', async () => {
  const source = await room(); const target = await room({ name: 'Destination' }); const value = await activity(); const other = await activity({ name: 'Other' });
  const original = await sourcePlan(source, value);
  const existing = await sourcePlan(target, other);
  const copied = copy(source, original, original.entries[0], sourceWeek);
  const invalid = [
    { ...copied, id: undefined }, { ...copied, id: original.entries[0].id }, { ...copied, id: existing.entries[0].id },
    { ...copied, activityId: other.id }, { ...copied, useLatest: true }, { ...copied, activity: original.entries[0].activity },
    { ...copied, activitySnapshot: original.entries[0].activity }, { ...copied, date: targetWeek },
    { ...copied, copyFrom: null }, { ...copied, copyFrom: { ...copied.copyFrom, version: 0 } },
    { ...copied, copyFrom: { ...copied.copyFrom, version: 1.1 } }, { ...copied, copyFrom: { ...copied.copyFrom, weekStart: '2026-09-15' } },
    { ...copied, copyFrom: { ...copied.copyFrom, roomId: [] } }, { ...copied, copyFrom: { ...copied.copyFrom, entryId: '' } },
    { ...copied, copyFrom: { ...copied.copyFrom, activity: original.entries[0].activity } },
  ];
  for (const candidate of invalid) expect((await save(payload(target, sourceWeek, [candidate], { version: 1 }))).status).toBe(400);
  expect((await get(source, sourceWeek)).body.data).toEqual(original);
  expect((await get(target, sourceWeek)).body.data).toEqual(existing);
});

test('copy saves remain atomic on audit failures and destination conflicts', async () => {
  const source = await room(); const target = await room({ name: 'Destination' }); const value = await activity();
  const original = await sourcePlan(source, value); const copied = copy(source, original, original.entries[0]);
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic reuse audit failure'));
  try { expect((await save(payload(target, targetWeek, [copied]))).status).toBe(500); }
  finally { audit.mockRestore(); }
  expect((await get(target, targetWeek)).body.data).toMatchObject({ version: 0, entries: [] });
  const responses = await Promise.all([save(payload(target, targetWeek, [copied])), save(payload(target, targetWeek, [copy(source, original, original.entries[0])]))]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect((await get(target, targetWeek)).body.data.entries).toHaveLength(1);
  expect((await get(source, sourceWeek)).body.data).toEqual(original);
});
