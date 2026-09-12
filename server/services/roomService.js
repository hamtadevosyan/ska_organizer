const db = require('./dbAdapter');
const { problem } = require('./planValidation');
const { validateRoom, roomId } = require('./roomValidation');

const summarize = (room, count) => ({
  ...room, assignedChildCount: count,
  needsConfiguration: room.capacity == null || room.ageMinMonths == null || room.ageMaxMonths == null,
  availablePlaces: room.capacity == null ? null : Math.max(0, room.capacity - count),
  overCapacity: room.capacity != null && count > room.capacity,
});
async function requireRoom(id, { active = false } = {}) {
  const room = await db.getRoomById(roomId(id));
  if (!room) throw problem('Room not found.', 404);
  if (active && !room.active) throw Object.assign(problem('This room is archived. Choose an active room for new assignments.', 409), { code: 'ROOM_ARCHIVED' });
  if (active && room.capacity == null) throw problem('Configure this room before assigning to it.', 409);
  return room;
}
exports.requireRoom = requireRoom;
exports.listRooms = async ({ includeArchived = false } = {}) => {
  const [rooms, counts] = await Promise.all([db.listRooms({ includeArchived }), db.roomChildCounts()]);
  return rooms.map((room) => summarize(room, Object.hasOwn(counts, room.id) ? counts[room.id] : 0));
};
exports.getRoom = async (id) => summarize(await requireRoom(id), await db.countChildren({ roomId: id, active: true }));
exports.createRoom = (payload) => db.withRoomLock(async () => summarize(await db.createRoom(validateRoom(payload)), 0));
exports.updateRoom = (id, payload) => db.withRoomLock(async () => {
  const previous = await requireRoom(id);
  const room = await db.updateRoom(id, validateRoom(payload, previous));
  return summarize(room, await db.countChildren({ roomId: id, active: true }));
});
exports.assignmentPreview = (id, childId) => db.withRoomLock(async () => {
  const child = await db.getChildById(childId);
  if (!child) throw problem('Child not found.', 404);
  if (!child.active) throw Object.assign(problem('Reactivate enrollment before assigning a room.', 409), { code: 'CHILD_INACTIVE' });
  const room = await requireRoom(id, { active: child.roomId !== id });
  const count = await db.countChildren({ roomId: id, active: true });
  const proposedChildCount = count + (child.roomId === id ? 0 : 1);
  return {
    room: summarize(room, count), childId, proposedChildCount,
    exceedsCapacity: room.capacity != null && proposedChildCount > room.capacity,
    alreadyAssigned: child.roomId === id,
  };
});
// Call inside withRoomLock together with the child mutation to serialize
// capacity checks, archival, and assignments across server processes.
exports.checkAssignment = async (id, previousId, confirmOverCapacity = false) => {
  roomId(id, true);
  if (id === null || id === previousId) return;
  const room = await requireRoom(id, { active: true });
  const count = await db.countChildren({ roomId: id, active: true });
  if (count + 1 > room.capacity && !confirmOverCapacity) {
    throw Object.assign(problem('This assignment would exceed the configured capacity. Confirm the capacity warning to continue.', 409), {
      code: 'ROOM_CAPACITY_WARNING',
      fields: { roomId: 'Proposed count: ' + (count + 1) + '; configured capacity: ' + room.capacity + '.' },
    });
  }
};
