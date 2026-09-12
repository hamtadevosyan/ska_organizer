const db = require('./dbAdapter');
const rooms = require('./roomService');
const { problem } = require('./planValidation');
const { roomId } = require('./roomValidation');
const { validateChild, normalizedName } = require('./childValidation');

exports.listChildren = async ({ q, roomId: selectedRoom, active = 'true', page = 1, pageSize = 50 } = {}) => {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200 || (page - 1) * pageSize > 2147483647) {
    throw problem('Use a positive page number and a page size from 1 to 200.');
  }
  if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw problem('Search must be at most 100 characters.');
  if (!['true', 'false', 'all'].includes(active)) throw problem('Enrollment filter must be true, false or all.');
  if (selectedRoom !== undefined && selectedRoom !== 'unassigned') roomId(selectedRoom);
  const filters = { q: q?.trim(), roomId: selectedRoom === 'unassigned' ? null : selectedRoom, active: active === 'all' ? undefined : active === 'true' };
  const [items, total] = await Promise.all([db.listChildren({ ...filters, page, pageSize }), db.countChildren(filters)]);
  return { items, total, page, pageSize };
};
exports.getById = (id) => db.getChildById(id);

async function checkDuplicates(values, previous, confirmed) {
  if (typeof values.firstName !== 'string' || typeof values.lastName !== 'string' || !values.firstName.trim() || !values.lastName.trim()) return;
  const name = (value) => normalizedName(value || '').toLowerCase();
  if (confirmed || previous && name(previous.firstName) === name(values.firstName) && name(previous.lastName) === name(values.lastName)) return;
  const matches = await db.findChildDuplicates(values.firstName, values.lastName, previous?.id);
  if (matches.length) {
    throw Object.assign(problem('A child with this name is already recorded. Review the matches before saving.', 409), {
      code: 'CHILD_DUPLICATE_WARNING',
      duplicates: matches.map(({ id, firstName, lastName, preferredName, dateOfBirth, active, roomId }) =>
        ({ id, firstName, lastName, preferredName, dateOfBirth, active, roomId })),
    });
  }
}
async function checkRoom(values, previous, confirmed) {
  if (values.roomId == null) return;
  if (values.active) {
    // Reactivation occupies a place again, even if the room ID stayed the same.
    await rooms.checkAssignment(values.roomId, previous?.active ? previous.roomId : null, confirmed);
  } else if (values.roomId !== previous?.roomId) {
    await rooms.requireRoom(values.roomId, { active: true });
  }
}
exports.createChild = (payload) => db.withRoomLock(async () => {
  const values = validateChild(payload);
  await checkDuplicates(values, null, payload.confirmDuplicate === true);
  await checkRoom(values, null, payload.confirmOverCapacity === true);
  return db.createChild(values);
});
exports.updateChild = (id, payload) => db.withRoomLock(async () => {
  const previous = await db.getChildById(id);
  if (!previous) return null;
  const values = validateChild(payload, previous);
  await checkDuplicates(values, previous, payload.confirmDuplicate === true);
  await checkRoom(values, previous, payload.confirmOverCapacity === true);
  return db.updateChild(id, values);
});
exports.setEnrollment = (id, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.active !== 'boolean' ||
      Object.keys(payload).some((key) => !['active', 'roomId', 'confirmOverCapacity'].includes(key))) {
    throw problem('Supply an enrollment status and optional room/capacity confirmation.');
  }
  return exports.updateChild(id, payload);
};
exports.assignRoom = (id, payload) => db.withRoomLock(async () => {
  if (!payload || !Object.hasOwn(payload, 'roomId') || Object.keys(payload).some((key) => !['roomId', 'confirmOverCapacity'].includes(key)) ||
      (Object.hasOwn(payload, 'confirmOverCapacity') && typeof payload.confirmOverCapacity !== 'boolean')) {
    throw problem('Supply roomId and an optional capacity confirmation.');
  }
  const previous = await db.getChildById(id);
  if (!previous) throw problem('Child not found.', 404);
  if (!previous.active && payload.roomId !== null) throw Object.assign(problem('Reactivate enrollment before assigning a room.', 409), { code: 'CHILD_INACTIVE' });
  return exports.updateChild(id, payload);
});
exports.getProfile = async (id) => {
  const child = await db.getChildById(id);
  if (!child) return null;
  const recentAttendance = (await db.listAttendance({ childId: id }))
    .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn)).slice(0, 10);
  return { child, room: child.roomId ? await db.getRoomById(child.roomId) : null, recentAttendance };
};
