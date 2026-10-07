jest.mock('../services/recipeImage', () => ({ prepareRecipeImage: jest.fn(async image => image) }));
jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), spawn: jest.fn() }));
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const service = require('../services/recipePhotoService');
const { prepareRecipeImage } = require('../services/recipeImage');
const image = readFileSync(path.join(__dirname, 'fixtures/recipe-photo.png'));
const body = { image: image.toString('base64') };
const endpoint = '/api/meals/recipe-photo';
const submit = (data = body) => request(app).post(endpoint).send(data);
function child(text = 'Oat bowls\nIngredients\n120 g Oats', code = 0, error) {
  const process = new EventEmitter();
  process.stdin = new PassThrough(); process.stdout = new PassThrough();
  process.kill = jest.fn(() => { setImmediate(() => process.emit('close', null)); return true; });
  if (text !== null) setImmediate(() => {
    if (error) process.emit('error', error);
    process.stdout.end(text.split('\n').map((line, i) => ['5', '1', String(i + 1), '1', '1', '1', '0', String(i * 30), '500', '20', '95', line].join('\t')).join('\n')); process.emit('close', code);
  });
  return process;
}
beforeEach(() => {
  prepareRecipeImage.mockReset(); prepareRecipeImage.mockImplementation(async image => image);
  spawn.mockReset(); spawn.mockImplementation(() => child());
});

test('reads locally, returns no-store text, makes no catalog or audit writes and uses fixed child arguments', async () => {
  const before = await db.listAudit();
  const response = await submit();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data).toMatchObject({ text: 'Oat bowls\nIngredients\n120 g Oats', width: 1200, height: 850 });
  expect(response.body.data.lines).toHaveLength(3);
  expect(await db.listMeals()).toEqual([]); expect(await db.listIngredients()).toEqual([]);
  expect(await db.listAudit()).toEqual(before);
  expect(spawn).toHaveBeenCalledWith('tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11', '--dpi', '300', 'tsv'], expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'], env: expect.objectContaining({ OMP_THREAD_LIMIT: '1' }) }));
});

test.each([{ image: 'https://external.example/recipe.png' }, { image: '/etc/passwd' }, { image: 'cG5n' }, { image: body.image, filename: 'outside' }, {}, { image: 'A'.repeat(7 * 1024 * 1024) }])('rejects invalid image inputs before OCR %#', async payload => {
  const response = await submit(payload);
  expect([400, 413]).toContain(response.status); expect(spawn).not.toHaveBeenCalled();
});

test('rejects huge dimensions, truncation and invalid PNG header changes', () => {
  for (const change of [b => b.writeUInt32BE(100000, 16), b => { b[25] = 3; }, b => b.write('tEXt', 12)]) {
    const invalid = Buffer.from(image); change(invalid);
    expect(() => service.imageBuffer({ image: invalid.toString('base64') })).toThrow();
  }
  expect(() => service.imageBuffer({ image: image.subarray(0, image.length - 1).toString('base64') })).toThrow();
});

test('the larger parser is scoped to authenticated photo requests; other endpoints retain the ordinary limit', async () => {
  const large = { name: 'x'.repeat(110000) };
  expect((await request(app).post('/api/meals').send(large)).status).toBe(413);
  const response = await anonymous(app).post(endpoint).set('Origin', request.origin).set('Content-Type', 'application/json').send('malformed');
  expect(response.status).toBe(401);
  const token = request.credentials();
  expect((await anonymous(app).post(endpoint).set('Origin', request.origin).set('Cookie', token.cookie).send(body)).status).toBe(403);
  expect((await request(app).post(endpoint).set('Origin', 'https://external.example').send(body)).status).toBe(403);
  await db.updateAccount(token.account.id, { role: 'viewer' });
  expect((await submit()).status).toBe(403); expect(spawn).not.toHaveBeenCalled();
  await db.updateAccount(token.account.id, { role: 'editor' });
  expect((await submit()).status).toBe(200);
});

test.each([
  ['', 0, undefined, 422, 'RECIPE_PHOTO_EMPTY'],
  ['partial', 1, undefined, 422, 'RECIPE_PHOTO_UNREADABLE'],
  ['', -2, Object.assign(new Error('private machine path'), { code: 'ENOENT' }), 503, 'RECIPE_OCR_UNAVAILABLE'],
  ['a'.repeat(24001), 0, undefined, 422, 'RECIPE_PHOTO_TOO_MUCH_TEXT'],
])('handles OCR failures without leaking child details %#', async (text, code, error, status, resultCode) => {
  spawn.mockImplementationOnce(() => child(text, code, error));
  const response = await submit();
  expect(response.status).toBe(status); expect(response.body.error.code).toBe(resultCode);
  expect(JSON.stringify(response.body)).not.toContain('private machine path');
  expect((await submit()).status).toBe(200);
});

test('rejects simultaneous work, kills a cancelled child and frees the slot for a retry', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  const controller = new AbortController();
  const result = service.readRecipePhoto(body, { signal: controller.signal });
  await Promise.resolve();
  await expect(service.readRecipePhoto(body)).rejects.toMatchObject({ status: 429 });
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: 'RECIPE_PHOTO_CANCELLED' });
  expect(pending.kill).toHaveBeenCalledWith('SIGKILL');
  await expect(service.readRecipePhoto(body)).resolves.toHaveProperty('text');
});

test('terminates a hung OCR child at its deadline', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  try {
    const result = service.readRecipePhoto(body);
    const rejected = expect(result).rejects.toMatchObject({ code: 'RECIPE_PHOTO_TIMEOUT' });
    await Promise.resolve();
    jest.advanceTimersByTime(30000); await rejected;
    expect(pending.kill).toHaveBeenCalledWith('SIGKILL');
  } finally { jest.useRealTimers(); }
});

test('preparation failure stops before OCR and frees the slot for a retry', async () => {
  prepareRecipeImage.mockRejectedValueOnce(Object.assign(new Error('This image could not be read.'), { status: 400, code: 'INVALID_RECIPE_IMAGE' }));
  await expect(service.readRecipePhoto(body)).rejects.toMatchObject({ code: 'INVALID_RECIPE_IMAGE' });
  expect(spawn).not.toHaveBeenCalled();
  await expect(service.readRecipePhoto(body)).resolves.toHaveProperty('text');
});

test('image preparation and OCR share one thirty-second deadline', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  try {
    prepareRecipeImage.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(18000);
      return image;
    });
    const result = service.readRecipePhoto(body);
    const rejected = expect(result).rejects.toMatchObject({ code: 'RECIPE_PHOTO_TIMEOUT' });
    await Promise.resolve();
    jest.advanceTimersByTime(11999);
    expect(pending.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); await rejected;
    expect(pending.kill).toHaveBeenCalledWith('SIGKILL');
  } finally { jest.useRealTimers(); }
});

test('line coordinates stay inside the uploaded photo and malformed OCR metadata is ignored', () => {
  const row = (x, y, w, h, confidence, text) => ['5','1','1','1','1','1',x,y,w,h,confidence,text].join('\t');
  const result = service.recognizedLines([
    row(10, 20, 50, 10, 95, '120'), row(65, 20, 90, 10, 92, 'g Oats'),
    row(-1, 1, 5, 5, 90, 'outside'), row(1, 1, 9999, 5, 90, 'outside'),
    row(1, 1, 5, 5, 'NaN', 'bad'), row(1, 1, 5, 5, 90, ''),
  ].join('\n'), 1200, 850);
  expect(result).toEqual([{ text: '120 g Oats', confidence: 94, box: { x: 10, y: 20, width: 145, height: 10 } }]);
});
