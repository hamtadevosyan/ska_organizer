const request = require('./helpers/authenticatedRequest');
const app = require('../index');

describe('Present children endpoint', () => {
  it('returns children present in a room for a given date', async () => {
    const db = require('../services/dbAdapter');
    await db.createRoom({ id: 'room1', name: 'Present children test', ageMinMonths: 24, ageMaxMonths: 72, capacity: 20 });
    await db.createChild({ id: 'present-child', firstName: 'Present', lastName: 'Child' });
    await db.createAttendance({ childId: 'present-child', roomId: 'room1', checkIn: '2026-04-18T08:00:00Z' });
    const res = await request(app)
      .get('/api/rooms/room1/present-children?date=2026-04-18');

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((child) => child.id)).toEqual(['present-child']);
  });
});
