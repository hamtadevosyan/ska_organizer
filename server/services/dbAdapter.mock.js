// server/services/dbAdapter.mock.js
const mock = require('../mockData');

module.exports = {
  // Children
  listChildren: async (opts = {}) => {
    return mock.children;
  },
  getChildById: async (id) => mock.children.find(c => c.id === id) || null,
  createChild: async (payload) => {
    const child = { id: payload.id || mock.uuid(), ...payload, createdAt: mock.nowIso() };
    mock.children.push(child);
    return child;
  },
  updateChild: async (id, changes) => {
    const idx = mock.children.findIndex(c => c.id === id);
    if (idx === -1) return null;
    mock.children[idx] = { ...mock.children[idx], ...changes, updatedAt: mock.nowIso() };
    return mock.children[idx];
  },
  deleteChild: async (id) => {
    const idx = mock.children.findIndex(c => c.id === id);
    if (idx === -1) return false;
    mock.children.splice(idx, 1);
    return true;
  },

  // Attendance
  listAttendance: async (filters = {}) => {
    let items = mock.attendance.slice();
    if (filters.roomId) items = items.filter(r => r.roomId === filters.roomId);
    if (filters.childId) items = items.filter(r => r.childId === filters.childId);
    if (filters.date) items = items.filter(r => (r.checkIn || '').slice(0,10) === filters.date);
    return items;
  },
  getAttendanceById: async (id) => mock.attendance.find(a => a.id === id) || null,
  createAttendance: async (payload) => {
    const rec = {
      id: mock.uuid(),
      childId: payload.childId,
      roomId: payload.roomId,
      checkIn: payload.checkIn || mock.nowIso(),
      checkOut: payload.checkOut || null,
      recordedBy: payload.recordedBy || null
    };
    mock.attendance.push(rec);
    return rec;
  },
  updateAttendance: async (id, changes) => {
    const rec = mock.attendance.find(a => a.id === id);
    if (!rec) return null;
    Object.assign(rec, changes);
    return rec;
  }
};

