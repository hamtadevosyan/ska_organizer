const request = require('./helpers/authenticatedRequest');
const app = require('../index'); // if index exports app; otherwise create a small test server wrapper

describe('Attendance API', () => {
  beforeEach(async () => {
    const db = require('../services/dbAdapter');
    await db.createRoom({ id: 'test-room', name: 'Test room', ageMinMonths: 24, ageMaxMonths: 72, capacity: 20, active: true });
    await db.createChild({ id: 'test-child', firstName: 'Test', lastName: 'Child' });
    await db.createChild({ id: 'test-child-2', firstName: 'Second', lastName: 'Child' });
  });
  it('GET /api/attendance returns array', async () => {
    const res = await request(app).get('/api/attendance');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/attendance/checkin creates record', async () => {
    const payload = { childId: 'test-child', roomId: 'test-room', recordedBy: 'tester' };
    const res = await request(app).post('/api/attendance/checkin').send(payload);
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.childId).toBe(payload.childId);
  });

  it('POST /api/attendance/:id/checkout sets checkOut', async () => {
    const payload = { childId: 'test-child-2', roomId: 'test-room', recordedBy: 'tester' };
    const create = await request(app).post('/api/attendance/checkin').send(payload);
    const id = create.body.id;
    const res = await request(app).post(`/api/attendance/${id}/checkout`);
    expect(res.statusCode).toBe(200);
    expect(res.body.checkOut).not.toBeNull();
  });
});
