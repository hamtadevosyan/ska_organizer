const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const issue = (code, message) => Object.assign(new Error(message), { status: 424, code });
const unavailable = () => issue('AI_UNAVAILABLE', 'The local AI is unavailable. Organizer remains available; try again later.');
const localOnly = () => issue('AI_LOCAL_ONLY_REQUIRED', 'Use a verified local model through loopback or an explicitly enabled private HTTPS AI server.');
let active = false;
function configuration() {
  const model = (process.env.SKAO_AI_MODEL || '').trim();
  if (!model) return null;
  if (model.length > 128 || !/^[a-z0-9][a-z0-9._/:-]*$/i.test(model) || /cloud|remote|:\/\/|:.*:/i.test(model)) throw localOnly();
  if (!['', '0', '1'].includes(process.env.SKAO_AI_LAN || '')) throw issue('AI_CONFIGURATION_INVALID', 'The private LAN AI setting must be 0 or 1.');
  const address = process.env.SKAO_AI_URL || 'http://127.0.0.1:11434';
  let url;
  try { url = new URL(address); } catch { throw localOnly(); }
  // Literal addresses only: configuration cannot introduce DNS rebinding,
  // redirects, proxies, cloud hosts or request-selected destinations.
  const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(address);
  const parts = url.hostname.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
  const lan = process.env.SKAO_AI_LAN === '1' && privateIp && /^https:\/\/[0-9.]+(?::[0-9]+)?\/?$/.test(address);
  if ((!loopback && !lan) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535))) throw localOnly();
  const token = process.env.SKAO_AI_TOKEN || '';
  if (lan && !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw issue('AI_CONFIGURATION_INVALID', 'A private LAN AI connection requires a dedicated access token.');
  let ca;
  if (lan && process.env.SKAO_AI_CA_FILE) {
    try {
      const filename = process.env.SKAO_AI_CA_FILE;
      if (!path.isAbsolute(filename)) throw new Error();
      const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new Error();
        ca = fs.readFileSync(descriptor);
      } finally { fs.closeSync(descriptor); }
    } catch { throw issue('AI_CONFIGURATION_INVALID', 'The private AI certificate authority file is unavailable or invalid.'); }
  }
  const rawTimeout = process.env.SKAO_AI_TIMEOUT_MS || '120000';
  if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 1000 || Number(rawTimeout) > 300000) {
    throw issue('AI_CONFIGURATION_INVALID', 'The local AI timeout must be between 1,000 and 300,000 milliseconds.');
  }
  return { model, url, timeout: Number(rawTimeout), ...(lan ? { token, ca } : {}) };
}

function jsonRequest(config, method, path, value, signal) {
  if (!['GET /api/status', 'GET /api/tags', 'POST /api/show', 'POST /api/generate'].includes(method + ' ' + path)) return Promise.reject(localOnly());
  const payload = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  if (payload && payload.length > 65536) return Promise.reject(issue('AI_CONTEXT_TOO_LARGE', 'The selected AI context is too large.'));
  return new Promise((resolve, reject) => {
    // Native HTTP does not consult HTTP_PROXY/NODE_USE_ENV_PROXY or follow redirects.
    try {
    const request = (config.url.protocol === 'https:' ? https : http).request({ protocol: config.url.protocol, hostname: config.url.hostname.replace(/^\[|\]$/g, ''),
      port: config.url.port || (config.url.protocol === 'https:' ? 443 : 80), path, method, agent: false,
      ...(config.ca ? { ca: config.ca } : {}), rejectUnauthorized: true,
      maxHeaderSize: 16384, signal, headers: { Accept: 'application/json', ...(config.token ? { Authorization: 'Bearer ' + config.token } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')) {
        response.destroy(); reject(Object.assign(unavailable(), { runtimeStatus: response.statusCode })); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 262144) { response.destroy(); reject(issue('AI_INVALID_RESPONSE', 'The local AI returned too much data. Try fewer activity ideas.')); }
        else chunks.push(chunk);
      });
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(issue('AI_INVALID_RESPONSE', 'The local AI returned an unreadable response. Try again.')); }
      });
      response.once('error', () => reject(signal.aborted ? signal.reason : unavailable()));
    });
    request.once('error', () => reject(signal.aborted ? signal.reason : unavailable()));
    request.end(payload);
    } catch { reject(unavailable()); }
  });
}

function remoteMetadata(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 15) return false;
  return Object.entries(value).some(([key, item]) =>
    (/remote|cloud/i.test(key) && item !== undefined && item !== null && item !== '' && item !== false && item !== 0) ||
    (key === 'capabilities' && Array.isArray(item) && item.some(capability => /remote|cloud/i.test(String(capability)))) || remoteMetadata(item, depth + 1));
}

async function verifyRuntime(config, signal) {
  let status;
  try { status = await jsonRequest(config, 'GET', '/api/status', undefined, signal); }
  catch (error) { if (error.runtimeStatus === 404) throw localOnly(); throw error; }
  if (status?.cloud?.disabled !== true) throw localOnly();
  const tags = await jsonRequest(config, 'GET', '/api/tags', undefined, signal);
  const names = new Set([config.model, config.model.includes(':') ? config.model : config.model + ':latest']);
  const model = Array.isArray(tags?.models) ? tags.models.find(item => names.has(item?.name) || names.has(item?.model)) : null;
  if (!model || !Number.isSafeInteger(model.size) || model.size <= 0 || !/^[a-f0-9]{64}$/i.test(model.digest || '') || remoteMetadata(model)) throw localOnly();
  const name = names.has(model.name) ? model.name : model.model;
  const details = await jsonRequest(config, 'POST', '/api/show', { model: name, verbose: false }, signal);
  if (!details?.model_info || typeof details.model_info !== 'object' || !Object.keys(details.model_info).length || remoteMetadata(details)) throw localOnly();
  return name;
}

async function limited(config, options, operation, timeout = config.timeout) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(issue('AI_TIMEOUT', 'The local AI took too long. Try fewer ideas or a shorter activity.')), timeout);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try { return await operation(signal); }
  finally { clearTimeout(timer); }
}

async function generate(operation) {
  if (active) throw Object.assign(issue('AI_BUSY', 'Another AI request is running. Try again shortly.'), { status: 429, retryAfter: 5 });
  active = true;
  try { return await operation(); } finally { active = false; }
}
module.exports = { configuration, jsonRequest, remoteMetadata, verifyRuntime, limited, generate, issue };
