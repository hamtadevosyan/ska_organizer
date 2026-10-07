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

test('uneven lighting preserves the last ingredients and supplies photo regions for all seven lines', async () => {
  const image = readFileSync(path.join(__dirname, 'fixtures/recipe-photo-shadow.png')).toString('base64');
  const response = await request(app).post('/api/meals/recipe-photo').send({ image });
  expect(response.status).toBe(200);
  expect(response.body.data.text).toMatch(/yields 8 servings/);
  const lines = response.body.data.lines;
  const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const matches = ['flour', 'baking powder', 'white sugar', 'salt', 'milk', 'butter', 'egg'].map(ingredient => ({
    ingredient, line: lines.find(value => normalize(value.text).includes(ingredient)),
  }));
  // Real OCR can vary harmlessly in case and spacing across installed models.
  // Keep seven distinct ingredient lines and report actual omissions by name.
  const recognized = lines.map(line => line.text);
  expect({ missing: matches.filter(match => !match.line).map(match => match.ingredient), recognized }).toEqual({ missing: [], recognized });
  expect(new Set(matches.map(match => match.line)).size).toBe(7);
  for (const { line } of matches) {
    expect(line.box.width).toBeGreaterThan(0); expect(line.box.height).toBeGreaterThan(0);
    expect(line.box.x).toBeGreaterThanOrEqual(0); expect(line.box.y).toBeGreaterThanOrEqual(0);
    expect(line.box.x + line.box.width).toBeLessThanOrEqual(response.body.data.width);
    expect(line.box.y + line.box.height).toBeLessThanOrEqual(response.body.data.height);
  }
  expect(matches.find(match => match.ingredient === 'egg').line.box.y)
    .toBeGreaterThan(matches.find(match => match.ingredient === 'butter').line.box.y);
}, 40000);
