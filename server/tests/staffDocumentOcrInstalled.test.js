const { readFileSync } = require('node:fs');
const path = require('node:path');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');

test('installed local Tesseract reads expiration text from a synthetic certificate without storing it', async () => {
  const employee = await request(app).post('/api/staff').send({ name: 'Synthetic Certificate Reader', role: 'Teacher', active: true, roomId: null });
  expect(employee.status).toBe(201);
  const image = readFileSync(path.join(__dirname, 'fixtures/staff-expiration.png')).toString('base64');
  const response = await request(app).post('/api/staff/' + employee.body.data.id + '/documents/expiration-check').send({ image });
  expect(response.status).toBe(200);
  expect(response.body.text).toMatch(/Issued: October 9, 2026/);
  expect(response.body.text).toMatch(/Expiration date: November 18, 2027/);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(await db.countStaffDocuments(employee.body.data.id)).toBe(0);
}, 40000);
