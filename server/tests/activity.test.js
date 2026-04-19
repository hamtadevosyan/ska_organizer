// server/tests/activity.test.js
const request = require('supertest');
const app = require('../index');

describe('Activity API', () => {
  it('POST /api/activity creates activity', async () => {
    const payload = {
      name: 'Circle Time',
      description: 'Morning group activity',
      category: 'foundational',
      repeatWindowWeeks: 1,
      type: 'literacy',
      location: 'indoor',
      ageMin: 2,
      ageMax: 5,
      energyLevel: 'low',
      estimatedCost: 0,
      materialsLinks: [],
      materialsNotes: ''
    };

    const res = await request(app).post('/api/activity').send(payload);

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('data.id');
    expect(res.body.data.name).toBe(payload.name);
  });

  it('GET /api/activity/:id returns 404 for missing id', async () => {
    const res = await request(app).get('/api/activity/non-existent-id');
    expect(res.statusCode).toBe(404);
  });
});
