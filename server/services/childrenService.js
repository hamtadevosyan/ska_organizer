// server/services/childrenService.js
const mock = require('../mockData');
const { children, enrollments, attendance, uuid } = mock;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * List children with optional filters and pagination
 * Returns { items, total, page, pageSize }
 */
exports.listChildren = async ({ q, roomId, page = 1, pageSize = 50 } = {}) => {
  await delay(5);
  let items = children.slice();

  if (q) {
    const term = q.toLowerCase();
    items = items.filter(c => `${c.firstName} ${c.lastName}`.toLowerCase().includes(term));
  }

  if (roomId) {
    const childIds = enrollments
      .filter(e => e.roomId === roomId && e.status === 'active')
      .map(e => e.childId);
    items = items.filter(c => childIds.includes(c.id));
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  return { items: paged, total, page, pageSize };
};

/**
 * Get child by id
 */
exports.getById = async (id) => {
  await delay(5);
  return children.find(c => c.id === id) || null;
};

/**
 * Create a new child
 * Minimal validation here; move business rules into service as needed
 */
exports.createChild = async (payload) => {
  await delay(5);
  const newChild = {
    id: uuid(),
    firstName: payload.firstName,
    lastName: payload.lastName,
    dateOfBirth: payload.dateOfBirth,
    preferredName: payload.preferredName || '',
    photoConsent: !!payload.photoConsent,
    notes: payload.notes || '',
    createdAt: new Date().toISOString()
  };
  children.push(newChild);
  return newChild;
};

/**
 * Update child
 * Returns updated object or null if not found
 */
exports.updateChild = async (id, payload) => {
  await delay(5);
  const idx = children.findIndex(c => c.id === id);
  if (idx === -1) return null;
  Object.assign(children[idx], payload);
  children[idx].updatedAt = new Date().toISOString();
  return children[idx];
};

/**
 * Delete child
 * Returns true if deleted, false if not found
 * Also cleans up enrollments and attendance in the mock
 */
exports.deleteChild = async (id) => {
  await delay(5);
  const idx = children.findIndex(c => c.id === id);
  if (idx === -1) return false;
  children.splice(idx, 1);

  for (let i = enrollments.length - 1; i >= 0; i--) {
    if (enrollments[i].childId === id) enrollments.splice(i, 1);
  }
  for (let i = attendance.length - 1; i >= 0; i--) {
    if (attendance[i].childId === id) attendance.splice(i, 1);
  }

  return true;
};

/**
 * Get profile for a child: child, enrollments, recent attendance
 */
exports.getProfile = async (id) => {
  await delay(5);
  const child = children.find(c => c.id === id);
  if (!child) return null;
  const childEnrollments = enrollments.filter(e => e.childId === id);
  const recentAttendance = attendance
    .filter(a => a.childId === id)
    .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn))
    .slice(0, 10);
  return { child, enrollments: childEnrollments, recentAttendance };
};

