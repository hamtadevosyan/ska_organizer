const http = require('node:http');
const crypto = require('node:crypto');
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
const collageDraft = (changes = {}) => modelDraft({ name: 'Paper shape collage',
  purpose: 'Explore shapes by making a shared paper collage.', preparation: 'An adult cuts large paper shapes and sets out washable glue.',
  steps: ['Show children large paper shapes and talk about their edges.',
    'Invite each child to choose two paper shapes for the collage.',
    'Help children arrange and attach their paper shapes with glue.',
    'Describe the finished collage and leave it to dry together.'],
  materialsNotes: 'Large paper shapes, a paper base and washable glue.', ...changes });
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
  expect(JSON.parse(body.prompt)).toEqual({ task: 'activity_drafts', ageMinMonths: 24, ageMaxMonths: 60, focus: 'language', theme: 'Colors', activityCount: 1, durationMinutes: 20, sources: [known], videoExamples: [], avoidNames: [], responseSchema: body.format });
  expect(JSON.stringify(body)).not.toContain('Private synthetic child'); expect(JSON.stringify(body)).not.toContain(target.name); expect(JSON.stringify(body)).not.toContain(target.id);
  expect(body).toMatchObject({ stream: false, keep_alive: 0, think: false, options: { num_predict: 4096, num_ctx: 8192, temperature: 0.55 } });
  expect(body).not.toHaveProperty('tools'); expect(body.system).toMatch(/untrusted reference data/);
  expect(body.system).toMatch(/4 to 6 distinct concrete steps/);
  expect(body.format.properties.drafts.items.properties.steps).toMatchObject({ minItems: 4, maxItems: 6 });
  expect(body.format.properties.drafts.items.properties).not.toHaveProperty('description');
  expect(body.format.properties.drafts.items.properties.sourceIds.items.enum).toEqual([known.id]);
  expect(body.format.properties.drafts.items.properties.durationMinutes.enum).toEqual(Array.from({ length: 16 }, (_, index) => index + 5));
  const guide = modelDraft(), description = result.drafts[0].description;
  expect(description).toBe('Purpose: ' + guide.purpose + '\n\nPreparation: ' + guide.preparation +
    '\n\nHow to do it:\n' + guide.steps.map((step, index) => (index + 1) + '. ' + step).join('\n') +
    '\n\nAsk the children:\n' + guide.conversationPrompts.map(prompt => '- ' + prompt).join('\n') +
    '\n\nAdaptations: ' + guide.adaptations + '\n\nSupervision and safety: ' + guide.safety + '\n\nCleanup: ' + guide.cleanup);
  expect(result.drafts[0].tutorialLinks).toEqual([]);
  expect(calls.every(call => !call.headers.cookie && !call.headers.authorization)).toBe(true);
  expect(await db.listActivities()).toEqual(before); expect(await db.listAudit({})).toEqual(audit);
});

test('a locally matched how-to video is attached after generation without exposing its catalog to inference', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [collageDraft()] }) }))); };
  const result = await service.draft(input(await room()));
  expect(result.drafts[0].tutorialLinks).toEqual([{
    title: 'Create Colorful Collages to Learn About Shapes', publisher: 'PBS SoCal — Family Math',
    url: 'https://www.pbs.org/video/create-colorful-collages-to-learn-about-shapes/',
  }]);
  const body = calls.at(-1).body, prompt = JSON.parse(body.prompt);
  expect(prompt.videoExamples).toEqual([]);
  expect(body.prompt).not.toMatch(/pbs-shape-collage|pbs-newspaper-city|pbs-number-bingo|pbs-pattern-loom|Create Colorful Collages|Newspaper City|Number Bingo|https?:\/\//);
  expect(body.format.properties.drafts.items.properties.videoIds).toEqual({ type: 'array', maxItems: 0, items: { type: 'string' } });
  expect(await db.listActivities()).toEqual([]);
});

test('enabling videos does not change generation context and disabling them skips a related link', async () => {
  const target = await room();
  const seeds = jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(101).mockReturnValueOnce(202);
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [collageDraft()] }) }))); };
  const enabled = await service.draft({ ...input(target), includeVideos: true });
  const result = await service.draft({ ...input(target), includeVideos: false });
  expect(enabled.drafts[0].tutorialLinks).toHaveLength(1);
  expect(result.drafts[0].description).toContain('How to do it:\n1. ');
  expect(result.drafts[0].tutorialLinks).toEqual([]);
  const body = calls.at(-1).body;
  expect(JSON.parse(body.prompt).videoExamples).toEqual([]);
  expect(body.format.properties.drafts.items.properties.sourceIds.maxItems).toBe(0);
  expect(body.format.properties.drafts.items.properties.videoIds.maxItems).toBe(0);
  const generation = calls.filter(call => call.path === '/api/generate');
  expect(generation).toHaveLength(2);
  expect(generation[0].body.prompt).toEqual(generation[1].body.prompt);
  expect(generation[0].body.format).toEqual(generation[1].body.format);
  expect(generation.map(call => call.body.options.seed)).toEqual([101, 202]);
  expect(seeds.mock.calls).toEqual([[2147483647], [2147483647]]);
  expect(calls.map(call => call.path)).toEqual(['/api/status', '/api/tags', '/api/show', '/api/generate', '/api/status', '/api/tags', '/api/show', '/api/generate']);
});

test('a novel activity remains available when the small video collection has no matching procedure', async () => {
  const result = await service.draft({ ...input(await room()), theme: 'Color stories', includeVideos: true });
  expect(result.drafts[0]).toMatchObject({ name: 'Color story circle', tutorialLinks: [] });
  expect(result.drafts[0].description).toContain('How to do it:\n1. ');
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
});

test('repeated requests use fresh seeds and preserve the chosen theme, focus and age range', async () => {
  const seeds = jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(3301).mockReturnValueOnce(4402);
  const target = await room();
  const values = { ...input(target), focus: 'creative', theme: 'Thanksgiving' };
  await service.draft(values); await service.draft(values);
  const requests = calls.filter(call => call.path === '/api/generate');
  expect(requests.map(call => call.body.options)).toEqual([
    expect.objectContaining({ seed: 3301, temperature: 0.55 }),
    expect.objectContaining({ seed: 4402, temperature: 0.55 }),
  ]);
  for (const request of requests) expect(JSON.parse(request.body.prompt)).toMatchObject({
    focus: 'creative', theme: 'Thanksgiving', ageMinMonths: 24, ageMaxMonths: 60,
    avoidNames: [], videoExamples: [],
  });
  expect(seeds).toHaveBeenCalledTimes(2);
  expect(await db.listActivities()).toEqual([]);
});

test('only explicit recent draft names are sent for avoidance, never saved library records', async () => {
  const target = await room();
  await db.createActivity({ name: 'Private catalog child name is never sent', description: 'Private staff note.', durationMinutes: 15, materials: [] });
  const before = await db.listActivities();
  await service.draft({ ...input(target), avoidNames: ['  Earlier generated idea  ', 'Another prior draft'] });
  const body = calls.at(-1).body;
  expect(JSON.parse(body.prompt).avoidNames).toEqual(['Earlier generated idea', 'Another prior draft']);
  expect(body.system).toMatch(/untrusted reference data/);
  expect(body.system).toMatch(/avoidNames/);
  expect(JSON.stringify(body)).not.toContain('Private catalog child name');
  expect(JSON.stringify(body)).not.toContain('Private staff note');
  expect(await db.listActivities()).toEqual(before);
});

test('the supported twenty-name avoidance history is bounded and accepted', async () => {
  const avoidNames = Array.from({ length: 20 }, (_, index) => 'Earlier generated idea ' + index);
  const result = await service.draft({ ...input(await room()), avoidNames });
  expect(result.drafts).toHaveLength(1);
  expect(JSON.parse(calls.at(-1).body.prompt).avoidNames).toEqual(avoidNames);
});

test.each(['Color story circle', '  COLOR—STORY... CIRCLE  ', 'Ｃｏｌｏｒ Ｓｔｏｒｙ Ｃｉｒｃｌｅ'])('a recent idea %j cannot be repeated through case, punctuation or Unicode variants', async name => {
  await expect(service.draft({ ...input(await room()), avoidNames: [name] })).rejects.toMatchObject({
    code: 'AI_INVALID_RESPONSE', validationReason: 'RECENT_IDEA',
  });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
  expect(JSON.parse(calls.at(-1).body.prompt).correction).toEqual({ reason: 'RECENT_IDEA' });
  expect(await db.listActivities()).toEqual([]);
});

test('one bounded correction can replace a recent idea and uses a separate conservative seed', async () => {
  const seeds = jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(501).mockReturnValueOnce(602);
  let attempt = 0;
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(++attempt === 1 ? modelReply() : modelReply({ response: JSON.stringify({ drafts: [modelDraft({ name: 'Cooperative color story puppets' })] }) }))); };
  const result = await service.draft({ ...input(await room()), avoidNames: ['Color story circle'] });
  expect(result.drafts[0].name).toBe('Cooperative color story puppets');
  const requests = calls.filter(call => call.path === '/api/generate');
  expect(requests).toHaveLength(2);
  expect(requests.map(call => call.body.options)).toEqual([
    expect.objectContaining({ seed: 501, temperature: 0.55 }),
    expect.objectContaining({ seed: 602, temperature: 0.2 }),
  ]);
  expect(seeds).toHaveBeenCalledTimes(2);
  expect(await db.listActivities()).toEqual([]);
});

test('name uniqueness within a batch uses the same normalization as recent-idea avoidance', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft(), modelDraft({ name: 'COLOR—STORY... CIRCLE' })] }) }))); };
  await expect(service.draft({ ...input(await room()), activityCount: 2 })).rejects.toMatchObject({
    code: 'AI_INVALID_RESPONSE', validationReason: 'DUPLICATE_NAMES',
  });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
  expect(await db.listActivities()).toEqual([]);
});

test('video IDs cannot bypass the user choice to disable examples', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ videoIds: ['pbs-shape-collage'] })] }) }))); };
  await expect(service.draft({ ...input(await room()), includeVideos: false })).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  expect(await db.listActivities()).toEqual([]);
});

test('a generated guide is fully validated before any optional local video match', async () => {
  const match = jest.spyOn(videos, 'match');
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [collageDraft({ safety: 'Visit https://unsafe.invalid before starting.' })] }) }))); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE', validationReason: 'UNSAFE_TEXT' });
  expect(match).not.toHaveBeenCalled();
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

test('meaningful short sections and steps are kept without arbitrary character padding', async () => {
  const brief = modelDraft({ purpose: 'Practice counting.', preparation: 'Set out counters.',
    steps: ['Show two counters.', 'Count them together.', 'Sort the counters.', 'Count each group.'],
    conversationPrompts: ['How many?'], adaptations: 'Use fewer counters.', safety: 'Supervise closely.', cleanup: 'Wash hands.' });
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [brief] }) }))); };
  const result = await service.draft(input(await room()));
  expect(result.drafts[0].description).toContain('Purpose: Practice counting.');
  expect(result.drafts[0].description).toContain('\n4. Count each group.');
  expect(result.drafts[0].description).toContain('\n- How many?');
  expect(result.drafts[0].description.endsWith('Cleanup: Wash hands.')).toBe(true);
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
  const rules = calls.at(-1).body.format.properties.drafts.items.properties;
  for (const key of ['purpose', 'preparation', 'adaptations', 'safety', 'cleanup']) expect(rules[key].minLength).toBe(1);
  expect(rules.steps.items.minLength).toBe(1); expect(rules.conversationPrompts.items.minLength).toBe(1);
  expect(await db.listActivities()).toEqual([]);
});

test('trimmed Unicode character bounds agree with the supplied JSON schema', async () => {
  const purpose = 'Count ' + '🟦'.repeat(154);
  expect(Array.from(purpose)).toHaveLength(160);
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ purpose: '  ' + purpose + '  ',
      preparation: '  ' + 'P'.repeat(200) + '  ' })] }) }))); };
  const result = await service.draft(input(await room()));
  expect(result.drafts[0].description.startsWith('Purpose: ' + purpose + '\n\nPreparation: ' + 'P'.repeat(200))).toBe(true);
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
});

test('a Unicode name that exceeds the catalog storage limit is never returned as a saveable draft', async () => {
  const name = 'Sort ' + '🟦'.repeat(95);
  expect(Array.from(name)).toHaveLength(100);
  expect(name.length).toBeGreaterThan(100);
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ name })] }) }))); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE', validationReason: 'TEXT_LIMIT' });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
  expect(await db.listActivities()).toEqual([]);
});

test.each([
  ['missing required details', modelReply({ response: JSON.stringify({ drafts: [(() => { const value = modelDraft(); delete value.cleanup; return value; })()] }) }), 'INVALID_SHAPE'],
  ['overlong section', modelReply({ response: JSON.stringify({ drafts: [modelDraft({ preparation: 'PrivateModelText-' + 'x'.repeat(201) })] }) }), 'TEXT_LIMIT'],
  ['duplicate steps', modelReply({ response: JSON.stringify({ drafts: [modelDraft({ steps: [modelDraft().steps[0], ...modelDraft().steps.slice(0, 3)] })] }) }), 'DUPLICATE_STEPS'],
  ['unknown source', modelReply({ response: JSON.stringify({ drafts: [modelDraft({ sourceIds: ['invented-reference'] })] }) }), 'UNKNOWN_SOURCE'],
  ['unknown video', modelReply({ response: JSON.stringify({ drafts: [modelDraft({ videoIds: ['invented-tutorial'] })] }) }), 'UNKNOWN_VIDEO'],
  ['truncated JSON', modelReply({ response: '{"drafts":[', done_reason: 'length' }), 'OUTPUT_TRUNCATED'],
])('one bounded regeneration repairs %s without replaying rejected model text', async (label, rejected, reason) => {
  let attempt = 0;
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(++attempt === 1 ? rejected : modelReply())); };
  const result = await service.draft(input(await room()));
  expect(result.drafts).toHaveLength(1);
  const requests = calls.filter(call => call.path === '/api/generate');
  expect(requests).toHaveLength(2);
  const original = JSON.parse(requests[0].body.prompt), repaired = JSON.parse(requests[1].body.prompt);
  expect(original).not.toHaveProperty('correction');
  expect(repaired).toEqual({ ...original, correction: { reason } });
  expect(requests[1].body.prompt).not.toContain('PrivateModelText-');
  expect(requests[1].body.format).toEqual(requests[0].body.format);
  expect(calls.filter(call => call.path === '/api/status')).toHaveLength(1);
  expect(await db.listActivities()).toEqual([]);
});

test('repeated invalid guides stop after two attempts with a content-free explanation', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ preparation: 'PrivateModelText-' + 'x'.repeat(201) })] }) }))); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE', validationReason: 'TEXT_LIMIT',
    message: 'An AI activity section exceeded its length limit. Nothing was saved.' });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
  expect(await db.listActivities()).toEqual([]);
});

test('a repeated token limit has an actionable explanation instead of accepting a partial guide', async () => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: '{"drafts":[', done_reason: 'length' }))); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE', validationReason: 'OUTPUT_TRUNCATED',
    message: 'The AI stopped before finishing the activity guides. Try fewer ideas. Nothing was saved.' });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
  expect(await db.listActivities()).toEqual([]);
});

test.each([
  ['a URL in instructions', modelReply({ response: JSON.stringify({ drafts: [modelDraft({ preparation: 'PrivateModelText https://user:secret@example.invalid/do-not-load' })] }) }), 'UNSAFE_TEXT'],
  ['markup in instructions', modelReply({ response: JSON.stringify({ drafts: [modelDraft({ purpose: '<script>PrivateModelText</script>' })] }) }), 'UNSAFE_TEXT'],
  ['remote response metadata', modelReply({ remote_host: 'https://user:secret@example.invalid/PrivateModelText' }), 'UNVERIFIED_RESPONSE'],
  ['excessive response text', modelReply({ response: 'PrivateModelText' + 'x'.repeat(65536) }), 'RESPONSE_LIMIT'],
])('%s is rejected immediately without regeneration or content in the error', async (label, rejected, reason) => {
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(rejected)); };
  const error = await service.draft(input(await room())).then(() => { throw new Error('Expected failure.'); }, value => value);
  expect(error).toMatchObject({ code: 'AI_INVALID_RESPONSE', validationReason: reason, retryable: false });
  expect(error.message).not.toMatch(/PrivateModelText|secret|example\.invalid|<script>/);
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
  expect(await db.listActivities()).toEqual([]);
});

test('an inference network failure is not retried', async () => {
  generate = async (req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); };
  await expect(service.draft(input(await room()))).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
});

test('the API returns only the fixed safe failure explanation, not model text or credentials', async () => {
  const request = require('./helpers/authenticatedRequest'), app = require('../index');
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(modelReply({ response: JSON.stringify({ drafts: [modelDraft({ preparation: 'PrivateModelText https://user:secret@example.invalid/do-not-load' })] }) }))); };
  const response = await request(app).post('/api/activity-ai/draft').send(input(await room()));
  expect(response.status).toBe(424);
  expect(response.body).toEqual({ error: { code: 'AI_INVALID_RESPONSE',
    message: 'The AI included unsupported links or markup in its instructions. Nothing was saved.' } });
  expect(JSON.stringify(response.body)).not.toMatch(/PrivateModelText|secret|example\.invalid|retryable|validationReason/);
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
  expect(await db.listActivities()).toEqual([]);
});

test('the repair attempt keeps the original deadline and busy guard', async () => {
  let attempt = 0, repairStarted;
  const waiting = new Promise(resolve => { repairStarted = resolve; });
  const timers = jest.spyOn(global, 'setTimeout');
  generate = async (req, res) => {
    if (++attempt === 1) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply({ response: '{' }))); }
    else repairStarted();
  };
  const target = await room(), pending = service.draft(input(target));
  await waiting;
  await expect(service.draft(input(target))).rejects.toMatchObject({ code: 'AI_BUSY' });
  await expect(pending).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  expect(timers.mock.calls.filter(([, duration]) => duration === 1000)).toHaveLength(1);
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
});

test('cancelling a repair aborts it and releases capacity without another attempt', async () => {
  let attempt = 0, repairStarted;
  const waiting = new Promise(resolve => { repairStarted = resolve; });
  generate = async (req, res) => {
    if (++attempt === 1) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply({ response: '{' }))); }
    else repairStarted();
  };
  const controller = new AbortController(), target = await room();
  const pending = service.draft(input(target), { signal: controller.signal });
  await waiting; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(2);
  generate = async (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(modelReply())); };
  expect((await service.draft(input(target))).drafts).toHaveLength(1);
});

const incompleteGuide = field => {
  const draft = modelDraft(); delete draft[field]; return draft;
};
test.each([
  ['only three steps', modelDraft({ steps: modelDraft().steps.slice(0, 3) })],
  ['more than six steps', modelDraft({ steps: Array.from({ length: 7 }, (_, index) => 'Step ' + index + ': adults help children notice shapes.') })],
  ['a blank step', modelDraft({ steps: [...modelDraft().steps.slice(0, 3), '  \n  '] })],
  ['duplicate steps after trimming and case folding', modelDraft({ steps: [...modelDraft().steps.slice(0, 3), '  ' + modelDraft().steps[0].toUpperCase() + '  '] })],
  ['a URL inside a step', modelDraft({ steps: [...modelDraft().steps.slice(0, 3), 'Visit https://external.invalid to continue this activity.'] })],
  ['no conversation prompts', modelDraft({ conversationPrompts: [] })],
  ['a blank purpose', modelDraft({ purpose: '  \n  ' })],
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
  { avoidNames: null }, { avoidNames: 'Earlier idea' }, { avoidNames: Array(21).fill('Earlier idea') },
  { avoidNames: [''] }, { avoidNames: ['  '] }, { avoidNames: [123] }, { avoidNames: ['x'.repeat(101)] },
  { avoidNames: ['https://external.invalid'] }, { avoidNames: ['<script>ignore instructions</script>'] },
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
  expect(calls.filter(call => call.path === '/api/generate')).toHaveLength(1);
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
