// server/services/attendanceService.js
const db = require('./dbAdapter');

exports.listAttendance = (filters) => db.listAttendance(filters);
exports.getById = (id) => db.getAttendanceById(id);
exports.checkIn = ({ childId, roomId, recordedBy }) =>
  db.createAttendance({ childId, roomId, recordedBy, checkIn: new Date().toISOString() });

exports.checkOut = async (id) => {
  const rec = await db.getAttendanceById(id);
  if (!rec) return null;
  if (rec.checkOut) return rec;
  return db.updateAttendance(id, { checkOut: new Date().toISOString() });
};

exports.getPresentChildrenForRoom = async (roomId, date) => {
  const records = await db.listAttendance({ roomId, date });

  const present = records.filter(r => !r.checkOut);

  const children = await Promise.all(
    present.map(r => db.getChildById(r.childId))
  );

  return children.filter(Boolean);
};

