const { readFileSync } = require('node:fs');
const path = require('node:path');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const { metadata } = require('./helpers/pngFixture');

test('real installed Tesseract reads a synthetic recipe image through the authenticated HTTP route', async () => {
  const image = readFileSync(path.join(__dirname, 'fixtures/recipe-photo.png')).toString('base64');
  const response = await request(app).post('/api/meals/recipe-photo').send({ image });
  expect(response.status).toBe(200);
  expect(response.body.data.text).toMatch(/Banana oat bowls/);
  expect(response.body.data.text).toMatch(/Serves 4/);
  expect(response.body.data.text).toMatch(/120 g Oats/);
  expect(response.body.data.text).toMatch(/400 ml Milk/);
  expect(response.body.data.text).toMatch(/2 Bananas/);
  expect(response.headers['cache-control']).toBe('no-store');
}, 40000);

test.each(['metadata', 'palette'])('real Tesseract reads a synthetic recipe with browser-compatible %s PNG encoding', async kind => {
  const original = readFileSync(path.join(__dirname, 'fixtures', kind === 'palette' ? 'recipe-photo-palette.png' : 'recipe-photo.png'));
  const image = (kind === 'metadata' ? metadata(original) : original).toString('base64');
  const response = await request(app).post('/api/meals/recipe-photo').send({ image });
  expect(response.status).toBe(200);
  expect(response.body.data.text).toMatch(/Banana oat bowls/);
  expect(response.body.data.text).toMatch(/120 g Oats/);
  expect(response.body.data.text).toMatch(/400 ml Milk/);
  expect(response.headers['cache-control']).toBe('no-store');
}, 40000);
