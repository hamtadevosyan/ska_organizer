// server/services/attendanceService.js
const mock = require('../mockData');
const { attendance, uuid, nowIso } = mock || {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.listAttendance = async (filters = {}) => {
  await delay(5);
  let items = Array.isArray(attendance) ? attendance.slice() : [];
  if (filters.date) items = items.filter(a => a.checkIn && a.checkIn.startsWith(filters.date));
  if (filters.roomId) items = items.filter(a => a.roomId === filters.roomId);
  if (filters.childId) items = items.filter(a => a.childId === filters.childId);
  return items;
};

exports.getById = async (id) => {
  await delay(5);
  return (Array.isArray(attendance) ? attendance.find(a => a.id === id) : null) || null;
};

exports.checkIn = async ({ childId, roomId, recordedBy }) => {
  await delay(5);
  if (!childId || !roomId) throw new Error('childId and roomId required');
  const rec = {
    id: typeof uuid === 'function' ? uuid() : String(Date.now()),
    childId,
    roomId,
    checkIn: (typeof nowIso === 'function' ? nowIso() : new Date().toISOString()),
    checkOut: null,
    recordedBy: recordedBy || null
  };
  (Array.isArray(attendance) ? attendance : []).push(rec);
  return rec;
};

exports.checkOut = async (id) => {
  await delay(5);
  const rec = Array.isArray(attendance) ? attendance.find(a => a.id === id) : null;
  if (!rec) return null;
  rec.checkOut = new Date().toISOString();
  return rec;
};

