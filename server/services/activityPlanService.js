const { randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const { requireRoom } = require('./roomService');
const { problem, validateWeekStart } = require('./planValidation');
const { dateOnly } = require('./roomValidation');
const v = require('./activityValidation');
const { amount, decimal, requestId } = require('./inventoryValidation');
const generation = require('./activityPlanGeneration');

const lock = (fn) => db.withRoomLock(() => db.withInventoryLock(fn));
const legacyKey = (entry) => entry.date + ':' + entry.timeBlock;
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const sortKey = (entry) => entry.date + ':' + (entry.startTime || '25:' + ({ morning: '01', midday: '02', afternoon: '03' }[entry.timeBlock] || '04')) + ':' + (entry.id || '');
const fallback = (id) => ({ id, name: 'Unavailable activity', description: '', durationMinutes: null,
  ageMinMonths: null, ageMaxMonths: null, roomId: null, materials: [], version: 0 });
const copyProblem = (message, code) => Object.assign(problem(message, 409), { code });
async function stored(roomId, weekStart) {
  const [header, rows] = await Promise.all([db.getScheduleWeek(roomId, weekStart), db.listScheduleEntries(roomId, weekStart)]);
  const entries = await Promise.all(rows.map(async (row) => ({ id: row.id, date: row.date,
    startTime: row.startTime || null, endTime: row.endTime || null, timeBlock: row.timeBlock || null, activityId: row.activityId,
    activity: row.activitySnapshot || v.snapshot(await db.getActivityById(row.activityId)) || fallback(row.activityId) })));
  entries.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { id: roomId + ':' + weekStart, roomId, weekStart, version: header?.version || 0, savedAt: header?.savedAt || null, entries };
}
function entryValues(entries, weekStart) {
  if (!Array.isArray(entries)) throw problem('Supply the activities for this week.');
  const end = new Date(weekStart + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 7);
  const seen = new Set();
  return entries.map((entry) => {
    v.object(entry, ['id', 'date', 'startTime', 'endTime', 'timeBlock', 'activityId', 'useLatest', 'activityVersion', 'copyFrom']);
    dateOnly(entry.date);
    if (entry.date < weekStart || entry.date >= end.toISOString().slice(0, 10)) throw problem('Choose a date within the selected week.');
    if (entry.id != null) v.identifier(entry.id, 'id');
    const untimed = entry.startTime == null && entry.endTime == null;
    if (untimed) {
      // Compatibility for existing block schedules, including older API clients.
      if (!['morning', 'midday', 'afternoon'].includes(entry.timeBlock)) throw problem('Enter a start and end time for each activity.');
    } else {
      if (typeof entry.startTime !== 'string' || !clock.test(entry.startTime) || typeof entry.endTime !== 'string' ||
          (!clock.test(entry.endTime) && entry.endTime !== '24:00') || entry.endTime <= entry.startTime) {
        throw problem('Enter valid start and end times, with the end after the start on the same day.');
      }
      if (!entry.id) throw problem('Each scheduled activity needs an identifier.');
      if (entry.timeBlock != null) throw problem('Use clock times for a timed activity.');
    }
    v.identifier(entry.activityId);
    if (entry.useLatest !== undefined && typeof entry.useLatest !== 'boolean') throw problem('Invalid activity update choice.');
    if (entry.activityVersion != null && (!Number.isInteger(entry.activityVersion) || entry.activityVersion < 1)) throw problem('Invalid activity version.');
    let copyFrom;
    if (entry.copyFrom !== undefined) {
      v.object(entry.copyFrom, ['roomId', 'weekStart', 'version', 'entryId']);
      v.identifier(entry.copyFrom.roomId, 'copyFrom'); validateWeekStart(entry.copyFrom.weekStart);
      v.identifier(entry.copyFrom.entryId, 'copyFrom');
      if (!Number.isInteger(entry.copyFrom.version) || entry.copyFrom.version < 1 || entry.copyFrom.version >= 2147483647) throw problem('Reload the saved source week before copying activities.');
      if (!entry.id || entry.id === entry.copyFrom.entryId) throw problem('A copied activity needs a new scheduled identifier.');
      if (entry.useLatest === true) throw problem('Choose either the saved activity copy or the latest catalog activity.');
      copyFrom = { roomId: entry.copyFrom.roomId, weekStart: entry.copyFrom.weekStart, version: entry.copyFrom.version, entryId: entry.copyFrom.entryId };
    }
    const identity = entry.id ? 'id:' + entry.id : 'legacy:' + legacyKey(entry);
    if (seen.has(identity)) throw problem('A scheduled activity identifier cannot be repeated.');
    seen.add(identity);
    return { id: entry.id || null, date: entry.date, startTime: untimed ? null : entry.startTime, endTime: untimed ? null : entry.endTime,
      timeBlock: untimed ? entry.timeBlock : null, activityId: entry.activityId, useLatest: entry.useLatest === true, activityVersion: entry.activityVersion ?? null,
      ...(copyFrom ? { copyFrom } : {}) };
  }).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}
async function resolve(room, previous, entries) {
  const saved = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const legacy = new Map(previous.entries.filter((entry) => !entry.startTime).map((entry) => [legacyKey(entry), entry]));
  const sources = new Map();
  const sourceWeek = (source) => {
    const key = source.roomId + ':' + source.weekStart;
    if (!sources.has(key)) sources.set(key, stored(source.roomId, source.weekStart));
    return sources.get(key);
  };
  const resolved = await Promise.all(entries.map(async (entry) => {
    const retained = entry.id ? saved.get(entry.id) : legacy.get(legacyKey(entry));
    if (entry.copyFrom && retained) throw problem('A copied activity needs a new scheduled identifier.');
    if (entry.id && !retained && await db.getScheduleEntryById(entry.id)) throw problem('This scheduled activity belongs to a different room or week. Add it as a new entry here.', 409);
    const values = { id: retained?.id || entry.id || randomUUID(), date: entry.date, startTime: entry.startTime, endTime: entry.endTime,
      timeBlock: entry.timeBlock, activityId: entry.activityId };
    if (entry.copyFrom) {
      // Provenance identifies server-owned saved details. The client supplies no
      // activity snapshot, and the source is never rewritten by a copy.
      const source = await sourceWeek(entry.copyFrom);
      const original = source.entries.find((value) => value.id === entry.copyFrom.entryId);
      if (source.version !== entry.copyFrom.version || !original) throw copyProblem('The source week changed. Reload it and choose the activities to copy again.', 'ACTIVITY_COPY_SOURCE_CONFLICT');
      if (original.activityId !== entry.activityId) throw problem('The copied activity does not match its saved source. Reload the source week.');
      const activity = await db.getActivityById(entry.activityId);
      if (!activity) throw copyProblem('A copied activity is no longer available. Skip it or replace it with an available activity.', 'ACTIVITY_COPY_UNAVAILABLE');
      if (!v.suitable(original.activity, room) || !v.suitable(activity, room)) throw copyProblem('A copied activity is not suitable for this room and its age range. Skip it or choose a suitable replacement.', 'ACTIVITY_COPY_UNSUITABLE');
      if (entry.activityVersion != null && activity.version !== entry.activityVersion) throw problem('An activity changed elsewhere. Refresh activities and choose its updated version.', 409);
      return { ...values, activity: original.activity };
    }
    // Moving or resizing an existing entry preserves its saved details.
    if (retained?.activityId === entry.activityId && !entry.useLatest) return { ...values, activity: retained.activity };
    const activity = await db.getActivityById(entry.activityId);
    if (!activity || !v.suitable(activity, room)) throw problem('Choose an activity suitable for this room and its age range.');
    if (entry.activityVersion != null && activity.version !== entry.activityVersion) throw problem('An activity changed elsewhere. Refresh activities and choose its updated version.', 409);
    return { ...values, activity: v.snapshot(activity) };
  }));
  if (new Set(resolved.map((entry) => entry.id)).size !== resolved.length) throw problem('A scheduled activity identifier cannot be repeated.');
  return resolved;
}
// Consumables add across the week. Reusable equipment can be used again after
// an activity ends, but simultaneous activities need their combined quantities.
// Unknown legacy times conservatively occupy that whole day, not invented hours.
async function materials(entries) {
  const totals = new Map();
  for (const entry of entries) for (const material of entry.activity.materials || []) {
    const id = material.itemId + ':' + material.unit;
    const row = totals.get(id) || { ...material, consumed: 0n, events: new Map() };
    const quantity = amount(material.quantity);
    if (material.reusable) {
      const events = row.events.get(entry.date) || new Map();
      const start = entry.startTime ? minutes(entry.startTime) : 0;
      const end = entry.endTime ? minutes(entry.endTime) : 1440;
      events.set(start, (events.get(start) || 0n) + quantity);
      events.set(end, (events.get(end) || 0n) - quantity);
      row.events.set(entry.date, events);
    } else row.consumed += quantity;
    totals.set(id, row);
  }
  return Promise.all([...totals.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(async (row) => {
    let reused = 0n;
    for (const events of row.events.values()) {
      let current = 0n;
      for (const [, change] of [...events].sort(([a], [b]) => a - b)) { current += change; if (current > reused) reused = current; }
    }
    const stock = await db.getInventoryById(row.itemId);
    const issue = !stock ? 'Item is no longer in Inventory.' : stock.unit !== row.unit ? 'Inventory unit changed. Update the activity material.' : null;
    const needed = row.consumed + reused;
    const available = issue ? 0n : amount(stock.quantity);
    return { itemId: row.itemId, name: row.name, location: stock?.location || row.location, unit: row.unit,
      needed: decimal(needed), available: decimal(available), shortage: decimal(needed > available ? needed - available : 0n), issue };
  }));
}
async function result(plan) { return { ...plan, materials: await materials(plan.entries) }; }
exports.get = (roomId, weekStart) => lock(async () => {
  await requireRoom(roomId); validateWeekStart(weekStart);
  return result(await stored(roomId, weekStart));
});
exports.preview = (payload) => lock(async () => {
  v.object(payload, ['roomId', 'weekStart', 'entries', 'version']);
  const room = await requireRoom(payload.roomId); validateWeekStart(payload.weekStart);
  const previous = await stored(room.id, payload.weekStart);
  if (payload.version !== undefined) v.version(payload.version, previous.version, 'week');
  const entries = await resolve(room, previous, entryValues(payload.entries, payload.weekStart));
  return { materials: await materials(entries) };
});
exports.generate = (payload) => lock(async () => {
  v.object(payload, ['roomId', 'weekStart', 'version', 'entries', 'slots', 'replaceEntryIds', 'allowRepeats', 'excludeActivityIds']);
  const room = await requireRoom(payload.roomId, { active: true }); validateWeekStart(payload.weekStart);
  if (![room.ageMinMonths, room.ageMaxMonths].every((value) => Number.isInteger(value) && value >= 0 && value <= 216) || room.ageMaxMonths <= room.ageMinMonths) {
    throw problem('Configure this room\'s full age range before generating activities.', 409);
  }
  const previous = await stored(room.id, payload.weekStart);
  v.version(payload.version, previous.version, 'week');
  if (payload.allowRepeats !== undefined && typeof payload.allowRepeats !== 'boolean') throw problem('Choose whether activity repeats are allowed.');
  const selectedSlots = generation.slots(payload.slots, payload.weekStart);
  const replaceEntryIds = new Set(generation.identifiers(payload.replaceEntryIds, 'replacement'));
  const excludeActivityIds = generation.identifiers(payload.excludeActivityIds, 'excluded activity');
  if (!Array.isArray(payload.entries) || payload.entries.length > 1000) throw problem('Supply up to 1,000 existing draft entries for generation.');
  const normalized = entryValues(payload.entries, payload.weekStart);
  for (const id of replaceEntryIds) if (!normalized.some((entry) => entry.id === id)) throw problem('Choose replacements from the current draft.');
  const resolved = await resolve(room, previous, normalized);
  const values = new Map(normalized.map((entry) => [entry.id, entry]));
  const legacyValues = new Map(normalized.filter((entry) => !entry.id).map((entry) => [legacyKey(entry), entry]));
  const draft = resolved.map((entry) => {
    const choices = values.get(entry.id) || legacyValues.get(legacyKey(entry));
    return { ...entry, ...(choices?.useLatest ? { useLatest: true } : {}),
      ...(choices?.activityVersion != null ? { activityVersion: choices.activityVersion } : {}),
      ...(choices?.copyFrom ? { copyFrom: choices.copyFrom } : {}) };
  });
  let retained = draft.filter((entry) => !replaceEntryIds.has(entry.id));
  const [catalog, history] = await Promise.all([db.listActivities(), db.listActivityUseBefore(room.id, payload.weekStart)]);
  const proposed = generation.generate({ room, catalog, history, entries: retained, selectedSlots,
    allowRepeats: payload.allowRepeats === true, excludeActivityIds });
  if (replaceEntryIds.size && proposed.unfilledSlots.length) {
    // Partial replacement must not erase routines merely because the catalog
    // cannot fill a slot. Restore all selected originals, keeping only safe,
    // non-repeating suggestions that can coexist with the restored draft.
    const restored = draft.filter((entry) => replaceEntryIds.has(entry.id));
    retained = draft;
    const removed = new Set(proposed.generated.filter((entry) => restored.some((original) => generation.overlaps(entry, original) ||
      payload.allowRepeats !== true && entry.activityId === original.activityId)).map((entry) => entry.id));
    for (const mapping of proposed.generatedSlots.filter((value) => removed.has(value.entryId))) {
      const slot = selectedSlots.find((value) => value.id === mapping.slotId);
      proposed.unfilledSlots.push({ ...slot, reason: 'The existing activities were kept because replacements were incomplete. This suggestion conflicts with a retained activity.' });
    }
    proposed.generated = proposed.generated.filter((entry) => !removed.has(entry.id));
    proposed.generatedSlots = proposed.generatedSlots.filter((value) => !removed.has(value.entryId));
    proposed.warnings.push('Some replacement slots could not be filled. All existing activities selected for replacement were kept. Review the remaining suggestions before applying them.');
  }
  const entries = [...retained, ...proposed.generated].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const materialChecks = await materials(entries);
  if (materialChecks.length) proposed.warnings.push('Material checks cover this room only. Other rooms may need the same stock.');
  if (materialChecks.some((item) => item.issue || amount(item.shortage) > 0n)) proposed.warnings.push('This draft needs unavailable materials or has changed inventory units. Review the material checks before saving.');
  return { entries, generatedIds: proposed.generated.map((entry) => entry.id), generatedSlots: proposed.generatedSlots,
    unfilledSlots: proposed.unfilledSlots, materials: materialChecks, warnings: proposed.warnings };
});
exports.save = (payload) => lock(async () => {
  v.object(payload, ['roomId', 'weekStart', 'entries', 'version', 'requestId']);
  const room = await requireRoom(payload.roomId, { active: true }); validateWeekStart(payload.weekStart);
  requestId(payload);
  const normalized = entryValues(payload.entries, payload.weekStart);
  const request = { version: payload.version, entries: normalized };
  const header = await db.getScheduleWeek(room.id, payload.weekStart);
  const previous = await stored(room.id, payload.weekStart);
  if (header?.requestId === payload.requestId) {
    // Canonicalization also allows a lost response from before the timed upgrade
    // to be retried; JSONB does not preserve object key order.
    if (header.request?.version !== request.version || JSON.stringify(entryValues(header.request.entries, payload.weekStart)) !== JSON.stringify(normalized)) throw problem('This save identifier was already used for different choices.', 409);
    return { ...await result(previous), replayed: true };
  }
  v.version(payload.version, previous.version, 'week');
  const entries = await resolve(room, previous, normalized);
  await db.saveScheduleEntries(room.id, payload.weekStart, entries.map(({ activity, ...entry }) => ({ ...entry, activitySnapshot: activity })));
  await db.saveScheduleWeek({ roomId: room.id, weekStart: payload.weekStart, version: previous.version + 1,
    savedAt: new Date().toISOString(), requestId: payload.requestId, request });
  return result(await stored(room.id, payload.weekStart));
});
