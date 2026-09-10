const db = require('./dbAdapter');
const rooms = require('./roomService');
const { problem } = require('./planValidation');
const { roomId } = require('./roomValidation');

const values = (payload) => Object.fromEntries(
  ['firstName', 'lastName', 'dateOfBirth', 'preferredName', 'photoConsent', 'notes', 'roomId']
    .filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]]),
);
exports.listChildren = async ({ q, roomId: selectedRoom, page = 1, pageSize = 50 } = {}) => {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw problem('Use a positive page number and a page size from 1 to 200.');
  }
  if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw problem('Search must be at most 100 characters.');
  if (selectedRoom !== undefined) roomId(selectedRoom);
  const filters = { q: q?.trim(), roomId: selectedRoom };
  const [items, total] = await Promise.all([db.listChildren({ ...filters, page, pageSize }), db.countChildren(filters)]);
  return { items, total, page, pageSize };
};
exports.getById = (id) => db.getChildById(id);
exports.createChild = (payload) => db.withRoomLock(async () => {
  await rooms.checkAssignment(payload.roomId ?? null, null, payload.confirmOverCapacity === true);
  return db.createChild({ preferredName: '', photoConsent: false, notes: '', roomId: null, ...values(payload) });
});
exports.updateChild = (id, payload) => db.withRoomLock(async () => {
  const previous = await db.getChildById(id);
  if (!previous) return null;
  if (Object.hasOwn(payload, 'roomId')) await rooms.checkAssignment(payload.roomId, previous.roomId, payload.confirmOverCapacity === true);
  return db.updateChild(id, values(payload));
});
exports.assignRoom = (id, payload) => db.withRoomLock(async () => {
  if (!payload || !Object.hasOwn(payload, 'roomId') || Object.keys(payload).some((key) => !['roomId', 'confirmOverCapacity'].includes(key)) ||
      (Object.hasOwn(payload, 'confirmOverCapacity') && typeof payload.confirmOverCapacity !== 'boolean')) {
    throw problem('Supply roomId and an optional capacity confirmation.');
  }
  const previous = await db.getChildById(id);
  if (!previous) throw problem('Child not found.', 404);
  await rooms.checkAssignment(payload.roomId, previous.roomId, payload.confirmOverCapacity === true);
  return db.updateChild(id, { roomId: payload.roomId });
});
exports.deleteChild = (id) => db.withRoomLock(() => db.deleteChild(id));
exports.getProfile = async (id) => {
  const child = await db.getChildById(id);
  if (!child) return null;
  const recentAttendance = (await db.listAttendance({ childId: id }))
    .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn)).slice(0, 10);
  return { child, room: child.roomId ? await db.getRoomById(child.roomId) : null, recentAttendance };
};
