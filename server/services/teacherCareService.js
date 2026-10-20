const db = require('./dbAdapter');
const auth = require('../auth/service');
const classroom = require('./classroomService');
const safety = require('./childSafetyService');
const attendance = require('./attendanceService');
const time = require('./facilityTime');
const problem = auth.problem;
const validTime = value => !!value && Number.isFinite(new Date(value).getTime());
function teacher(account) {
  if (account.role !== 'teacher') throw problem('Teacher access is required.', 403, 'TEACHER_REQUIRED');
}
function assigned(scope) {
  if (!scope.room) throw problem('An active class assignment is required.', 403, 'CLASS_ASSIGNMENT_REQUIRED');
}
function noQuery(query = {}) { if (Object.keys(query).length) throw problem('This class view does not accept filters.'); }
async function childInClass(childId, scope) {
  assigned(scope);
  const child = await db.getChildById(childId);
  if (!child || !child.active || child.roomId !== scope.room.id) throw problem('Child not found in your active class.', 404, 'CLASS_CHILD_NOT_FOUND');
  return child;
}
const visit = row => ({ id: row.id, checkIn: row.checkIn, checkOut: row.checkOut, version: row.version,
  voided: row.voided, needsReview: row.needsReview });
function payload(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw problem('Supply only the attendance action fields.');
  if (input.date !== time.dateAt()) throw problem('The facility date changed. Refresh class attendance.', 409, 'ATTENDANCE_DATE_CHANGED');
}
exports.safety = (token, childId, query) => {
  noQuery(query);
  return classroom.withScope(token, async (scope, account) => {
    teacher(account); await childInClass(childId, scope);
    const card = safety.projection(await db.getChildSafetyProfile(childId));
    await auth.audit(account, 'child.safety.view', childId);
    return { ...scope, childId, card };
  });
};
exports.roster = (token, query) => {
  noQuery(query);
  return classroom.withScope(token, async (scope, account) => {
    teacher(account);
    const today = time.dateAt(); const rows = [];
    if (scope.room) for (const child of await classroom.activeChildren(scope.room.id)) {
      const records = await db.listAttendance({ childId: child.id, roomId: scope.room.id, date: today, includeVoided: false });
      const open = await db.listAttendance({ childId: child.id, openOnly: true, includeVoided: false });
      const blocked = open.some(row => row.roomId !== scope.room.id || row.needsReview || !validTime(row.checkIn) || time.dateAt(row.checkIn) !== today || new Date(row.checkIn) > new Date()) || open.length > 1;
      rows.push({ child: classroom.publicChild(child), records: records.map(visit), needsAdminReview: blocked,
        canCheckIn: !blocked && !open.length && scope.room.capacity != null,
        canCheckOut: !blocked && open.length === 1 });
    }
    return { ...scope, today, timeZone: time.timeZone(), rows };
  });
};
exports.checkIn = (token, childId, input, query) => {
  noQuery(query);
  return classroom.withScope(token, async (scope, account) => {
    teacher(account); await childInClass(childId, scope); payload(input, ['date', 'requestId']);
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) throw problem('Supply the attendance retry identifier.');
    if (scope.room.capacity == null) throw problem('Ask an administrator to complete the class setup.', 409);
    const before = await db.listAttendance({ childId, openOnly: true, includeVoided: false });
    if (before.some(row => row.needsReview || !validTime(row.checkIn) || time.dateAt(row.checkIn) !== input.date)) throw problem('Ask an administrator to review the open attendance.', 409, 'ATTENDANCE_REVIEW_REQUIRED');
    const previous = await db.getAttendanceByRequestId(input.requestId);
    const record = await attendance.checkIn({ childId, roomId: scope.room.id, recordedBy: account.id,
      date: input.date, requestId: input.requestId });
    if (!previous && !before.some(row => row.id === record.id)) await auth.audit(account, 'attendance.check_in', record.id);
    return { ...scope, childId, record: visit(record) };
  });
};
exports.checkOut = (token, id, input, query) => {
  noQuery(query);
  return classroom.withScope(token, async (scope, account) => {
    teacher(account); assigned(scope); payload(input, ['date', 'version']);
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw problem('Supply the attendance version.');
    const previous = await db.getAttendanceById(id);
    if (!previous || previous.roomId !== scope.room.id) throw problem('Attendance not found in your class.', 404);
    await childInClass(previous.childId, scope);
    const open = await db.listAttendance({ childId: previous.childId, openOnly: true, includeVoided: false });
    if (!validTime(previous.checkIn) || time.dateAt(previous.checkIn) !== input.date || previous.needsReview || open.length > 1) throw problem('Ask an administrator to review this attendance.', 409, 'ATTENDANCE_REVIEW_REQUIRED');
    const record = await attendance.checkOut(id, input);
    if (!previous.checkOut && record.checkOut) await auth.audit(account, 'attendance.check_out', record.id);
    return { ...scope, childId: previous.childId, record: visit(record) };
  });
};
