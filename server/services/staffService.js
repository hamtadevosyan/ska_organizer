const db = require('./dbAdapter');
const { problem } = require('./planValidation');
const { requireRoom } = require('./roomService');
const { validateStaff, staffId, staffQuery } = require('./staffValidation');

const summarize = (person, room) => ({
  ...person, room: room ? { id: room.id, name: room.name, active: room.active } : null,
});
async function requireStaff(id) {
  const person = await db.getStaffById(staffId(id));
  if (!person) throw problem('Staff record not found.', 404);
  return person;
}
async function withRoom(person) {
  return summarize(person, person.roomId ? await db.getRoomById(person.roomId) : null);
}
// Share the room lock with room archival, so a new assignment is checked and
// persisted atomically. Retained assignments remain editable after archival.
async function checkRoom(person, previous) {
  if (person.roomId && (person.roomId !== previous?.roomId || person.active && !previous?.active)) {
    try { await requireRoom(person.roomId, { active: true }); }
    catch (error) {
      if (error.status && error.status < 500) error.fields = { ...error.fields, roomId: error.message };
      throw error;
    }
  }
}
exports.list = async (query = {}) => {
  const filters = staffQuery(query);
  const [items, total, activeTotal, rooms] = await Promise.all([
    db.listStaff(filters), db.countStaff(filters), db.countStaff({ active: true }), db.listRooms({ includeArchived: true }),
  ]);
  const byId = new Map(rooms.map((room) => [room.id, room]));
  return { items: items.map((person) => summarize(person, byId.get(person.roomId))), total,
    activeTotal, page: filters.page, pageSize: filters.pageSize };
};
exports.get = async (id) => withRoom(await requireStaff(id));
exports.create = (payload) => db.withRoomLock(async () => {
  const values = validateStaff(payload);
  await checkRoom(values);
  return withRoom(await db.createStaff(values));
});
exports.update = (id, payload) => db.withRoomLock(async () => {
  const previous = await requireStaff(id);
  const values = validateStaff(payload, previous);
  await checkRoom(values, previous);
  return withRoom(await db.updateStaff(id, values));
});
