'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const s = require('../settings.cjs'), api = require('../setup.cjs');
const uid = process.getuid(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'skao-ai-tests-'));
const certPath = path.join(scratch, 'ca.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=SKAO Synthetic Tests', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', path.join(scratch, 'key.pem'), '-out', certPath], { stdio: 'ignore' });
const certificate = fs.readFileSync(certPath);
const values = { SKAO_AI_MODEL: s.MODEL, SKAO_AI_LAN: '1', SKAO_AI_URL: 'https://192.168.20.20:8443', SKAO_AI_TOKEN: 's'.repeat(43), SKAO_AI_CA_FILE: s.CA, SKAO_AI_TIMEOUT_MS: '120000' };
function fixture(text = 'DATABASE_URL=keep-private-canary\n') {
  const root = fs.mkdtempSync(path.join(scratch, 'case-')), repo = path.join(root, 'repo'), home = path.join(root, 'home'), transfer = path.join(home, 'skao-ai-transfer');
  fs.mkdirSync(repo); fs.mkdirSync(home); fs.mkdirSync(path.join(repo, 'server')); fs.writeFileSync(path.join(repo, '.gitignore'), 'server/.env\n');
  execFileSync('git', ['init', '-q', repo]);
  const env = path.join(repo, 'server', '.env'); fs.writeFileSync(env, text, { mode: 0o600 });
  fs.mkdirSync(transfer, 0o700); fs.writeFileSync(path.join(transfer, 'ai.env'), s.KEYS.map(k => k + '=' + values[k]).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(transfer, 'ca.pem'), certificate, { mode: 0o600 });
  return { root, repo, home, transfer, env, opts: { repo, home, transfer, uid } };
}
function snapshot(folder) {
  return fs.readdirSync(folder, { recursive: true }).sort().map(name => {
    const file = path.join(folder, name), st = fs.lstatSync(file);
    return [name, st.mode, st.mtimeMs, st.ctimeMs, st.isFile() ? fs.readFileSync(file).toString('base64') : null];
  });
}
const absent = () => { throw Object.assign(new Error('private path canary'), { code: 'ENOENT' }); };
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
test('no AI and no transfer leaves an existing non-private env byte/mode/timestamps unchanged', () => {
  const f = fixture(); fs.rmSync(f.transfer, { recursive: true }); fs.chmodSync(f.env, 0o644); const before = snapshot(f.root);
  const result = api.prepare({ ...f.opts, installCa: () => assert.fail('sudo') });
  assert.equal(result.configured, false); assert.deepEqual(snapshot(f.root), before);
});
test('any existing blank model is authoritative and does not read a malformed stale transfer', () => {
  const f = fixture('DATABASE_URL=private\nSKAO_AI_MODEL=\n'); fs.chmodSync(f.transfer, 0o755); const before = fs.readFileSync(f.env);
  const result = api.prepare({ ...f.opts, installCa: () => assert.fail('sudo') });
  assert.equal(result.configured, false); assert.deepEqual(fs.readFileSync(f.env), before); assert.equal(s.hasReceipt(f.home, uid), true);
});
test('receipt prevents automatic reimport after all six settings were deliberately removed', () => {
  const f = fixture(); s.saveReceipt(f.home, uid); const before = snapshot(f.root);
  assert.equal(api.prepare(f.opts).configured, false); assert.deepEqual(snapshot(f.root), before);
});
test('first import validates and installs public CA, preserves unrelated env including sources, saves exact backup', () => {
  const original = '# keep comment\r\nDATABASE_URL="private-canary"\r\nSKAO_AI_SOURCES_FILE=/etc/reviewed.json\r\nOTHER=unchanged';
  const f = fixture(original); let installed = false, calls = 0;
  const result = api.prepare({ ...f.opts, loadCa: () => installed ? certificate : absent(), installCa: source => { assert.equal(source, path.join(f.transfer, 'ca.pem')); installed = true; calls++; } });
  assert.equal(calls, 1); assert.equal(result.changed, true); assert.equal(result.config.lan, true);
  const now = fs.readFileSync(f.env, 'utf8'); assert.ok(now.startsWith(original + '\r\n')); assert.ok(now.includes('SKAO_AI_MODEL=' + s.MODEL));
  const backup = fs.readdirSync(f.transfer).find(x => x.startsWith('ai-import-backup-'));
  assert.equal(fs.readFileSync(path.join(f.transfer, backup, 'server.env'), 'utf8'), original);
  assert.equal(fs.statSync(f.env).mode & 0o777, 0o600); assert.equal(s.hasReceipt(f.home, uid), true);
});
test('read-only first qualification uses transfer CA without import, chmod, receipt or sudo', () => {
  const f = fixture(); const before = snapshot(f.root);
  const result = api.prepare({ ...f.opts, readonly: true, loadCa: () => assert.fail('installed CA access'), installCa: () => assert.fail('sudo') });
  assert.ok(result.config.ca.equals(certificate)); assert.deepEqual(snapshot(f.root), before);
});
test('read-only check of configured LAN refuses absent installed CA and does not repair', () => {
  const f = fixture(s.KEYS.map(k => k + '=' + values[k]).join('\n')); const before = snapshot(f.root);
  assert.throws(() => api.prepare({ ...f.opts, readonly: true, loadCa: absent, installCa: () => assert.fail('sudo') }));
  assert.deepEqual(snapshot(f.root), before);
});
test('configured loopback ignores old remote transfer and CA, including when preparing offline', () => {
  const f = fixture('SKAO_AI_MODEL=small-local:1b\nSKAO_AI_URL=http://127.0.0.1:11434\n'); fs.chmodSync(f.transfer, 0o755); const before = fs.readFileSync(f.env);
  const result = api.prepare({ ...f.opts, loadCa: () => assert.fail('CA'), installCa: () => assert.fail('sudo') });
  assert.equal(result.config.lan, false); assert.deepEqual(fs.readFileSync(f.env), before);
});
test('matching manual settings and secure CA are adopted without import or backup, repeat is complete no-op', () => {
  const f = fixture('# existing\n' + s.KEYS.map(k => k + '=' + values[k]).join('\n') + '\n');
  const result = api.prepare({ ...f.opts, loadCa: () => certificate, installCa: () => assert.fail('sudo') });
  assert.equal(result.changed, false); assert.ok(!fs.readdirSync(f.transfer).some(x => x.startsWith('ai-import-backup-')));
  const before = snapshot(f.root); api.prepare({ ...f.opts, loadCa: () => certificate }); assert.deepEqual(snapshot(f.root), before);
});
test('existing installed different CA is preserved and import never happens', () => {
  const f = fixture(); const before = fs.readFileSync(f.env);
  assert.throws(() => api.prepare({ ...f.opts, loadCa: () => Buffer.from('different'), installCa: () => assert.fail('sudo') }), { code: 'AI_CA_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.env), before); assert.equal(s.hasReceipt(f.home, uid), false);
});
test('ambiguous AI assignment inside unrelated multiline value refuses before sudo', () => {
  const f = fixture('OTHER="one\nSKAO_AI_MODEL=not-an-assignment\nthree"\n');
  assert.throws(() => api.prepare({ ...f.opts, import: true, installCa: () => assert.fail('sudo') }), { code: 'AI_ENV_MULTILINE' });
});
test('duplicate AI assignments are replaced together while unrelated records and BOM survive', () => {
  const text = '\uFEFFDATABASE_URL=private\r\nexport SKAO_AI_MODEL=old\r\nSKAO_AI_MODEL=other\r\n# keep\r\n';
  const f = fixture(text), env = s.readEnvironment(f.repo, uid), updated = s.environmentPlan(env, values).toString();
  assert.equal((updated.match(/SKAO_AI_MODEL=/g) || []).length, 1); assert.ok(updated.startsWith('\uFEFFDATABASE_URL=private\r\n# keep\r\n'));
});
test('concurrent env change is preserved, private backup retained, and staging cleaned', () => {
  const f = fixture(), env = s.readEnvironment(f.repo, uid);
  assert.throws(() => s.importSettings(f.repo, env, values, uid, f.transfer, () => fs.writeFileSync(f.env, 'DATABASE_URL=concurrent\n')), { code: 'AI_ENV_CHANGED' });
  assert.equal(fs.readFileSync(f.env, 'utf8'), 'DATABASE_URL=concurrent\n'); assert.ok(!fs.readdirSync(path.dirname(f.env)).some(x => x.startsWith('.env.skao-ai-')));
});
test('symlinked incoming file and incorrect modes are refused without changes', () => {
  const f = fixture(); fs.chmodSync(path.join(f.transfer, 'ai.env'), 0o644); assert.throws(() => s.readTransfer(f.transfer, uid), { code: 'AI_FILE_UNSAFE' });
  fs.chmodSync(path.join(f.transfer, 'ai.env'), 0o600); fs.renameSync(path.join(f.transfer, 'ca.pem'), path.join(f.transfer, 'real.pem')); fs.symlinkSync('real.pem', path.join(f.transfer, 'ca.pem'));
  assert.throws(() => s.readTransfer(f.transfer, uid));
});
test('transfer requires exact allowed six keys and private canonical URL', () => {
  const f = fixture(); fs.appendFileSync(path.join(f.transfer, 'ai.env'), 'DATABASE_URL=do-not-read\n'); assert.throws(() => s.readTransfer(f.transfer, uid), { code: 'AI_TRANSFER_INVALID' });
  assert.equal(s.privateIp('1.2.3.4'), false); assert.equal(s.privateIp('192.168.1.1'), true); assert.equal(s.privateIp('127.0.0.1'), false);
});
test('metadata qualification uses only three requests by default and never inference', async () => {
  const seen = [], print = [];
  await api.qualify({ model: s.MODEL, lan: false }, { print: x => print.push(x), call: async (...args) => {
    seen.push(args.slice(1, 3)); const route = args[2];
    return route === '/api/status' ? { cloud: { disabled: true } } : route === '/api/tags' ? { models: [{ name: s.MODEL, size: 10, digest: s.DIGEST }] } : { model_info: { architecture: 'qwen3' } };
  } });
  assert.deepEqual(seen, [['GET', '/api/status'], ['GET', '/api/tags'], ['POST', '/api/show']]); assert.equal(print.length, 1);
});
test('LAN isolation checks follow authenticated metadata and require denial before raw port proof', async () => {
  const seen = [];
  await api.qualify({ model: s.MODEL, lan: true, url: new URL(values.SKAO_AI_URL) }, { print: () => {}, checkRaw: async () => seen.push('raw'), call: async (_c, _m, route, _body, auth, expected) => {
    seen.push([route, auth, expected]); return route === '/api/status' ? expected === 403 ? null : { cloud: { disabled: true } } : route === '/api/tags' ? { models: [{ name: s.MODEL, size: 10, digest: s.DIGEST }] } : { model_info: { architecture: 'qwen3' } };
  } });
  assert.deepEqual(seen.slice(-2), [['/api/status', false, 403], 'raw']);
});
test('explicit synthetic generation attempts unload even after failure and hides model output', async () => {
  const seen = [];
  await assert.rejects(api.qualify({ model: s.MODEL, lan: false }, { generate: true, print: () => {}, call: async (_c, _m, route, body) => {
    if (route === '/api/generate') { seen.push(body); return body.prompt ? { response: 'private model response canary', done: true } : {}; }
    return route === '/api/status' ? { cloud: { disabled: true } } : route === '/api/tags' ? { models: [{ name: s.MODEL, size: 10, digest: s.DIGEST }] } : { model_info: { architecture: 'qwen3' } };
  } }), e => e.message.includes('AI_SMOKE_FAILED') && !e.message.includes('canary'));
  assert.equal(seen.length, 2); assert.equal(seen[1].keep_alive, 0); assert.equal(Object.hasOwn(seen[1], 'prompt'), false);
});
test('read-only flags reject inference and import combinations', () => {
  for (const args of [['--check', '--test-generation'], ['--prepare', '--test-generation'], ['--diagnose', '--import'], ['--check', '--diagnose']]) assert.throws(() => api.argumentsFor(args), { code: 'AI_ARGUMENT_INVALID' });
  assert.equal(api.argumentsFor(['--prepare', '--if-configured']).prepare, true);
});
test('real native HTTP refuses redirect, bounds body and reports safe errors without env proxies', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://private-canary.invalid' }); res.end(); }
    else if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(' '.repeat(262145)); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"cloud":{"disabled":true}}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = { url: new URL('http://127.0.0.1:' + server.address().port) };
    assert.equal((await api.request(config, 'GET', '/api/status')).cloud.disabled, true);
    await assert.rejects(api.request(config, 'GET', '/redirect'), { code: 'AI_HTTP_302' });
    await assert.rejects(api.request(config, 'GET', '/huge'), { code: 'AI_RESPONSE_TOO_LARGE' });
    assert.equal(api.safeCode(new Error('secret canary')), 'AI_CHECK_FAILED');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('configured env with permissive mode is refused unchanged even when model is disabled', () => {
  const f = fixture('SKAO_AI_MODEL=\n'); fs.chmodSync(f.env, 0o644); const before = snapshot(f.root);
  assert.throws(() => api.prepare({ ...f.opts, readonly: true }), { code: 'AI_ENV_PERMISSIONS' });
  assert.throws(() => api.prepare(f.opts), { code: 'AI_ENV_PERMISSIONS' });
  assert.deepEqual(snapshot(f.root), before);
});
test('no-AI no-transfer update does not impose AI receipt requirements on home permissions', () => {
  const f = fixture(); fs.rmSync(f.transfer, { recursive: true }); fs.chmodSync(f.home, 0o775); const before = snapshot(f.root);
  assert.equal(api.prepare(f.opts).configured, false); assert.deepEqual(snapshot(f.root), before);
});
test('present receipt through a symlinked state ancestor is refused read-only', () => {
  const f = fixture(); s.saveReceipt(f.home, uid); fs.renameSync(path.join(f.home, '.local'), path.join(f.home, 'actual')); fs.symlinkSync('actual', path.join(f.home, '.local'));
  assert.throws(() => api.prepare({ ...f.opts, readonly: true }), { code: 'AI_RECEIPT_UNSAFE' });
});
test('unignored or tracked env refuses before a privileged CA install is attempted', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.repo, '.gitignore'), ''); const before = fs.readFileSync(f.env);
  assert.throws(() => api.prepare({ ...f.opts, loadCa: absent, installCa: () => assert.fail('sudo before git safety') }), { code: 'AI_ENV_TRACKED' });
  assert.deepEqual(fs.readFileSync(f.env), before);
});
test('transfer cannot turn non-ASCII bytes into allowed ASCII through decoding', () => {
  const f = fixture(), file = path.join(f.transfer, 'ai.env'), data = fs.readFileSync(file); data[data.indexOf('s'.charCodeAt(0))] |= 128; fs.writeFileSync(file, data);
  assert.throws(() => s.readTransfer(f.transfer, uid), { code: 'AI_TRANSFER_INVALID' });
});
test('diagnose uses the authoritative configured endpoint even with disabled model and missing installed CA', () => {
  const f = fixture(s.KEYS.map(k => k + '=' + (k === 'SKAO_AI_MODEL' ? '' : values[k])).join('\n')); const before = snapshot(f.root);
  const result = api.prepare({ ...f.opts, readonly: true, diagnose: true, loadCa: () => assert.fail('CA should not block TCP diagnosis') });
  assert.equal(result.configured, false); assert.equal(result.config.url.hostname, '192.168.20.20'); assert.deepEqual(snapshot(f.root), before);
});
