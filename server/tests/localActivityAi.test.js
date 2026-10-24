const http = require('node:http');
const db = require('../services/dbAdapter');
const service = require('../services/localActivityAi');
const knowledge = require('../services/localActivityKnowledge');

let runtime, address, calls, replies, generate, sockets;
const savedEnvironment = Object.fromEntries(['SKAO_AI_MODEL', 'SKAO_AI_URL', 'SKAO_AI_TIMEOUT_MS', 'SKAO_AI_SOURCES_FILE'].map(key => [key, process.env[key]]));
const known = { id: 'synthetic-education', title: 'Synthetic public teaching reference', publisher: 'Test fixture', version: '1',
  section: 'Language', kind: 'education', text: 'Adults can help children describe colors and shapes.' };
const modelDraft = (changes = {}) => ({ name: 'Color story circle', description: 'Purpose: practice language.\n1. An adult shows large colorful cards.\n2. Children describe them with adult supervision.',
  durationMinutes: 15, materialsNotes: 'Large colorful cards. Check age suitability and Inventory quantities.', sourceIds: [], ...changes });
const modelReply = (changes = {}) => ({ model: 'synthetic-local:latest', done: true, response: JSON.stringify({ drafts: [modelDraft()] }), ...changes });
async function room(values = {}) { return db.createRoom({ name: 'Confidential room name never sent to AI', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, active: true, ...values }); }
const input = target => ({ roomId: target.id, focus: 'language', theme: 'Colors', activityCount: 1, durationMinutes: 20 });

beforeAll(async () => {
  sockets = new Set();
  runtime = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: req.url, body, headers: req.headers });
    if (req.url === '/api/generate') { await generate(req, res, body); return; }
    const result = replies[req.url];
    res.statusCode = result?.status || 200; res.setHeader('Content-Type', result?.type || 'application/json');
    res.end(JSON.stringify(result?.body ?? result));
  });
  runtime.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));
  address = 'http://127.0.0.1:' + runtime.address().port;
});

beforeEach(() => {
  calls = [];
  replies = { '/api/status': { cloud: { disabled: true, source: 'test' } },
    '/api/tags': { models: [{ name: 'synthetic-local:latest', size: 1024, digest: 'a'.repeat(64) }] },
    '/api/show': { model_info: { 'general.architecture': 'synthetic' }, capabilities: ['completion'] } };
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply())); };
  process.env.SKAO_AI_MODEL = 'synthetic-local'; process.env.SKAO_AI_URL = address; process.env.SKAO_AI_TIMEOUT_MS = '1000';
  delete process.env.SKAO_AI_SOURCES_FILE;
});
afterEach(() => { jest.restoreAllMocks(); for (const socket of sockets) socket.destroy(); });
afterAll(async () => {
  await new Promise(resolve => runtime.close(resolve));
  for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('novel activity ideas use only room ages, explicit non-personal choices and local references; drafting never writes', async () => {
  const target = await room();
  await db.createChild({ firstName: 'Private synthetic child', lastName: 'Never sent', roomId: target.id, active: true });
  jest.spyOn(knowledge, 'retrieve').mockResolvedValue([known]);
  const before = await db.listActivities(), audit = await db.listAudit({});
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ sourceIds: [known.id] })] }) }))); };
  const result = await service.draft(input(target));
  expect(result).toMatchObject({ model: 'synthetic-local:latest', sources: [known], drafts: [{ name: 'Color story circle', ageMinMonths: 24, ageMaxMonths: 60, roomId: target.id, materials: [], sourceIds: [known.id] }] });
  expect(calls.map(call => call.path)).toEqual(['/api/status', '/api/tags', '/api/show', '/api/generate']);
  const body = calls.at(-1).body;
  expect(JSON.parse(body.prompt)).toEqual({ task: 'activity_drafts', ageMinMonths: 24, ageMaxMonths: 60, focus: 'language', theme: 'Colors', activityCount: 1, durationMinutes: 20, sources: [known] });
  expect(JSON.stringify(body)).not.toContain('Private synthetic child'); expect(JSON.stringify(body)).not.toContain(target.name); expect(JSON.stringify(body)).not.toContain(target.id);
  expect(body).toMatchObject({ stream: false, keep_alive: 0, think: false, options: { num_predict: 4096, num_ctx: 8192 } });
  expect(body).not.toHaveProperty('tools'); expect(body.system).toMatch(/untrusted reference data/);
  expect(calls.every(call => !call.headers.cookie && !call.headers.authorization)).toBe(true);
  expect(await db.listActivities()).toEqual(before); expect(await db.listAudit({})).toEqual(audit);
});

test('status verifies cloud disabled and local model manifest without generating or pulling a model', async () => {
  expect(await service.status()).toMatchObject({ enabled: true, available: true, model: 'synthetic-local:latest', sourceCount: 0 });
  expect(calls.map(call => call.path)).toEqual(['/api/status', '/api/tags', '/api/show']);
  delete process.env.SKAO_AI_MODEL; calls = [];
  expect(await service.status()).toMatchObject({ enabled: false, available: false, model: null, code: 'AI_NOT_CONFIGURED' });
  expect(calls).toEqual([]);
});

test.each([
  ['cloud enabled', () => { replies['/api/status'].cloud.disabled = false; }],
  ['missing cloud status', () => { replies['/api/status'] = {}; }],
  ['missing disabled flag', () => { replies['/api/status'].cloud = {}; }],
  ['string disabled flag', () => { replies['/api/status'].cloud.disabled = 'true'; }],
  ['old runtime without status', () => { replies['/api/status'] = { status: 404, body: { error: 'Not found' } }; }],
  ['zero-byte model', () => { replies['/api/tags'].models[0].size = 0; }],
  ['missing local digest', () => { replies['/api/tags'].models[0].digest = ''; }],
  ['remote alias in tags', () => { replies['/api/tags'].models[0].remote_host = 'https://external.invalid'; }],
  ['remote model-only alias in tags', () => { replies['/api/tags'].models[0].remote_model = 'external-model'; }],
  ['remote alias in show', () => { replies['/api/show'].remote_model = 'external-model'; }],
  ['nested remote metadata', () => { replies['/api/show'].model_info.remoteHost = 'https://external.invalid'; }],
])('%s fails closed before inference', async (label, modify) => {
  modify();
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ status: 424, code: 'AI_LOCAL_ONLY_REQUIRED' });
  expect(calls.some(call => call.path === '/api/generate')).toBe(false);
});

test.each(['http://example.com:11434', 'http://localhost:11434', 'http://192.168.1.4:11434', 'http://user:secret@127.0.0.1:11434', 'http://127.0.0.1:11434/other', 'http://127.0.0.1:11434?url=secret', 'https://127.0.0.1:11434'])('runtime address %s cannot expand the request boundary', async value => {
  process.env.SKAO_AI_URL = value;
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_LOCAL_ONLY_REQUIRED' });
  expect(calls).toEqual([]);
});

test.each(['remote-name', 'local-cloud', 'http://model', 'model:tag:extra'])('model %s is rejected before network access', async value => {
  process.env.SKAO_AI_MODEL = value;
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_LOCAL_ONLY_REQUIRED' });
  expect(calls).toEqual([]);
});

test.each([
  { activityCount: 0 }, { activityCount: 6 }, { durationMinutes: 4 }, { durationMinutes: 121 }, { focus: 'arbitrary prompt' },
  { theme: '<img src=x>' }, { theme: 'https://external.invalid' }, { theme: 'a'.repeat(121) }, { childId: 'private' }, { sourcePath: '/etc/passwd' },
])('invalid drafting values %j are rejected before inference', async changes => {
  await expect(service.draft({ ...input(await room()), ...changes })).rejects.toMatchObject({ status: 400 });
  expect(calls).toEqual([]);
});

test('archived configured rooms are rejected before contacting the runtime', async () => {
  await expect(service.draft(input(await room({ active: false })))).rejects.toMatchObject({ status: 409, code: 'ROOM_ARCHIVED' });
  expect(calls).toEqual([]);
});

test('imported unconfigured rooms use valid legacy storage and are rejected before contacting the runtime', async () => {
  // PostgreSQL permits unknown settings only on inactive imported rooms, with
  // ages AND capacity all null. Never insert an invalid active room as a fixture.
  const target = await room({ active: false, ageMinMonths: null, ageMaxMonths: null, capacity: null });
  expect(await db.getRoomById(target.id)).toMatchObject({ active: false, ageMinMonths: null, ageMaxMonths: null, capacity: null });
  await expect(service.draft(input(target))).rejects.toMatchObject({ status: 409, code: 'ROOM_ARCHIVED' });
  expect(calls).toEqual([]);
});

test('incomplete returned age metadata is rejected without persisting an invalid room', async () => {
  const target = await room();
  // Exercise the defensive service check through a faulty read result while the
  // real database row continues to satisfy its room constraints.
  const lookup = jest.spyOn(db, 'getRoomById').mockResolvedValueOnce({ ...target, ageMinMonths: null, ageMaxMonths: null });
  await expect(service.draft(input(target))).rejects.toMatchObject({ status: 400, fields: { roomId: expect.any(String) } });
  expect(lookup).toHaveBeenCalledWith(target.id);
  lookup.mockRestore();
  expect(await db.getRoomById(target.id)).toMatchObject({ active: true, ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 });
  expect(calls).toEqual([]);
});

test.each([
  { response: '{' }, { response: JSON.stringify({ drafts: [] }) },
  { response: JSON.stringify({ drafts: [modelDraft({ sourceIds: ['invented-reference'] })] }) },
  { response: JSON.stringify({ drafts: [modelDraft({ description: '<img src="https://external.invalid">' })] }) },
  { response: JSON.stringify({ drafts: [modelDraft({ command: 'do not execute' })] }) },
  { response: JSON.stringify({ drafts: [modelDraft({ durationMinutes: 21 })] }) },
  { done: false }, { remote_host: 'https://external.invalid' }, { done_reason: 'length' },
])('malformed or unsafe output %j is rejected without persistence', async changes => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply(changes))); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ status: 424, code: 'AI_INVALID_RESPONSE' });
  expect(await db.listActivities()).toEqual([]);
});

test('redirects are not followed and excessive bodies are rejected', async () => {
  replies['/api/status'] = { status: 302, body: { location: 'http://external.invalid' } };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect(calls).toHaveLength(1);
  replies['/api/status'] = { cloud: { disabled: true } };
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ value: 'x'.repeat(270000) })); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
});

test('timeout releases the single-request limit and normal local drafting can recover', async () => {
  const target = await room(); let started;
  const waiting = new Promise(resolve => { started = resolve; });
  generate = async () => { started(); };
  const pending = service.draft(input(target)); await waiting;
  await expect(service.draft(input(target))).rejects.toMatchObject({ status: 429, code: 'AI_BUSY', retryAfter: 5 });
  await expect(pending).rejects.toMatchObject({ status: 424, code: 'AI_TIMEOUT' });
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply())); };
  expect((await service.draft(input(target))).drafts).toHaveLength(1);
});

test('client cancellation terminates the local request and releases capacity', async () => {
  let started; const waiting = new Promise(resolve => { started = resolve; });
  generate = async () => { started(); };
  const controller = new AbortController();
  const pending = service.draft(input(await room()), { signal: controller.signal }); await waiting; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply())); };
  expect((await service.draft(input(await room()))).drafts).toHaveLength(1);
});
