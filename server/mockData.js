// server/mockData.js
const { v4: uuid } = require('uuid');

const now = () => new Date().toISOString();

const children = [
  { id: 'c1', firstName: 'Ava', lastName: 'Smith', dateOfBirth: '2021-06-12', photoConsent: true, notes: '' },
  { id: 'c2', firstName: 'Liam', lastName: 'Jones', dateOfBirth: '2020-11-03', photoConsent: false, notes: '' }
];

const staff = [
  { id: 's1', name: 'Mariana', role: 'teacher', availability: [{ day: 'mon', start: '08:00', end: '17:00' }] },
  { id: 's2', name: 'Ethan', role: 'assistant', availability: [{ day: 'mon', start: '09:00', end: '15:00' }] }
];

const rooms = [
  { id: 'r1', name: 'Toddlers', ageMinMonths: 12, ageMaxMonths: 36, capacity: 12 },
  { id: 'r2', name: 'Preschool', ageMinMonths: 36, ageMaxMonths: 60, capacity: 16 }
];

const enrollments = [
  { id: 'e1', childId: 'c1', roomId: 'r1', startDate: '2023-09-01', status: 'active' },
  { id: 'e2', childId: 'c2', roomId: 'r2', startDate: '2023-09-01', status: 'active' }
];

const attendance = []; // { id, childId, roomId, checkIn, checkOut, recordedBy }

module.exports = {
  children, staff, rooms, enrollments, attendance, uuid, now
};

