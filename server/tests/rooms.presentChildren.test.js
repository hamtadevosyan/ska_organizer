const request = require('supertest');
const app = require('../index');

describe('Present children endpoint', () => {
  it('returns children present in a room for a given date', async () => {
    const res = await request(app)
      .get('/api/rooms/room1/present-children?date=2026-04-18');

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

