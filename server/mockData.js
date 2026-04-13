// server/mockData.js
const crypto = require('crypto');

let uuid;
try {
  uuid = () => crypto.randomUUID();
} catch (e) {
  try {
    const u = require('uuid');
    uuid = typeof u.v4 === 'function' ? u.v4 : (() => String(Date.now()));
  } catch (err) {
    uuid = () => String(Date.now()) + Math.floor(Math.random() * 10000);
  }
}

const nowIso = () => new Date().toISOString();

// Simple in-memory mock data used by services and controllers
const children = [
  { id: 'c1', firstName: 'Alice', lastName: 'Johnson', dateOfBirth: '2020-06-15', preferredName: '', photoConsent: true, notes: '', createdAt: nowIso() },
  { id: 'c2', firstName: 'Ben', lastName: 'Martinez', dateOfBirth: '2019-11-02', preferredName: 'Benny', photoConsent: false, notes: '', createdAt: nowIso() }
];

const enrollments = [
  { id: uuid(), childId: 'c1', roomId: 'r1', status: 'active', startDate: '2023-09-01', endDate: null },
  { id: uuid(), childId: 'c2', roomId: 'r1', status: 'active', startDate: '2023-09-01', endDate: null }
];

const attendance = [
  // Example record format
  // { id: uuid(), childId: 'c1', roomId: 'r1', checkIn: nowIso(), checkOut: null, recordedBy: 'staff1' }
];

const staff = [
  { id: 's1', name: 'Sam Staff', role: 'teacher' },
  { id: 's2', name: 'Riley Admin', role: 'admin' }
];

// Export helpers and data
module.exports = {
  uuid,
  nowIso,
  children,
  enrollments,
  attendance,
  staff
};

