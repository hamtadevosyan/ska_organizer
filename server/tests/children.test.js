// server/tests/children.test.js
const request = require('supertest');
const app = require('../index');

describe('Children API', () => {
  it('POST /api/children creates a child and returns 201', async () => {
    const payload = { firstName: 'Test', lastName: 'Child', dateOfBirth: '2020-01-01' };
    const res = await request(app).post('/api/children').send(payload);
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.firstName).toBe(payload.firstName);
  });

  it('GET /api/children/:id returns 404 for missing id', async () => {
    const res = await request(app).get('/api/children/non-existent-id');
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

