const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const runtime = require('../services/localAiRuntime');
const keys = ['SKAO_AI_MODEL', 'SKAO_AI_URL', 'SKAO_AI_LAN', 'SKAO_AI_TOKEN', 'SKAO_AI_CA_FILE'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of keys) delete process.env[key]; process.env.SKAO_AI_MODEL = 'synthetic-local'; });
afterEach(() => { jest.restoreAllMocks(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
test.each(['https://192.168.1.50:8443', 'https://10.1.1.2', 'https://172.16.1.2'])('explicit private TLS endpoint is accepted: %s', url => {
  process.env.SKAO_AI_URL = url; process.env.SKAO_AI_LAN = '1'; process.env.SKAO_AI_TOKEN = 'x'.repeat(48);
  expect(runtime.configuration()).toMatchObject({ url: new URL(url), token: 'x'.repeat(48) });
});
test.each(['http://192.168.1.50:11434', 'https://8.8.8.8', 'https://169.254.169.254', 'https://172.32.1.2',
  'https://ai.example.test', 'https://192.168.1.50/other', 'https://192.168.1.50/?token=x', 'https://user:pass@192.168.1.50', 'https://[fd00::1]'])('unsafe LAN address rejected before network access: %s', url => {
  process.env.SKAO_AI_URL = url; process.env.SKAO_AI_LAN = '1'; process.env.SKAO_AI_TOKEN = 'x'.repeat(48);
  expect(() => runtime.configuration()).toThrow(expect.objectContaining({ code: 'AI_LOCAL_ONLY_REQUIRED' }));
});
test('LAN requires explicit opt-in and a dedicated token; credentials never go to loopback', () => {
  process.env.SKAO_AI_URL = 'https://192.168.1.50';
  expect(() => runtime.configuration()).toThrow();
  process.env.SKAO_AI_LAN = '1'; expect(() => runtime.configuration()).toThrow();
  process.env.SKAO_AI_TOKEN = 'secret\nHeader: leak'; expect(() => runtime.configuration()).toThrow();
  process.env.SKAO_AI_URL = 'http://127.0.0.1:11434';
  expect(runtime.configuration().token).toBeUndefined();
});
test('configured CA must be an absolute bounded regular file and never a final symlink', () => {
  process.env.SKAO_AI_URL = 'https://192.168.1.50'; process.env.SKAO_AI_LAN = '1'; process.env.SKAO_AI_TOKEN = 'x'.repeat(48);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skao-ai-ca-'));
  try {
    const ca = path.join(directory, 'ca.pem'); fs.writeFileSync(ca, 'synthetic certificate'); fs.symlinkSync(ca, path.join(directory, 'link'));
    for (const value of ['relative.pem', directory, path.join(directory, 'link')]) {
      process.env.SKAO_AI_CA_FILE = value; expect(() => runtime.configuration()).toThrow(expect.objectContaining({ code: 'AI_CONFIGURATION_INVALID' }));
    }
    process.env.SKAO_AI_CA_FILE = ca; expect(runtime.configuration().ca.toString()).toBe('synthetic certificate');
    fs.writeFileSync(ca, Buffer.alloc(65537)); expect(() => runtime.configuration()).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('real HTTPS verifies CA and address, sends only dedicated credentials, and never follows redirects', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skao-ai-tls-'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=synthetic-local-runtime', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  let redirect = false, requests = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (redirect) { res.statusCode = 302; res.setHeader('Location', 'https://external.invalid/steal'); }
    res.end('{"cloud":{"disabled":true}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { url: new URL('https://127.0.0.1:' + server.address().port), ca: fs.readFileSync(cert), token: 'synthetic-dedicated-token' };
  try {
    expect(await runtime.jsonRequest(config, 'GET', '/api/status', undefined, AbortSignal.timeout(3000))).toEqual({ cloud: { disabled: true } });
    expect(requests[0].headers.authorization).toBe('Bearer synthetic-dedicated-token'); expect(requests[0].headers.cookie).toBeUndefined();
    await expect(runtime.jsonRequest({ ...config, ca: undefined }, 'GET', '/api/status', undefined, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    await expect(runtime.jsonRequest({ ...config, ca: Buffer.from('invalid synthetic CA') }, 'GET', '/api/status', undefined, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    redirect = true;
    await expect(runtime.jsonRequest(config, 'GET', '/api/status', undefined, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(requests.map(value => value.url)).toEqual(['/api/status', '/api/status']);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('runtime cannot select management paths or send an oversized context', async () => {
  const config = { url: new URL('http://127.0.0.1:1') };
  await expect(runtime.jsonRequest(config, 'POST', '/api/pull', {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AI_LOCAL_ONLY_REQUIRED' });
  await expect(runtime.jsonRequest(config, 'POST', '/api/generate', { prompt: 'x'.repeat(65536) }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AI_CONTEXT_TOO_LARGE' });
});
