const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PNG } = require('pngjs');
const CRC = require('pngjs/lib/crc');
const transport = require('../services/activityMediaTransport');
const runtime = require('../services/localAiRuntime');
const png = require('../services/activityMediaPng');
const id = '5838db9a-ac43-4842-b0d1-a10626f93a79';
const route = '/api/activity-images/jobs/' + id;
const open = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
function image() {
  const value = new PNG({ width: 4, height: 3 }); value.data.fill(220);
  return PNG.sync.write(value);
}
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length);
  result.write(type, 4); data.copy(result, 8);
  result.writeInt32BE(CRC.crc32(result.subarray(4, data.length + 8)), data.length + 8); return result;
}
test('PNG import validates pixels and strips generated prompts and private metadata', () => {
  const original = image(), metadata = chunk('tEXt', Buffer.from('prompt\0Private synthetic prompt'));
  const input = Buffer.concat([original.subarray(0, 33), metadata, original.subarray(33)]);
  const result = png.normalize(input);
  expect(result).toMatchObject({ width: 4, height: 3, contentType: 'image/png', byteLength: result.content.length });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.content.includes(Buffer.from('Private'))).toBe(false);
  expect(PNG.sync.read(result.content).data).toEqual(PNG.sync.read(original).data);
});
test('PNG import refuses CRC damage, truncation, extra files, animation and oversized dimensions before decoding', () => {
  const valid = image(), corrupt = Buffer.from(valid); corrupt[corrupt.length - 1] ^= 1;
  const huge = Buffer.from(valid); huge.writeUInt32BE(1025, 16);
  const animated = Buffer.concat([valid.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), valid.subarray(33)]);
  const duplicateHeader = Buffer.concat([valid.subarray(0, 33), valid.subarray(8, 33), valid.subarray(33)]);
  const badMetadata = chunk('tEXt', Buffer.from('prompt\0private')); badMetadata[badMetadata.length - 1] ^= 1;
  const metadataCrc = Buffer.concat([valid.subarray(0, 33), badMetadata, valid.subarray(33)]);
  for (const input of [Buffer.from('not a PNG'), corrupt, valid.subarray(0, -1), Buffer.concat([valid, valid]), huge, animated, duplicateHeader, metadataCrc, Buffer.alloc(8388609)]) {
    expect(() => png.normalize(input)).toThrow(expect.objectContaining({ code: 'AI_IMAGES_INVALID' }));
  }
});
test('worker transport exposes only fixed routes, bounded metadata and binary frames', async () => {
  const seen = [], content = image();
  let mode = 'json';
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, method: req.method, headers: req.headers });
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://external.invalid/leak' }); res.end(); }
    else if (mode === 'busy') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"code":"AI_BUSY"}'); }
    else if (mode === 'large') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('x'.repeat(262145)); }
    else if (mode === 'png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(content); }
    else { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('{"version":1}'); }
  });
  await open(server);
  const config = { url: new URL('http://127.0.0.1:' + server.address().port), token: 'dedicated-test-token' };
  const signal = () => AbortSignal.timeout(3000);
  try {
    expect(await transport.request(config, 'POST', '/api/activity-images/jobs', { name: 'Paper shapes', steps: ['Arrange large shapes.'], requestId: id }, signal())).toEqual({ version: 1 });
    expect(seen[0]).toMatchObject({ path: '/api/activity-images/jobs', headers: { authorization: 'Bearer dedicated-test-token' } });
    expect(seen[0].headers.cookie).toBeUndefined();
    for (const [method, target] of [['GET', '/view?filename=secret'], ['POST', '/prompt'], ['GET', route + '?token=secret'], ['GET', route + '/frames/7'], ['GET', '/api/activity-images/jobs/../status']]) {
      await expect(transport.request(config, method, target, undefined, signal(), true)).rejects.toMatchObject({ code: 'AI_IMAGES_UNAVAILABLE' });
    }
    expect(seen).toHaveLength(1);
    await expect(transport.request(config, 'POST', '/api/activity-images/jobs', { name: 'x'.repeat(16384) }, signal())).rejects.toMatchObject({ code: 'AI_IMAGES_INVALID' });
    mode = 'png'; expect(await transport.request(config, 'GET', route + '/frames/1', undefined, signal(), true)).toEqual(content);
    mode = 'busy'; await expect(transport.request(config, 'GET', route, undefined, signal())).rejects.toMatchObject({ code: 'AI_BUSY', status: 429 });
    await expect(runtime.jsonRequest(config, 'POST', '/api/generate', { model: 'synthetic' }, signal())).rejects.toMatchObject({ code: 'AI_BUSY', status: 429 });
    mode = 'large'; await expect(transport.request(config, 'GET', route, undefined, signal())).rejects.toMatchObject({ code: 'AI_IMAGES_UNAVAILABLE' });
    mode = 'redirect'; await expect(transport.request(config, 'GET', route, undefined, signal())).rejects.toMatchObject({ code: 'AI_IMAGES_UNAVAILABLE' });
    expect(seen.every(value => value.path !== '/leak')).toBe(true);
  } finally { await close(server); }
});
test('worker HTTPS checks configured CA and IP while sending only the dedicated bearer', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'skao-images-tls-'));
  const key = path.join(folder, 'key.pem'), cert = path.join(folder, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=synthetic-image-worker', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    seen.push(req.headers); res.setHeader('Content-Type', 'application/json'); res.end('{"version":1}');
  });
  await open(server);
  const config = { url: new URL('https://127.0.0.1:' + server.address().port), ca: fs.readFileSync(cert), token: 'dedicated-worker-token' };
  try {
    expect(await transport.request(config, 'GET', '/api/activity-images/status', undefined, AbortSignal.timeout(3000))).toEqual({ version: 1 });
    await expect(transport.request({ ...config, ca: undefined }, 'GET', '/api/activity-images/status', undefined, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'AI_IMAGES_UNAVAILABLE' });
    expect(seen).toHaveLength(1); expect(seen[0].authorization).toBe('Bearer dedicated-worker-token'); expect(seen[0].cookie).toBeUndefined();
  } finally { await close(server); fs.rmSync(folder, { recursive: true, force: true }); }
});
