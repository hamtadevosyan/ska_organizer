// server/tests/activity.test.js
const request = require('supertest');
const app = require('../index');

describe('Activity API', () => {
  it('POST /api/activity creates activity', async () => {
    const payload = { name: 'Circle Time', description: 'Morning group activity' };
    const res = await request(app).post('/api/activity').send(payload);
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  it('GET /api/activity/:id returns 404 for missing id', async () => {
    const res = await request(app).get('/api/activity/non-existent-id');
    expect(res.statusCode).toBe(404);
  });
});

