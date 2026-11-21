// Real CLI subprocesses with no node_modules, database modules or application hooks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const files = ['scripts/check-activity-ai.js', 'services/localAiStatus.js', 'services/localAiRuntime.js', 'services/localActivityKnowledge.js'];
async function fixture(t, dotenv) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skao-ai-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of files) {
    const destination = path.join(root, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(__dirname, '..', name), destination);
  }
  if (dotenv !== undefined) await fs.writeFile(path.join(root, '.env'), dotenv);
  return root;
}
async function check(root, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SKAO_AI_') && key !== 'NODE_ENV' && key !== 'NODE_OPTIONS'));
  try { return { code: 0, ...await execute(process.execPath, [path.join(root, 'scripts/check-activity-ai.js')], { cwd: '/', env: { ...env, ...extra }, timeout: 15000 }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function runtime(t, cloud = true) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.method + ' ' + request.url);
    response.setHeader('Content-Type', 'application/json');
    const content = request.url === '/api/status' ? { cloud: { disabled: cloud } } : request.url === '/api/tags' ? { models: [{ name: 'synthetic:v1', digest: 'a'.repeat(64), size: 1234 }] } : request.url === '/api/show' ? { model_info: { architecture: 'synthetic' } } : {};
    response.end(JSON.stringify(content));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, url: 'http://127.0.0.1:' + server.address().port };
}
test('metadata check succeeds without application/database dependencies and changes no files', async t => {
  const mock = await runtime(t);
  const root = await fixture(t, 'DATABASE_URL=postgres://synthetic:PRIVATE_CANARY@invalid/db\nDATABASE_URL_FILE=/does/not/exist\nSKAO_AI_MODEL=synthetic:v1\nSKAO_AI_URL=' + mock.url + '\n');
  const before = await Promise.all([...files, '.env'].map(name => fs.readFile(path.join(root, name), 'utf8')));
  const result = await check(root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Local activity AI: ready/);
  assert.deepEqual(mock.requests, ['GET /api/status', 'GET /api/tags', 'POST /api/show']);
  assert.deepEqual(await Promise.all([...files, '.env'].map(name => fs.readFile(path.join(root, name), 'utf8'))), before);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CANARY|DATABASE_URL|does\/not\/exist/);
});
test('explicit exported empty model wins over checkout configuration', async t => {
  const mock = await runtime(t);
  const root = await fixture(t, 'SKAO_AI_MODEL=synthetic:v1\nSKAO_AI_URL=' + mock.url + '\n');
  const result = await check(root, { SKAO_AI_MODEL: '' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /AI_NOT_CONFIGURED/);
  assert.deepEqual(mock.requests, []);
});
test('test mode never reads private checkout configuration', async t => {
  const root = await fixture(t, 'SKAO_AI_MODEL=private-canary\nSKAO_AI_SOURCES_FILE=/private/path\n');
  const result = await check(root, { NODE_ENV: 'test' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /AI_NOT_CONFIGURED/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-canary|private\/path/);
});
test('rejected cloud-enabled runtime stops before model metadata or inference', async t => {
  const mock = await runtime(t, false);
  const root = await fixture(t, 'SKAO_AI_MODEL=synthetic:v1\nSKAO_AI_URL=' + mock.url + '\n');
  const result = await check(root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /AI_LOCAL_ONLY_REQUIRED/);
  assert.deepEqual(mock.requests, ['GET /api/status']);
});
test('unexpected errors expose only fixed stage and allowlisted code', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'services/localAiStatus.js'), "throw Object.assign(new Error('PRIVATE_TOKEN /private/key'), {code:'PRIVATE_ERROR_CODE'})");
  const result = await check(root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /verify authenticated AI metadata \[AI_CHECK_FAILED\]/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_|private\/key|stack/);
});
