jest.mock('../services/recipeImage', () => ({ prepareRecipeImage: jest.fn(async image => image) }));
jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), spawn: jest.fn() }));
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const service = require('../services/staffDocumentOcr');
const { prepareRecipeImage } = require('../services/recipeImage');
const { metadata } = require('./helpers/pngFixture');
const image = readFileSync(path.join(__dirname, 'fixtures/staff-expiration.png'));
const payload = { image: image.toString('base64') };
const privateText = 'Synthetic Private Employee\nIssued: 2026-10-09\nExpiration date: November 18, 2027';
let staffId;
const endpoint = () => '/api/staff/' + staffId + '/documents/expiration-check';
const submit = (body = payload, suffix = '') => request(app).post(endpoint() + suffix).send(body);
function child(text = privateText, code = 0, error) {
  const process = new EventEmitter();
  process.stdin = new PassThrough(); process.stdout = new PassThrough();
  process.kill = jest.fn(() => { setImmediate(() => process.emit('close', null)); return true; });
  if (text !== null) setImmediate(() => {
    if (error) process.emit('error', error);
    process.stdout.end(text); process.emit('close', code);
  });
  return process;
}
async function spawned() {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (spawn.mock.calls.length) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Synthetic OCR did not start.');
}
beforeEach(async () => {
  prepareRecipeImage.mockReset(); prepareRecipeImage.mockImplementation(async bytes => bytes);
  spawn.mockReset(); spawn.mockImplementation(() => child());
  const employee = await request(app).post('/api/staff').send({ name: 'Synthetic Private Employee', role: 'Teacher', active: true, roomId: null });
  expect(employee.status).toBe(201); staffId = employee.body.data.id;
});

test('local reading returns no-store text without saving documents or sensitive content in its audit', async () => {
  const before = await db.listAudit({ limit: 100 });
  const response = await submit({ image: metadata(image).toString('base64') });
  expect(response.status).toBe(200); expect(response.body).toEqual({ text: privateText });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(await db.countStaffDocuments(staffId)).toBe(0);
  const events = (await db.listAudit({ limit: 100 })).filter(event => !before.some(previous => previous.id === event.id));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actorId: request.credentials().account.id, action: 'staff_document.expiration_check', entityId: staffId });
  expect(JSON.stringify(events)).not.toMatch(/Synthetic Private Employee|Expiration date|November|image|base64/);
  expect(prepareRecipeImage.mock.calls[0][0]).toEqual(image); // Ancillary metadata was discarded.
  expect(spawn).toHaveBeenCalledWith('tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11', '--dpi', '300'],
    expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'], env: expect.objectContaining({ OMP_THREAD_LIMIT: '1' }) }));
});

test.each([{ image: 'https://outside.invalid/file' }, { image: '/etc/passwd' }, {}, { image: 'cG5n' },
  { ...payload, filename: 'private.pdf' }, { ...payload, options: ['--output', '/tmp/private'] },
  { image: payload.image + '=' }, { image: image.subarray(0, image.length - 1).toString('base64') }])('rejects invalid bodies before OCR %#', async body => {
  const response = await submit(body);
  expect(response.status).toBe(400); expect(response.body.error.code).toBe('STAFF_DOCUMENT_OCR_INVALID_IMAGE');
  expect(spawn).not.toHaveBeenCalled();
});

test('only this authenticated route permits larger JSON, and malformed or excessive bodies release the slot', async () => {
  expect((await submit({ image: 'A'.repeat(7 * 1024 * 1024) })).status).toBe(413);
  expect((await request(app).post(endpoint()).set('Content-Type', 'application/json').send('malformed')).status).toBe(400);
  expect((await request(app).post('/api/staff').send({ name: 'x'.repeat(110000) })).status).toBe(413);
  expect((await submit()).status).toBe(200);
});

test('unsigned requests, origin/CSRF failures, editors and viewers are rejected before any OCR', async () => {
  const credentials = request.credentials();
  expect((await anonymous(app).post(endpoint()).set('Origin', request.origin).set('Content-Type', 'application/json').send('malformed')).status).toBe(401);
  expect((await anonymous(app).post(endpoint()).set('Origin', request.origin).set('Cookie', credentials.cookie).send(payload)).status).toBe(403);
  expect((await submit(payload).set('Origin', 'https://outside.invalid')).status).toBe(403);
  for (const role of ['editor', 'viewer']) {
    await db.updateAccount(credentials.account.id, { role, documentAccess: 'edit' });
    expect((await submit()).status).toBe(403);
  }
  expect(spawn).not.toHaveBeenCalled();
});

test('an employee must exist, and query options cannot alter recognition', async () => {
  expect((await request(app).post('/api/staff/nonexistent/documents/expiration-check').send(payload)).status).toBe(404);
  expect((await submit(payload, '?language=outside')).status).toBe(400);
  expect(spawn).not.toHaveBeenCalled();
});

test.each([
  ['', 0, undefined, 200, undefined],
  ['partial', 1, undefined, 422, 'STAFF_DOCUMENT_OCR_UNREADABLE'],
  ['', -2, Object.assign(new Error('private machine path'), { code: 'ENOENT' }), 422, 'STAFF_DOCUMENT_OCR_UNAVAILABLE'],
  ['a'.repeat(24001), 0, undefined, 422, 'STAFF_DOCUMENT_OCR_TOO_MUCH_TEXT'],
])('OCR failures give safe manual fallback and release the slot %#', async (text, code, error, status, resultCode) => {
  spawn.mockImplementationOnce(() => child(text, code, error));
  const response = await submit(); expect(response.status).toBe(status);
  if (resultCode) {
    expect(response.body.error.code).toBe(resultCode);
    expect(response.body.error.message).toContain('Enter the expiration date yourself.');
  } else expect(response.body).toEqual({ text: '' });
  expect(JSON.stringify(response.body)).not.toContain('private machine path');
  expect((await submit()).status).toBe(200);
});

test('a busy slot rejects another request before its body is parsed, while authorization changes remain unblocked', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  const active = submit().then(response => response);
  await spawned();
  const second = await request(app).post(endpoint()).set('Content-Type', 'application/json').send('malformed');
  expect(second.status).toBe(429); expect(second.headers['retry-after']).toBe('5');
  await db.withAuthLock(() => db.updateAccount(request.credentials().account.id, { role: 'editor' }));
  pending.stdout.end(privateText); pending.emit('close', 0);
  const denied = await active;
  expect(denied.status).toBe(403); expect(JSON.stringify(denied.body)).not.toContain(privateText);
  await db.updateAccount(request.credentials().account.id, { role: 'admin' });
  expect((await submit()).status).toBe(200);
});

test('unavailable optional OCR preserves the session and provides manual entry without a server-outage status', async () => {
  spawn.mockImplementationOnce(() => child('', -2, Object.assign(new Error('local reader missing'), { code: 'ENOENT' })));
  const { cookie } = request.credentials();
  const response = await submit();
  expect(response.status).toBe(422);
  expect(response.body.error).toMatchObject({ code: 'STAFF_DOCUMENT_OCR_UNAVAILABLE',
    message: 'Local document reading is unavailable. Enter the expiration date yourself.' });
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(request.credentials().cookie).toBe(cookie);
  expect((await request(app).get('/api/auth/session')).status).toBe(200);
  expect((await request(app).get('/api/staff')).status).toBe(200);
  expect(await db.countStaffDocuments(staffId)).toBe(0);
});

test('a session revoked while OCR runs cannot receive recognized private text', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  const active = submit().then(response => response); await spawned();
  expect((await request(app).post('/api/auth/logout').send({})).status).toBe(204);
  pending.stdout.end(privateText); pending.emit('close', 0);
  const response = await active;
  expect(response.status).toBe(401); expect(JSON.stringify(response.body)).not.toContain(privateText);
});

test('cancelling OCR kills the process and permits a later retry', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  const controller = new AbortController();
  const token = request.credentials().cookie.split('=')[1];
  const result = service.checkExpiration(token, staffId, payload, { signal: controller.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'STAFF_DOCUMENT_OCR_CANCELLED' });
  await spawned(); controller.abort(); await rejected;
  expect(pending.kill).toHaveBeenCalledWith('SIGKILL');
  expect((await submit()).status).toBe(200);
});

test('disconnecting HTTP cancels OCR but retains its reservation until the process stops', async () => {
  const pending = child(null); pending.kill.mockImplementation(() => true);
  spawn.mockReturnValueOnce(pending);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const credentials = request.credentials();
  const client = http.request({ hostname: '127.0.0.1', port: server.address().port, path: endpoint(), method: 'POST',
    headers: { Origin: request.origin, Cookie: credentials.cookie, 'X-CSRF-Token': credentials.csrf, 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  try {
    client.end(JSON.stringify(payload)); await spawned(); client.destroy();
    for (let attempts = 0; attempts < 100 && !pending.kill.mock.calls.length; attempts++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(pending.kill).toHaveBeenCalledWith('SIGKILL');
    expect((await submit()).status).toBe(429);
    pending.emit('close', null);
    await new Promise(resolve => setImmediate(resolve));
    expect((await submit()).status).toBe(200);
  } finally {
    pending.emit('close', null); client.destroy(); await new Promise(resolve => server.close(resolve));
  }
});

test('image preparation and OCR share one bounded deadline', async () => {
  const pending = child(null); spawn.mockReturnValueOnce(pending);
  const token = request.credentials().cookie.split('=')[1];
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  try {
    prepareRecipeImage.mockImplementationOnce(async bytes => { jest.advanceTimersByTime(18000); return bytes; });
    const result = service.checkExpiration(token, staffId, payload);
    const rejected = expect(result).rejects.toMatchObject({ code: 'STAFF_DOCUMENT_OCR_TIMEOUT' });
    await spawned(); jest.advanceTimersByTime(11999); expect(pending.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); await rejected; expect(pending.kill).toHaveBeenCalledWith('SIGKILL');
  } finally { jest.useRealTimers(); }
});

test('preparation failure stops before OCR and preserves manual fallback', async () => {
  prepareRecipeImage.mockRejectedValueOnce(new Error('private decoder detail'));
  const response = await submit();
  expect(response.status).toBe(422); expect(response.body.error.code).toBe('STAFF_DOCUMENT_OCR_UNREADABLE');
  expect(JSON.stringify(response.body)).not.toContain('private decoder detail');
  expect(spawn).not.toHaveBeenCalled(); expect((await submit()).status).toBe(200);
});

test('failed private access auditing returns no recognized content', async () => {
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('private audit detail'));
  try {
    const response = await submit();
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/Synthetic Private Employee|November|private audit detail/);
  } finally { audit.mockRestore(); logging.mockRestore(); }
});
