const { randomUUID } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const weekStart = '2026-10-12';
async function room(values = {}) {
  const response = await request(app).post('/api/rooms').send({ name: 'Automation room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, ...values });
  expect(response.status).toBe(201); return response.body.data;
}
async function activity(values = {}) {
  const response = await request(app).post('/api/activity').send({ name: 'Painting', description: 'Paint autumn leaves.', durationMinutes: 20,
    ageMinMonths: 18, ageMaxMonths: 72, materials: [], ...values });
  expect(response.status).toBe(201); return response.body.data;
}
async function stock(values = {}) {
  const response = await request(app).post('/api/inventory').send({ name: 'Paper', category: 'Art', location: 'Room cupboard', unit: 'count',
    openingQuantity: '10', reorderThreshold: '0', reason: 'Opening count', requestId: randomUUID(), ...values });
  expect(response.status).toBe(201); return response.body.data;
}
const slot = (values = {}) => ({ id: randomUUID(), date: weekStart, startTime: '09:00', endTime: '09:30', ...values });
const entry = (value, values = {}) => ({ id: randomUUID(), date: weekStart, startTime: '08:00', endTime: '08:20', activityId: value.id, activityVersion: value.version, ...values });
const payload = (target, values = {}) => ({ roomId: target.id, weekStart, version: 0, entries: [], slots: [slot()], ...values });
const generate = (values) => request(app).post('/api/schedule/plan/generate').send(values);
const save = (values) => request(app).post('/api/schedule/plan').send({ ...values, requestId: randomUUID() });
const savePayload = (target, entries, values = {}) => ({ roomId: target.id, weekStart, version: 0,
  entries: entries.map(({ activity, ...entry }) => entry), ...values });
const get = (target) => request(app).get('/api/schedule/plan').query({ roomId: target.id, weekStart });

test('generation fills only requested slots from the local catalog, preserves draft choices and requires separate Save', async () => {
  const target = await room(); const retained = await activity({ name: 'Fixed circle time' });
  const painting = await activity({ name: 'Painting' }); const counting = await activity({ name: 'Counting', durationMinutes: 15 });
  const original = entry(retained); const slots = [slot(), slot({ date: '2026-10-13' })];
  const beforeAudits = await db.listAudit({});
  const response = await generate(payload(target, { entries: [original], slots }));
  expect(response.status).toBe(200);
  const data = response.body.data;
  expect(data.entries.find((value) => value.id === original.id)).toMatchObject(original);
  expect(data.generatedIds).toHaveLength(2); expect(data.unfilledSlots).toEqual([]);
  expect(new Set(data.generatedIds).size).toBe(2);
  expect(data.entries.filter((value) => data.generatedIds.includes(value.id)).map((value) => value.activityId).sort()).toEqual([painting.id, counting.id].sort());
  expect(data.generatedSlots.map((value) => value.slotId)).toEqual(slots.map((value) => value.id));
  for (const generated of data.entries.filter((value) => data.generatedIds.includes(value.id))) {
    expect(generated.id).toMatch(/^[a-f0-9-]{36}$/); expect(generated.useLatest).toBe(true); expect(generated.activityVersion).toBe(1);
    expect(generated.endTime).toBe(generated.activity.durationMinutes === 15 ? '09:15' : '09:20');
  }
  expect((await get(target)).body.data).toMatchObject({ version: 0, savedAt: null, entries: [] });
  expect(await db.listAudit({})).toEqual(beforeAudits);
  const saved = await save(savePayload(target, data.entries)); expect(saved.status).toBe(200);
  expect((await get(target)).body.data.entries.map((value) => value.id)).toEqual(data.entries.map((value) => value.id));
});

test('complete room ages, assignment and full durations determine eligibility without shortening activities', async () => {
  const target = await room(); const other = await room({ name: 'Other room' });
  await activity({ name: 'Partial age match', ageMinMonths: 36, ageMaxMonths: 72 });
  await activity({ name: 'Different room', roomId: other.id });
  await activity({ name: 'Too long', durationMinutes: 31 });
  const incomplete = await activity({ name: 'Unknown legacy duration' }); await db.updateActivity(incomplete.id, { durationMinutes: null });
  const suitable = await activity({ name: 'Suitable', durationMinutes: 30 });
  const response = await generate(payload(target)); expect(response.status).toBe(200);
  expect(response.body.data.entries).toMatchObject([{ activityId: suitable.id, startTime: '09:00', endTime: '09:30' }]);
  expect(response.body.data.warnings.join(' ')).toMatch(/duration is missing/);
  const midnight = await generate(payload(target, { slots: [slot({ startTime: '23:30', endTime: '24:00' })] }));
  expect(midnight.body.data.entries[0].endTime).toBe('24:00');
});

test('least recently saved activity use is specific to the room and ignores future weeks', async () => {
  const target = await room(); const other = await room({ name: 'Other room' });
  const recent = await activity({ name: 'A recently used' }); const old = await activity({ name: 'B older activity' }); const unseen = await activity({ name: 'C unseen activity' });
  for (const [selectedRoom, activityValue, date] of [[target, recent, '2026-10-05'], [target, recent, '2026-09-28'], [target, old, '2026-09-21'], [other, unseen, '2026-10-05'], [target, unseen, '2026-10-19']]) {
    expect((await save(savePayload(selectedRoom, [entry(activityValue, { date })], { weekStart: date }))).status).toBe(200);
  }
  const response = await generate(payload(target, { slots: [slot(), slot({ date: '2026-10-13' }), slot({ date: '2026-10-14' })] }));
  expect(response.status).toBe(200);
  expect(response.body.data.entries.map((value) => value.activityId)).toEqual([unseen.id, old.id, recent.id]);
  expect(await db.listActivityUseBefore(target.id, weekStart)).toEqual(expect.arrayContaining([{ activityId: recent.id, lastUsed: '2026-10-05' }]));
});

test('repeats are opt-in and excluded activities never replace or alter preserved drafts', async () => {
  const target = await room(); const first = await activity({ name: 'A retained' }); const second = await activity({ name: 'B available' });
  const existing = entry(first); const slots = [slot(), slot({ date: '2026-10-13' })];
  const noRepeats = await generate(payload(target, { entries: [existing], slots }));
  expect(noRepeats.body.data.generatedIds).toHaveLength(1); expect(noRepeats.body.data.unfilledSlots[0].reason).toMatch(/No unused activities/);
  const repeats = await generate(payload(target, { entries: [existing], slots, allowRepeats: true }));
  expect(repeats.body.data.generatedIds).toHaveLength(2);
  expect(repeats.body.data.entries.filter((value) => repeats.body.data.generatedIds.includes(value.id)).map((value) => value.activityId)).toEqual([second.id, first.id]);
  const excluded = await generate(payload(target, { entries: [existing], slots, excludeActivityIds: [second.id], allowRepeats: true }));
  expect(excluded.body.data.entries.find((value) => value.id === existing.id).activityId).toBe(first.id);
  expect(excluded.body.data.entries.filter((value) => excluded.body.data.generatedIds.includes(value.id)).every((value) => value.activityId === first.id)).toBe(true);
});

test('timed entries block their actual occupied interval and legacy entries block their whole date', async () => {
  const target = await room(); const fixed = await activity({ name: 'Fixed routine' }); const small = await activity({ name: 'Small', durationMinutes: 10 });
  const timed = entry(fixed, { startTime: '09:15', endTime: '09:30' });
  const response = await generate(payload(target, { entries: [timed] }));
  expect(response.body.data.generatedIds).toHaveLength(1); expect(response.body.data.entries[0]).toMatchObject({ activityId: small.id, endTime: '09:10' });
  const overlaps = await generate(payload(target, { entries: [timed], slots: [slot({ startTime: '09:10' })] }));
  expect(overlaps.body.data.generatedIds).toEqual([]); expect(overlaps.body.data.entries).toHaveLength(1);
  expect(overlaps.body.data.unfilledSlots[0].reason).toMatch(/overlaps/);
  const legacy = entry(fixed, { startTime: null, endTime: null, timeBlock: 'morning' });
  const blocked = await generate(payload(target, { entries: [legacy] }));
  expect(blocked.body.data.generatedIds).toEqual([]); expect(blocked.body.data.entries[0]).toMatchObject({ id: legacy.id, timeBlock: 'morning' });
});

test('only explicitly selected entries are replaced, and incomplete replacements retain every original', async () => {
  const target = await room(); const fixed = await activity({ name: 'Fixed routine' }); const alternative = await activity({ name: 'Alternative' });
  const original = entry(fixed, { startTime: '09:00', endTime: '09:20' });
  const valid = await generate(payload(target, { entries: [original], replaceEntryIds: [original.id], excludeActivityIds: [fixed.id] }));
  expect(valid.status).toBe(200); expect(valid.body.data.entries).toMatchObject([{ activityId: alternative.id }]);
  expect(valid.body.data.entries[0].id).not.toBe(original.id);
  const failed = await generate(payload(target, { entries: [original], replaceEntryIds: [original.id], excludeActivityIds: [fixed.id, alternative.id] }));
  expect(failed.body.data.entries).toMatchObject([{ id: original.id, activityId: fixed.id }]);
  expect(failed.body.data.generatedIds).toEqual([]); expect(failed.body.data.warnings.join(' ')).toMatch(/were kept/);
  const partial = await generate(payload(target, { entries: [original], replaceEntryIds: [original.id], excludeActivityIds: [fixed.id],
    slots: [slot(), slot({ date: '2026-10-13', endTime: '09:01' })] }));
  expect(partial.body.data.generatedIds).toEqual([]);
  expect(partial.body.data.entries).toMatchObject([{ id: original.id, activityId: fixed.id }]);
  expect(partial.body.data.unfilledSlots).toHaveLength(2); expect(partial.body.data.generatedSlots).toEqual([]);
  const nextDay = entry(alternative, { date: '2026-10-13', startTime: '09:00', endTime: '09:20' });
  const twoOriginals = await generate(payload(target, { entries: [original, nextDay], replaceEntryIds: [original.id, nextDay.id],
    slots: [slot(), slot({ date: '2026-10-13', endTime: '09:01' })] }));
  expect(twoOriginals.body.data.generatedIds).toEqual([]);
  expect(twoOriginals.body.data.entries).toMatchObject([{ id: original.id, activityId: fixed.id }, { id: nextDay.id, activityId: alternative.id }]);
  expect((await get(target)).body.data.entries).toEqual([]);
});

test('consumables sum while reusable equipment uses peak simultaneous demand and generation never mutates stock', async () => {
  const target = await room(); const paper = await stock({ name: 'Paper', openingQuantity: '1' }); const tools = await stock({ name: 'Tools', openingQuantity: '4' });
  const value = await activity({ materials: [{ itemId: paper.id, unit: 'count', quantity: '2', reusable: false },
    { itemId: tools.id, unit: 'count', quantity: '3', reusable: true }] });
  const existing = [entry(value, { startTime: '08:00', endTime: '08:20' }), entry(value, { startTime: '08:10', endTime: '08:30' })];
  const before = await db.getInventoryById(paper.id); const audits = await db.listAudit({});
  const response = await generate(payload(target, { entries: existing, slots: [slot(), slot({ date: '2026-10-13' })], allowRepeats: true }));
  expect(response.status).toBe(200);
  expect(response.body.data.materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: paper.id, needed: '8', available: '1', shortage: '7' }),
    expect.objectContaining({ itemId: tools.id, needed: '6', available: '4', shortage: '2' }),
  ]));
  expect(response.body.data.warnings.join(' ')).toMatch(/Other rooms/);
  expect(await db.getInventoryById(paper.id)).toEqual(before); expect(await db.countInventoryMovements(paper.id)).toBe(1);
  expect(await db.listAudit({})).toEqual(audits); expect((await get(target)).body.data.entries).toEqual([]);
});

test('unknown and changed material units are surfaced instead of claiming availability', async () => {
  const target = await room(); const material = await stock();
  const value = await activity({ materials: [{ itemId: material.id, unit: 'count', quantity: '1', reusable: false }], materialsNotes: 'Also use a classroom prop.' });
  await db.updateInventory(material.id, { unit: 'pack' });
  const response = await generate(payload(target)); expect(response.status).toBe(200);
  expect(response.body.data.materials[0]).toMatchObject({ available: '0', shortage: '1', issue: 'Inventory unit changed. Update the activity material.' });
  const notes = await activity({ name: 'A notes-only activity', materialsNotes: 'Use art supplies without measured amounts.' });
  const unknown = await generate(payload(target, { excludeActivityIds: [value.id] }));
  expect(unknown.body.data.entries[0].activityId).toBe(notes.id);
  expect(unknown.body.data.warnings.join(' ')).toMatch(/availability cannot be checked/);
});

test('saved snapshots remain unchanged while generated catalog choices reject stale Save versions', async () => {
  const target = await room(); const first = await activity({ name: 'A original routine' }); const other = await activity({ name: 'B other' });
  const saved = await save(savePayload(target, [entry(first)])); expect(saved.status).toBe(200);
  expect((await request(app).put('/api/activity/' + first.id).send({ name: 'Changed routine', version: 1 })).status).toBe(200);
  const response = await generate(payload(target, { version: 1, entries: saved.body.data.entries.map(({ activity, ...entry }) => entry) }));
  expect(response.status).toBe(200); expect(response.body.data.entries[0].activity.name).toBe(first.name);
  expect(response.body.data.entries[1].activityId).toBe(other.id);
  expect((await request(app).put('/api/activity/' + other.id).send({ name: 'Changed suggestion', version: 1 })).status).toBe(200);
  expect((await save(savePayload(target, response.body.data.entries, { version: 1 }))).status).toBe(409);
  expect((await get(target)).body.data.entries).toEqual(saved.body.data.entries);
  expect((await generate(payload(target, { version: 0 }))).status).toBe(409);
});

test('unsaved copied entries keep their server-owned source snapshot and provenance through generation', async () => {
  const target = await room(); const source = await room({ name: 'Source room' }); const first = await activity();
  const original = await save(savePayload(source, [entry(first)], { weekStart: '2026-10-05', entries: [entry(first, { date: '2026-10-05' })] }));
  expect(original.status).toBe(200);
  expect((await request(app).put('/api/activity/' + first.id).send({ name: 'Current catalog', version: 1 })).status).toBe(200);
  const copied = entry(first, { activityVersion: 2, copyFrom: { roomId: source.id, weekStart: '2026-10-05', version: 1, entryId: original.body.data.entries[0].id } });
  await activity({ name: 'Other activity' });
  const response = await generate(payload(target, { entries: [copied] })); expect(response.status).toBe(200);
  const retained = response.body.data.entries.find((value) => value.id === copied.id);
  expect(retained.copyFrom).toEqual(copied.copyFrom); expect(retained.activity.name).toBe(first.name); expect(retained.activityVersion).toBe(2);
  const saved = await save(savePayload(target, response.body.data.entries)); expect(saved.status).toBe(200);
  expect(saved.body.data.entries[0].activity.name).toBe(first.name);
  const stale = await generate(payload(target, { version: 1, entries: [{ ...copied, id: randomUUID(), copyFrom: { ...copied.copyFrom, version: 2 } }] }));
  expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('ACTIVITY_COPY_SOURCE_CONFLICT');
});

test.each([
  { slots: [] }, { slots: [slot({ startTime: '9:00' })] }, { slots: [slot({ endTime: '09:00' })] },
  { slots: [slot({ date: '2026-10-19' })] }, { slots: [slot({ activity: { id: 'client supplied' } })] },
  { slots: [slot({ id: 'same' }), slot({ id: 'same' })] }, { version: undefined }, { allowRepeats: 'yes' },
  { replaceEntryIds: ['missing-draft-entry'] }, { excludeActivityIds: ['', 'invalid'] }, { excludeActivityIds: ['same', 'same'] },
  { actorId: 'spoofed' }, { slots: Array.from({ length: 141 }, () => slot()) },
])('invalid generation payload %j is rejected without saving', async (invalid) => {
  const target = await room(); await activity();
  expect((await generate(payload(target, invalid))).status).toBe(400);
  expect((await get(target)).body.data).toMatchObject({ entries: [], version: 0 });
});

test('generation rejects client snapshots, foreign scheduled identities and stale unsaved activity versions', async () => {
  const target = await room(); const other = await room({ name: 'Other' }); const first = await activity();
  const foreign = entry(first); expect((await save(savePayload(other, [foreign]))).status).toBe(200);
  expect((await generate(payload(target, { entries: [foreign] }))).status).toBe(409);
  expect((await generate(payload(target, { entries: [entry(first, { activity: first })] }))).status).toBe(400);
  await db.updateActivity(first.id, { version: 2 });
  expect((await generate(payload(target, { entries: [entry(first)] }))).status).toBe(409);
  expect((await get(target)).body.data.entries).toEqual([]);
});

test('archived or unconfigured rooms reject generation, editors can generate and viewers cannot', async () => {
  const target = await room(); await activity();
  // Legacy rooms can predate the strict database constraint. Simulate reads of
  // those rows rather than inserting invalid new rooms into PostgreSQL.
  for (const invalid of [{ ageMaxMonths: null }, { ageMinMonths: null }, { ageMinMonths: 60 }, { ageMinMonths: 72 }]) {
    const legacy = jest.spyOn(db, 'getRoomById').mockResolvedValueOnce({ ...target, ...invalid });
    try { expect((await generate(payload(target))).status).toBe(409); }
    finally { legacy.mockRestore(); }
  }
  await db.updateRoom(target.id, { active: false });
  const archived = await generate(payload(target)); expect(archived.status).toBe(409); expect(archived.body.error.code).toBe('ROOM_ARCHIVED');
  await db.updateRoom(target.id, { active: true });
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  expect((await generate(payload(target))).status).toBe(200);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await generate(payload(target))).status).toBe(403);
  expect((await request(app).post('/api/schedule/plan/preview').send({ roomId: target.id, weekStart, version: 0, entries: [] })).status).toBe(403);
  expect((await anonymous(app).post('/api/schedule/plan/generate').set('Origin', request.origin).send(payload(target))).status).toBe(401);
});
