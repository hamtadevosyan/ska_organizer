const http = require('node:http');
const db = require('../services/dbAdapter');
const service = require('../services/localActivityAi');
const knowledge = require('../services/localActivityKnowledge');
const videos = require('../services/activityVideoExamples');

let runtime, address, calls, replies, generate, sockets;
const savedEnvironment = Object.fromEntries(['SKAO_AI_MODEL', 'SKAO_AI_URL', 'SKAO_AI_TIMEOUT_MS', 'SKAO_AI_SOURCES_FILE'].map(key => [key, process.env[key]]));
const known = { id: 'synthetic-education', title: 'Synthetic public teaching reference', publisher: 'Test fixture', version: '1',
  section: 'Language', kind: 'education', text: 'Adults can help children describe colors and shapes.' };
const modelDraft = (changes = {}) => ({ name: 'Color story circle',
  purpose: 'Practice describing colors, shapes and ideas in a small group.',
  preparation: 'An adult checks large colorful cards and sets them on a clear table.',
  steps: ['The adult shows a large colorful card and names its color and shape.',
    'Invite each child to choose a card and describe what they notice.',
    'Help children arrange their cards together and tell a short shared story.',
    'Invite the group to retell the story while the adult points to each card.'],
  conversationPrompts: ['What do you notice about this shape?', 'What could happen next in our story?'],
  adaptations: 'Younger children can point or name colors; older children can explain their choices.',
  safety: 'An adult supervises throughout and uses large cards without loose or sharp pieces.',
  cleanup: 'Invite children to collect the cards and help clear the table.',
  durationMinutes: 15, materialsNotes: 'Large colorful cards. Check age suitability and Inventory quantities.', sourceIds: [], videoIds: [], ...changes });
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
  expect(JSON.parse(body.prompt)).toEqual({ task: 'activity_drafts', ageMinMonths: 24, ageMaxMonths: 60, focus: 'language', theme: 'Colors', activityCount: 1, durationMinutes: 20, sources: [known], videoExamples: videos.forModel() });
  expect(JSON.stringify(body)).not.toContain('Private synthetic child'); expect(JSON.stringify(body)).not.toContain(target.name); expect(JSON.stringify(body)).not.toContain(target.id);
  expect(body).toMatchObject({ stream: false, keep_alive: 0, think: false, options: { num_predict: 4096, num_ctx: 8192 } });
  expect(body).not.toHaveProperty('tools'); expect(body.system).toMatch(/untrusted reference data/);
  expect(body.system).toMatch(/4 to 6 distinct concrete steps/);
  expect(body.format.properties.drafts.items.properties.steps).toMatchObject({ minItems: 4, maxItems: 6 });
  expect(body.format.properties.drafts.items.properties).not.toHaveProperty('description');
  const guide = modelDraft(), description = result.drafts[0].description;
  expect(description).toBe('Purpose: ' + guide.purpose + '\n\nPreparation: ' + guide.preparation +
    '\n\nHow to do it:\n' + guide.steps.map((step, index) => (index + 1) + '. ' + step).join('\n') +
    '\n\nAsk the children:\n' + guide.conversationPrompts.map(prompt => '- ' + prompt).join('\n') +
    '\n\nAdaptations: ' + guide.adaptations + '\n\nSupervision and safety: ' + guide.safety + '\n\nCleanup: ' + guide.cleanup);
  expect(result.drafts[0].tutorialLinks).toEqual([]);
  expect(calls.every(call => !call.headers.cookie && !call.headers.authorization)).toBe(true);
  expect(await db.listActivities()).toEqual(before); expect(await db.listAudit({})).toEqual(audit);
});

test('a supplied video ID resolves to fixed publisher metadata without sending URLs to inference', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ videoIds: ['pbs-shape-collage'] })] }) }))); };
  const result = await service.draft(input(await room()));
  expect(result.drafts[0].tutorialLinks).toEqual([{
    title: 'Create Colorful Collages to Learn About Shapes', publisher: 'PBS SoCal — Family Math',
    url: 'https://www.pbs.org/video/create-colorful-collages-to-learn-about-shapes/',
  }]);
  const body = calls.at(-1).body, prompt = JSON.parse(body.prompt);
  expect(prompt.videoExamples).toEqual(videos.forModel());
  expect(prompt.videoExamples.every(example => Object.keys(example).sort().join(',') === 'id,summary,title')).toBe(true);
  expect(JSON.stringify(prompt.videoExamples)).not.toMatch(/https?:\/\//);
  expect(body.format.properties.drafts.items.properties.videoIds).toEqual({ type: 'array', maxItems: 1,
    items: { type: 'string', enum: videos.forModel().map(example => example.id) } });
  expect(await db.listActivities()).toEqual([]);
});

test('disabling video examples leaves the richer guide available without any media request', async () => {
  const result = await service.draft({ ...input(await room()), includeVideos: false });
  expect(result.drafts[0].description).toContain('How to do it:\n1. ');
  expect(result.drafts[0].tutorialLinks).toEqual([]);
  const body = calls.at(-1).body;
  expect(JSON.parse(body.prompt).videoExamples).toEqual([]);
  expect(body.format.properties.drafts.items.properties.videoIds.maxItems).toBe(0);
  expect(calls.map(call => call.path)).toEqual(['/api/status', '/api/tags', '/api/show', '/api/generate']);
});

test('video IDs cannot bypass the user choice to disable examples', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ videoIds: ['pbs-shape-collage'] })] }) }))); };
  await expect(service.draft({ ...input(await room()), includeVideos: false })).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  expect(await db.listActivities()).toEqual([]);
});

test('five complete guides at the supported field bounds fit the saved description budget', async () => {
  const drafts = Array.from({ length: 5 }, (_, index) => modelDraft({ name: 'Complete guide ' + (index + 1),
    purpose: 'P'.repeat(160), preparation: 'R'.repeat(200), adaptations: 'A'.repeat(200),
    safety: 'S'.repeat(200), cleanup: 'C'.repeat(120), materialsNotes: 'M'.repeat(1000),
    steps: Array.from({ length: 6 }, (_, step) => String(step + 1) + ' do this action '.padEnd(169, 'x')),
    conversationPrompts: ['What happens? '.padEnd(100, 'a'), 'What changes? '.padEnd(100, 'b')],
  }));
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts }) }))); };
  const result = await service.draft({ ...input(await room()), activityCount: 5 });
  expect(result.drafts).toHaveLength(5);
  for (const draft of result.drafts) {
    expect(draft.description.length).toBeLessThanOrEqual(2500);
    expect(draft.description).toContain('\n6. 6 do this action ');
    expect(draft.description.endsWith('C'.repeat(120))).toBe(true);
  }
  expect(calls.at(-1).body.format.properties.drafts).toMatchObject({ minItems: 5, maxItems: 5 });
  expect(await db.listActivities()).toEqual([]);
});

const incompleteGuide = field => {
  const draft = modelDraft(); delete draft[field]; return draft;
};
test.each([
  ['only three steps', modelDraft({ steps: modelDraft().steps.slice(0, 3) })],
  ['more than six steps', modelDraft({ steps: Array.from({ length: 7 }, (_, index) => 'Step ' + index + ': adults help children notice shapes.') })],
  ['a short step', modelDraft({ steps: [...modelDraft().steps.slice(0, 3), 'Play.'] })],
  ['duplicate steps after trimming and case folding', modelDraft({ steps: [...modelDraft().steps.slice(0, 3), '  ' + modelDraft().steps[0].toUpperCase() + '  '] })],
  ['a URL inside a step', modelDraft({ steps: [...modelDraft().steps.slice(0, 3), 'Visit https://external.invalid to continue this activity.'] })],
  ['no conversation prompts', modelDraft({ conversationPrompts: [] })],
  ['a too-short purpose', modelDraft({ purpose: 'Play.' })],
  ['a missing safety section', incompleteGuide('safety')],
  ['a missing cleanup section', incompleteGuide('cleanup')],
  ['a missing video selection', incompleteGuide('videoIds')],
  ['invented video ID', modelDraft({ videoIds: ['invented-tutorial'] })],
  ['video URL instead of an ID', modelDraft({ videoIds: ['https://external.invalid/video'] })],
  ['video object instead of an ID', modelDraft({ videoIds: [{ title: 'Fabricated', publisher: 'Invented', url: 'https://external.invalid/video' }] })],
  ['duplicate video selection', modelDraft({ videoIds: ['pbs-shape-collage', 'pbs-shape-collage'] })],
  ['model-supplied tutorial links', modelDraft({ tutorialLinks: [{ title: 'Fabricated', publisher: 'Invented', url: 'https://external.invalid/video' }] })],
])('incomplete or untrusted guide: %s is rejected without saving', async (label, invalid) => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [invalid] }) }))); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ status: 424, code: 'AI_INVALID_RESPONSE' });
  expect(await db.listActivities()).toEqual([]);
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
  { includeVideos: 'true' }, { includeVideos: null }, { includeVideos: 1 },
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
  { response: JSON.stringify({ drafts: [modelDraft({ preparation: '<img src="https://external.invalid">' })] }) },
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
