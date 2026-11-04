const http = require('node:http');
const https = require('node:https');
const { issue } = require('./localAiRuntime');

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const unavailable = () => issue('AI_IMAGES_UNAVAILABLE', 'Activity illustrations are unavailable. You can keep the written activity and try again later.');
function allowed(method, path, binary) {
  if (binary) return method === 'GET' && new RegExp('^/api/activity-images/jobs/' + uuid + '/frames/[1-6]$').test(path);
  return (method === 'GET' && path === '/api/activity-images/status') ||
    (method === 'POST' && path === '/api/activity-images/jobs') ||
    (['GET', 'DELETE'].includes(method) && new RegExp('^/api/activity-images/jobs/' + uuid + '$').test(path));
}

// A separate, fixed protocol; arbitrary ComfyUI routes, filenames, URLs and
// redirects never cross the Pi/laptop boundary. Native HTTP ignores env proxies.
function request(config, method, path, value, signal, binary = false) {
  if (!allowed(method, path, binary)) return Promise.reject(unavailable());
  const payload = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  if (payload && payload.length > 16384) return Promise.reject(issue('AI_IMAGES_INVALID', 'Use a shorter activity name and up to six brief steps.'));
  const limit = binary ? 8 * 1024 * 1024 : 262144;
  return new Promise((resolve, reject) => {
    try {
      const req = (config.url.protocol === 'https:' ? https : http).request({
        protocol: config.url.protocol, hostname: config.url.hostname.replace(/^\[|\]$/g, ''),
        port: config.url.port || (config.url.protocol === 'https:' ? 443 : 80), path, method, agent: false,
        ...(config.ca ? { ca: config.ca } : {}), rejectUnauthorized: true, maxHeaderSize: 16384, signal,
        headers: { Accept: binary ? 'image/png' : 'application/json',
          ...(config.token ? { Authorization: 'Bearer ' + config.token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
      }, res => {
        const status = res.statusCode;
        if (![200, 202].includes(status) || !(binary ? /^image\/png(?:;|$)/i : /^application\/json(?:;|$)/i).test(res.headers['content-type'] || '')) {
          res.destroy();
          if (status === 429) reject(Object.assign(issue('AI_BUSY', 'Another AI request is running. Try again shortly.'), { status: 429, retryAfter: 5 }));
          else reject(unavailable());
          return;
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(unavailable()); return; }
        if (res.headers['content-length'] && (!/^\d+$/.test(res.headers['content-length']) || Number(res.headers['content-length']) > limit)) {
          res.destroy(); reject(unavailable()); return;
        }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > limit) { res.destroy(); reject(unavailable()); }
          else chunks.push(chunk);
        });
        res.once('end', () => {
          try {
            const body = Buffer.concat(chunks);
            resolve(binary ? body : JSON.parse(body.toString('utf8')));
          } catch { reject(unavailable()); }
        });
        res.once('error', () => reject(signal?.aborted ? signal.reason : unavailable()));
      });
      req.once('error', () => reject(signal?.aborted ? signal.reason : unavailable()));
      req.end(payload);
    } catch { reject(unavailable()); }
  });
}
module.exports = { request };
