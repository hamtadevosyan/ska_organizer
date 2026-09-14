const db = require('./dbAdapter');
const rooms = require('./roomService');
const time = require('./facilityTime');
const { problem } = require('./planValidation');
const fail = (message, code = 'ATTENDANCE_CONFLICT') => Object.assign(problem(message, 409), { code });
function identifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw problem(name + ' is required.');
  return value.trim();
}
function currentDate(expected, now = new Date()) {
  const today = time.dateAt(now);
  if (expected !== undefined && time.validateDate(expected) !== today) throw fail('The facility date has changed. Refresh attendance before recording this action.', 'ATTENDANCE_DATE_CHANGED');
  return today;
}
function requestId(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw problem('Invalid attendance request identifier.');
  return value;
}
exports.config = () => ({ timeZone: time.timeZone(), today: time.dateAt(), serverNow: new Date().toISOString() });
exports.listAttendance = ({ date, roomId, childId } = {}) => {
  if (date !== undefined) time.validateDate(date);
  if (roomId !== undefined) identifier(roomId, 'Room');
  if (childId !== undefined) identifier(childId, 'Child');
  return db.listAttendance({ date, roomId, childId });
};
exports.getById = (id) => db.getAttendanceById(identifier(id, 'Attendance ID'));
exports.checkIn = ({ childId, roomId, recordedBy, date, requestId: suppliedRequestId }) => db.withRoomLock(async () => {
  childId = identifier(childId, 'Child'); roomId = identifier(roomId, 'Room');
  const key = requestId(suppliedRequestId);
  if (key) {
    const previous = await db.getAttendanceByRequestId(key);
    if (previous) {
      if (previous.childId !== childId || previous.roomId !== roomId || previous.recordedBy !== recordedBy) throw fail('This request identifier belongs to another check-in.');
      return previous;
    }
  }
  currentDate(date);
  await rooms.requireRoom(roomId, { active: true });
  const child = await db.getChildById(childId);
  if (!child) throw problem('Child not found.', 404);
  if (!child.active) throw fail('This child is not actively enrolled. Reactivate enrollment before checking in.', 'CHILD_INACTIVE');
  if (child.roomId && child.roomId !== roomId) throw fail('The child is assigned to another room. Refresh the roster or update their assignment first.');
  const open = await db.listAttendance({ childId, openOnly: true, includeVoided: false });
  if (open.length > 1 || open.some((record) => record.needsReview || !record.checkIn || !Number.isFinite(new Date(record.checkIn).getTime()) || new Date(record.checkIn).getTime() > Date.now())) throw fail('Review the existing open attendance records before checking in again.', 'ATTENDANCE_REVIEW_REQUIRED');
  if (open.length) {
    if (open[0].roomId !== roomId) throw fail('This child is already checked in to another room. Check out that visit first.');
    return open[0];
  }
  return db.createAttendance({ childId, roomId, recordedBy, requestId: key, checkIn: new Date().toISOString() });
});
exports.checkOut = (id, { date, version } = {}) => db.withRoomLock(async () => {
  const previous = await exports.getById(id);
  if (!previous) return null;
  if (previous.voided) throw fail('This attendance record was voided. Refresh the roster.');
  if (previous.checkOut) return previous;
  const now = new Date(); currentDate(date, now);
  if (version !== undefined && version !== previous.version) throw fail('Attendance changed elsewhere. Refresh before trying again.');
  if (!previous.checkIn || !Number.isFinite(new Date(previous.checkIn).getTime()) || new Date(previous.checkIn) > now) throw fail('Correct the check-in time before checking out.', 'ATTENDANCE_REVIEW_REQUIRED');
  return db.updateAttendance(id, { checkOut: now.toISOString(), version: previous.version + 1, needsReview: false });
});
const snapshot = (record) => JSON.parse(JSON.stringify(Object.fromEntries(
  ['childId', 'roomId', 'checkIn', 'checkOut', 'recordedBy', 'voided', 'needsReview', 'version'].map((key) => [key, record[key] ?? null]),
)));
exports.corrections = async (id) => {
  if (!await exports.getById(id)) throw problem('Attendance record not found.', 404);
  return db.listAttendanceCorrections(id);
};
exports.correct = (id, input, account) => db.withRoomLock(async () => {
  const previous = await exports.getById(id);
  if (!previous) throw problem('Attendance record not found.', 404);
  const allowed = ['roomId', 'checkIn', 'checkOut', 'checkInOccurrence', 'checkOutOccurrence', 'voided', 'version', 'reason'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw problem('Invalid attendance correction.');
  if (!Number.isSafeInteger(input.version) || input.version !== previous.version) throw fail('Attendance changed elsewhere. Reload the correction form before saving.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 1000) throw problem('Explain the correction in 1 to 1000 characters.');
  if (input.voided !== undefined && typeof input.voided !== 'boolean') throw problem('Voided must be true or false.');
  for (const key of ['checkInOccurrence', 'checkOutOccurrence']) if (input[key] !== undefined && !['earlier', 'later', ''].includes(input[key])) throw problem('Choose the first or second occurrence of the time.');
  const changes = { version: previous.version + 1, voided: input.voided ?? previous.voided, needsReview: false };
  if (changes.voided) {
    if (previous.voided) throw problem('This record is already voided.');
  } else {
    changes.roomId = input.roomId === undefined ? previous.roomId : identifier(input.roomId, 'Room');
    if (!changes.roomId) throw problem('Choose the room where attendance occurred.');
    await rooms.requireRoom(changes.roomId);
    const originalStart = previous.checkIn && Number.isFinite(new Date(previous.checkIn).getTime()) ? new Date(previous.checkIn).toISOString() : null;
    changes.checkIn = time.resolveTime(input.checkIn === undefined ? originalStart : input.checkIn, input.checkInOccurrence);
    changes.checkOut = input.checkOut === undefined ? previous.checkOut : input.checkOut;
    if (changes.checkOut !== null && changes.checkOut !== '') changes.checkOut = time.resolveTime(String(changes.checkOut instanceof Date ? changes.checkOut.toISOString() : changes.checkOut), input.checkOutOccurrence);
    else changes.checkOut = null;
    const start = new Date(changes.checkIn).getTime();
    const end = changes.checkOut ? new Date(changes.checkOut).getTime() : Infinity;
    if (start > Date.now() || (Number.isFinite(end) && end > Date.now())) throw problem('Attendance times cannot be in the future.');
    if (end < start) throw problem('Check-out cannot be before check-in.');
    const other = (await db.listAttendance({ childId: previous.childId, includeVoided: false })).filter((record) => record.id !== id);
    if (other.some((record) => !record.checkIn && !record.checkOut)) throw fail('Void or correct the other record with an unknown check-in time first.', 'ATTENDANCE_REVIEW_REQUIRED');
    if (other.some((record) => {
      const otherStart = new Date(record.checkIn).getTime();
      const otherEnd = record.checkOut ? new Date(record.checkOut).getTime() : Infinity;
      return (end === Infinity && otherEnd === Infinity) || (start < otherEnd && otherStart < end);
    })) throw fail('This correction overlaps another visit for the child. Review or void the mistaken record first.');
  }
  const updated = await db.updateAttendance(id, changes);
  await db.createAttendanceCorrection({ attendanceId: id, before: snapshot(previous), after: snapshot(updated),
    reason, actorId: account.id, actorUsername: account.username, occurredAt: new Date().toISOString() });
  return updated;
});
const validOpen = (record, now) => !record.voided && !record.checkOut && record.checkIn && new Date(record.checkIn) <= now;
exports.dailyRoster = ({ roomId, date } = {}) => db.withRoomLock(async () => {
  const now = new Date();
  const config = { timeZone: time.timeZone(), today: time.dateAt(now), serverNow: now.toISOString() };
  date = date === undefined ? config.today : time.validateDate(date);
  if (date > config.today) throw problem('Choose today or an earlier attendance date.');
  const room = roomId ? await rooms.requireRoom(roomId) : null;
  const availableRooms = await db.listRooms({ includeArchived: true });
  const isToday = date === config.today;
  const records = await db.listAttendance({ roomId, date });
  const open = await db.listAttendance({ openOnly: true, includeVoided: false });
  const review = isToday ? await db.listAttendance({ roomId, needsReview: true, includeVoided: false }) : [];
  const recordsById = new Map([...records, ...review, ...(isToday ? open.filter((r) => !roomId || r.roomId === roomId) : [])].map((r) => [r.id, r]));
  const children = new Map();
  if (isToday) {
    const total = await db.countChildren({ roomId, active: true });
    for (const child of await db.listChildren({ roomId, active: true, pageSize: Math.max(1, total) })) children.set(child.id, child);
  }
  for (const record of recordsById.values()) if (!children.has(record.childId)) children.set(record.childId, await db.getChildById(record.childId));
  const rows = [...children].map(([childId, child]) => {
    const visits = [...recordsById.values()].filter((r) => r.childId === childId);
    const openVisits = isToday ? open.filter((r) => r.childId === childId) : [];
    const assigned = availableRooms.find((r) => r.id === child?.roomId);
    return { childId, child: child ? { id: child.id, firstName: child.firstName, lastName: child.lastName, preferredName: child.preferredName, roomId: child.roomId, active: child.active } : null,
      records: visits, openVisits,
      canCheckIn: !!(isToday && child?.active && assigned?.active && assigned.capacity != null && (!roomId || child.roomId === roomId) && !openVisits.length),
      checkInRoomId: child?.roomId || null };
  }).sort((a, b) => `${a.child?.firstName || ''} ${a.child?.lastName || ''}`.localeCompare(`${b.child?.firstName || ''} ${b.child?.lastName || ''}`) || a.childId.localeCompare(b.childId));
  return { ...config, date, room, rooms: availableRooms.map(({ id, name, active }) => ({ id, name, active })), rows,
    presentCount: isToday ? new Set(open.filter((r) => (!roomId || r.roomId === roomId) && validOpen(r, now)).map((r) => r.childId)).size : null,
    attendedCount: new Set(records.filter((r) => !r.voided).map((r) => r.childId)).size };
});
exports.todayHeadcount = () => db.withRoomLock(async () => {
  const now = new Date(); const date = time.dateAt(now);
  const open = await db.listAttendance({ openOnly: true, includeVoided: false });
  if (open.some((record) => record.needsReview || !validOpen(record, now) || time.dateAt(record.checkIn) !== date)) {
    throw fail('Review open attendance from earlier dates or invalid records before using today\'s headcount.', 'ATTENDANCE_REVIEW_REQUIRED');
  }
  return { date, timeZone: time.timeZone(), takenAt: now.toISOString(), childrenCount: new Set(open.map((r) => r.childId)).size };
});
exports.getPresentChildrenForRoom = async (roomId, date) => {
  const records = await exports.listAttendance({ roomId, date });
  const ids = [...new Set(records.filter((r) => validOpen(r, new Date())).map((r) => r.childId))];
  return (await Promise.all(ids.map((id) => db.getChildById(id)))).filter(Boolean);
};
