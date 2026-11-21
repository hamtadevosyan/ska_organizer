const { createHash, randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const anonymous = require('supertest');
const { PNG } = require('pngjs');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const media = require('../services/activityMedia');
const runtime = require('../services/localAiRuntime');
const transport = require('../services/activityMediaTransport');

const base = '/api/activity-ai/images';
const model = 'sd_xl_base_1.0.safetensors';
const draft = { name: 'Colorful paper sorting', description: 'Prepare paper. Demonstrate sorting. Let children explore.',
  steps: ['Set out large pieces of paper.', 'Sort the paper into color groups.'] };
const bytes = PNG.sync.write({ width: 4, height: 3, data: Buffer.alloc(4 * 3 * 4, 127) });
const token = () => request.credentials().cookie.split('=')[1];
let environment, mode, workerId, workerSteps, sent;
const worker = (status = mode) => ({ version: 1, id: workerId, status,
  total: workerSteps.length, completed: status === 'complete' ? workerSteps.length : 0,
  frames: status === 'complete' ? workerSteps.map((caption, index) => ({ step: index + 1, caption,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, width: 4, height: 3 })) : [] });

beforeEach(() => {
  environment = Object.fromEntries(['SKAO_AI_MODEL', 'SKAO_AI_URL', 'SKAO_AI_LAN', 'SKAO_AI_TOKEN'].map(key => [key, process.env[key]]));
  process.env.SKAO_AI_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
  process.env.SKAO_AI_URL = 'http://127.0.0.1:11434'; process.env.SKAO_AI_LAN = '0'; delete process.env.SKAO_AI_TOKEN;
  mode = 'complete'; workerId = null; workerSteps = []; sent = [];
  jest.spyOn(transport, 'request').mockImplementation(async (config, method, path, value, signal, binary) => {
    sent.push({ method, path, value, binary });
    if (path === '/api/activity-images/status') return { version: 1, enabled: true, available: true, busy: false, model };
    if (method === 'POST') { workerId = value.requestId; workerSteps = value.steps; return worker(); }
    if (method === 'DELETE') return worker('cancelled');
    if (binary) return Buffer.from(bytes);
    return worker();
  });
});
afterEach(async () => {
  await media.shutdown(); jest.restoreAllMocks();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
async function finish(id) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await media.getJob(token(), id);
    if (value.status !== 'running') return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic image job did not finish.');
}
async function generate() {
  const response = await request(app).post(base + '/jobs').send(draft);
  expect(response.status).toBe(200);
  const value = await finish(response.body.data.id);
  expect(value.status).toBe('complete'); expect(value.images).toHaveLength(2);
  return value;
}
async function save(images, changes = {}) {
  return request(app).post('/api/activity').send({ name: draft.name, description: draft.description,
    durationMinutes: 20, illustrations: images.map(({ id }) => ({ id })), ...changes });
}

test('media requires an operational session and reports unavailable workers without affecting written activities', async () => {
  expect((await anonymous(app).get(base + '/status')).status).toBe(401);
  const ready = await request(app).get(base + '/status');
  expect(ready.body.data).toMatchObject({ enabled: true, available: true, model });
  transport.request.mockRejectedValue(new Error('Synthetic network failure'));
  const offline = await request(app).get(base + '/status');
  expect(offline.status).toBe(200); expect(offline.body.data.available).toBe(false);
  expect((await request(app).post('/api/activity').send({ name: 'Written activity', durationMinutes: 15 })).status).toBe(201);
  const room = await db.createRoom({ name: 'Assigned', active: true, capacity: 12, ageMinMonths: 24, ageMaxMonths: 60 });
  await db.updateAccount(request.credentials().account.id, { role: 'viewer', roomId: room.id });
  expect((await request(app).post(base + '/jobs').send(draft)).status).toBe(403);
});

test('one idea becomes authenticated canonical PNGs, with no room, account or description sent to the laptop', async () => {
  const job = await generate();
  expect(sent.find(call => call.method === 'POST').value).toEqual({ name: draft.name, steps: draft.steps, requestId: job.id });
  expect(JSON.stringify(sent)).not.toContain(draft.description);
  expect(JSON.stringify(sent)).not.toContain(request.credentials().account.id);
  for (const [index, image] of job.images.entries()) {
    expect(image).toEqual({ id: expect.any(String), step: index + 1, caption: draft.steps[index], width: 4, height: 3 });
    expect((await anonymous(app).get(base + '/' + image.id)).status).toBe(401);
    const response = await request(app).get(base + '/' + image.id);
    expect(response.status).toBe(200); expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(PNG.sync.read(response.body).width).toBe(4);
    const row = await db.getActivityMedia(image.id);
    expect(row).not.toHaveProperty('content'); expect(row.claimed).toBe(false);
  }
});

test('saved pictures survive library reload and historical plans after the catalog pictures are removed', async () => {
  const job = await generate(), created = await save(job.images);
  expect(created.status).toBe(201); expect(created.body.data.illustrations).toEqual(job.images);
  const activity = created.body.data;
  expect((await request(app).get('/api/activity/' + activity.id)).body.data.illustrations).toEqual(job.images);
  const room = await db.createRoom({ name: 'Picture class', active: true, capacity: 12, ageMinMonths: 24, ageMaxMonths: 60 });
  const week = await request(app).post('/api/schedule/plan').send({ roomId: room.id, weekStart: '2026-11-02', version: 0,
    requestId: randomUUID(), entries: [{ id: randomUUID(), date: '2026-11-02', startTime: '09:00', endTime: '09:20', activityId: activity.id }] });
  expect(week.status).toBe(200); expect(week.body.data.entries[0].activity.illustrations).toEqual(job.images);
  const changed = await request(app).put('/api/activity/' + activity.id).send({ description: 'Different instructions.', illustrations: [], version: 1 });
  expect(changed.status).toBe(200); expect(changed.body.data.illustrations).toEqual([]);
  expect((await db.getActivityMedia(job.images[0].id)).claimed).toBe(true);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer', roomId: room.id });
  const classroom = await request(app).get('/api/classroom/activities?weekStart=2026-11-02');
  expect(classroom.status).toBe(200); expect(classroom.body.data.entries[0].activity.illustrations).toEqual(job.images);
  expect((await request(app).get('/api/classroom/activity-images/' + job.images[0].id)).status).toBe(200);
  const other = await db.createRoom({ name: 'Other class', active: true, capacity: 12, ageMinMonths: 24, ageMaxMonths: 60 });
  await db.updateAccount(request.credentials().account.id, { roomId: other.id });
  expect((await request(app).get('/api/classroom/activity-images/' + job.images[0].id)).status).toBe(404);
});

test('stale content and failed saves cannot claim a preview or attach it to different instructions', async () => {
  const job = await generate();
  const stale = await save(job.images, { description: 'An unrelated activity.' });
  expect(stale.status).toBe(400); expect(stale.body.error.fields).toHaveProperty('illustrations');
  expect((await db.getActivityMedia(job.images[0].id)).claimed).toBe(false);
  const failed = await save(job.images, { roomId: randomUUID() });
  expect(failed.status).not.toBe(201);
  expect((await db.getActivityMedia(job.images[0].id)).claimed).toBe(false);
  // This fails after image resolution, rather than during field validation.
  const create = jest.spyOn(db, 'createActivity').mockRejectedValueOnce(new Error('Synthetic database save failure'));
  const databaseFailure = await save(job.images);
  expect(databaseFailure.status).toBe(500);
  create.mockRestore();
  expect((await db.getActivityMedia(job.images[0].id)).claimed).toBe(false);
  expect(await db.listActivities()).toEqual([]);
});

test('preview jobs and image bytes remain private to their owner until an activity is saved', async () => {
  const job = await generate();
  const other = await db.createAccount({ id: randomUUID(), username: 'other-media-owner', displayName: 'Other synthetic owner',
    passwordHash: 'unused-test-hash', role: 'admin', disabled: false, mustChangePassword: false });
  const otherToken = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(otherToken), accountId: other.id, createdAt: now, lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000), remembered: false });
  await expect(media.getJob(otherToken, job.id)).rejects.toMatchObject({ status: 404 });
  await expect(media.content(otherToken, job.images[0].id)).rejects.toMatchObject({ status: 404 });
  await expect(media.resolveIllustrations([{ id: job.images[0].id }], { account: other, name: draft.name, description: draft.description })).rejects.toMatchObject({ status: 400 });
  await db.updateAccount(request.credentials().account.id, { disabled: true });
  expect((await request(app).get(base + '/' + job.images[0].id)).status).not.toBe(200);
});

test('a running image job holds the AI gate until cancellation and does not import partial output', async () => {
  mode = 'running';
  const response = await request(app).post(base + '/jobs').send(draft);
  expect(response.status).toBe(200); const id = response.body.data.id;
  await expect(runtime.generate(async () => 'must not run')).rejects.toMatchObject({ code: 'AI_BUSY' });
  expect((await request(app).delete(base + '/jobs/' + id)).status).toBe(200);
  expect((await finish(id)).status).toBe('cancelled');
  expect(await runtime.generate(async () => 'free')).toBe('free');
  expect((await media.getJob(token(), id)).images).toEqual([]);
  expect(sent.some(call => call.method === 'DELETE' && call.path.endsWith(id))).toBe(true);
});

test.each([
  ['IMAGE_STARTUP_TIMEOUT', /did not become ready/],
  ['IMAGE_UNAVAILABLE', /installed image model or runtime is unavailable/],
])('a failed worker stage %s is safe to display and releases the Pi guard for the next text request', async (code, message) => {
  const normal = transport.request.getMockImplementation();
  transport.request.mockImplementation(async (...args) => {
    const result = await normal(...args);
    return args[1] === 'POST' ? { ...worker('failed'), code, message: 'PRIVATE prompt C:\\private\\model secret-token' } : result;
  });
  const response = await request(app).post(base + '/jobs').send(draft);
  expect(response.status).toBe(200);
  const result = await finish(response.body.data.id);
  expect(result).toMatchObject({ status: 'failed', code, images: [] });
  expect(result.message).toMatch(message);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret-token|C:\\private/);
  expect(sent.some(call => call.method === 'DELETE')).toBe(true);
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"done":true,"response":"Text request admitted."}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const text = await runtime.generate(() => runtime.jsonRequest({ url: new URL('http://127.0.0.1:' + server.address().port) },
      'POST', '/api/generate', { model: 'synthetic-local' }, AbortSignal.timeout(1000)));
    expect(text).toEqual({ done: true, response: 'Text request admitted.' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.each(['unknown-failure', '__proto__', 'IMAGE_STARTUP_TIMEOUT\nPRIVATE'])('unknown worker diagnostics never become application messages: %s', async code => {
  const normal = transport.request.getMockImplementation();
  transport.request.mockImplementation(async (...args) => {
    const result = await normal(...args);
    return args[1] === 'POST' ? { ...worker('failed'), code, message: 'PRIVATE exception body' } : result;
  });
  const response = await request(app).post(base + '/jobs').send(draft);
  expect(response.status).toBe(200);
  const result = await finish(response.body.data.id);
  expect(result).toMatchObject({ status: 'failed', code: 'IMAGE_GENERATION_FAILED', images: [] });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(await runtime.generate(async () => 'free')).toBe('free');
});

test('uncertain GPU cleanup is a failed job requiring worker recovery, never a successful cancellation', async () => {
  mode = 'running'; const normal = transport.request.getMockImplementation();
  transport.request.mockImplementation(async (...args) => {
    const result = await normal(...args);
    return args[1] === 'DELETE' ? { ...worker('failed'), code: 'IMAGE_CLEANUP' } : result;
  });
  const response = await request(app).post(base + '/jobs').send(draft);
  expect(response.status).toBe(200);
  expect((await request(app).delete(base + '/jobs/' + response.body.data.id)).status).toBe(200);
  const result = await finish(response.body.data.id);
  expect(result).toMatchObject({ status: 'failed', code: 'IMAGE_CLEANUP', images: [] });
  expect(result.message).toMatch(/Restart the SKAO Activity Images worker/);
});

test('an unavailable poisoned worker is described as requiring recovery rather than waiting for ordinary busy work', async () => {
  transport.request.mockResolvedValue({ version: 1, enabled: true, available: false, busy: true, model, code: 'WORKER_RESTART_REQUIRED', message: 'PRIVATE reason' });
  const response = await request(app).get(base + '/status');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ available: false, code: 'WORKER_RESTART_REQUIRED' });
  expect(response.body.data.message).toMatch(/restarted/);
  expect(response.body.data.message).not.toMatch(/Try again shortly|PRIVATE/);
});

test('an aborted POST with a lost reply cancels the same known worker ID before releasing the AI gate', async () => {
  const normal = transport.request.getMockImplementation(), controller = new AbortController();
  transport.request.mockImplementation(async (config, method, path, value, signal, binary) => {
    if (method === 'POST') {
      workerId = value.requestId; workerSteps = value.steps;
      sent.push({ method, path, value, binary });
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    if (method === 'DELETE') {
      sent.push({ method, path, value, binary });
      return { version: 1, id: workerId, status: 'cancelled', total: 0, completed: 0, frames: [] };
    }
    return normal(config, method, path, value, signal, binary);
  });
  const pending = media.createJob(token(), draft, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'AI_IMAGES_UNAVAILABLE' });
  const deadline = Date.now() + 3000;
  while (!workerId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(workerId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(runtime.generate(async () => 'must not overlap')).rejects.toMatchObject({ code: 'AI_BUSY' });
  controller.abort(); await rejected;
  expect(sent.find(call => call.method === 'DELETE').path).toBe('/api/activity-images/jobs/' + workerId);
  expect((await media.getJob(token(), workerId)).status).toBe('cancelled');
  expect(await runtime.generate(async () => 'free')).toBe('free');
});

test('an upstream checksum mismatch fails safely without storing pixels or keeping the GPU gate', async () => {
  const normal = transport.request.getMockImplementation();
  transport.request.mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[1] === 'POST') result.frames[0].sha256 = '0'.repeat(64);
    return result;
  });
  const response = await request(app).post(base + '/jobs').send(draft);
  expect(response.status).toBe(200);
  const result = await finish(response.body.data.id);
  expect(result.status).toBe('failed'); expect(result.images).toEqual([]);
  expect(await db.activityMediaUsage()).toEqual({ count: 0, bytes: 0 });
  expect(sent.some(call => call.method === 'DELETE')).toBe(true);
  expect(await runtime.generate(async () => 'free')).toBe('free');
});

test.each([
  { ...draft, steps: [] }, { ...draft, steps: ['same', 'same'] }, { ...draft, steps: ['x'.repeat(501)] },
  { ...draft, steps: ['Read https://example.org/private'] }, { ...draft, roomId: randomUUID() },
])('malformed picture inputs are rejected before contacting the laptop: %j', async payload => {
  const response = await request(app).post(base + '/jobs').send(payload);
  expect(response.status).toBe(400); expect(sent).toEqual([]);
});
