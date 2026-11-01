#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), https = require('node:https'), net = require('node:net');
const { spawnSync } = require('node:child_process');
const s = require('./settings.cjs');
const safeCode = e => typeof e?.code === 'string' && /^(?:AI_[A-Z0-9_]+|E[A-Z0-9_]+|ERR_TLS_[A-Z0-9_]+|CERT_[A-Z0-9_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/.test(e.code) ? e.code : 'AI_CHECK_FAILED';
function exists(filename) { try { fs.lstatSync(filename); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function installCa(source) {
  const result = spawnSync('sudo', ['--', '/usr/bin/python3', path.join(__dirname, 'install-ca.py'), source], { stdio: 'inherit' });
  s.insist(result.status === 0, 'AI_CA_INSTALL_FAILED');
}
function prepare(options = {}) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '../../..')), uid = options.uid ?? process.getuid();
  const home = options.home || os.homedir(), transfer = options.transfer || path.join(home, 'skao-ai-transfer');
  const readonly = !!options.readonly, env = s.readEnvironment(repo, uid), adopted = s.hasReceipt(home, uid);
  let incoming, values = env.values, useTransfer = false;
  if (options.import || (!env.present && !adopted)) {
    if (exists(transfer)) { incoming = s.readTransfer(transfer, uid); values = incoming.values; useTransfer = true; }
    else if (options.import) s.insist(false, 'AI_TRANSFER_MISSING');
  }
  if (!env.present && !useTransfer) return { configured: false, repo, transfer, skipped: true };
  // Plan and validate the import before sudo can install the public certificate.
  if (useTransfer) s.importPreflight(repo, env, values, uid);
  let config;
  if (options.diagnose) {
    // Network diagnosis remains available when a model was deliberately disabled.
    const address = values.SKAO_AI_URL || 'http://127.0.0.1:11434', url = new URL(address);
    const local = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(address);
    const lan = s.privateIp(url.hostname) && /^https:\/\/[0-9.]+(?::[0-9]+)?\/?$/.test(address);
    s.insist((local || lan) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'AI_CONFIGURATION_INVALID');
    return { configured: !!(values.SKAO_AI_MODEL || '').trim(), config: { url, lan }, repo, transfer, values };
  }
  config = s.configuration(values); let certificate;
  if (config?.lan) {
    if (readonly && useTransfer) certificate = incoming.ca;
    else {
      try { certificate = (options.loadCa || s.installedCertificate)(); }
      catch (error) {
        if (readonly) throw error;
        if (!incoming && exists(transfer)) incoming = s.readTransfer(transfer, uid);
        s.insist(incoming && s.KEYS.every(k => values[k] === incoming.values[k]), 'AI_CA_TRANSFER_MISMATCH');
        (options.installCa || installCa)(incoming.source);
        certificate = (options.loadCa || s.installedCertificate)();
      }
      if (useTransfer) s.insist(certificate.equals(incoming.ca), 'AI_CA_CONFLICT');
    }
    config = s.configuration(values, certificate);
  }
  let changed = false;
  if (!readonly) {
    if (useTransfer) changed = s.importSettings(repo, env, values, uid, transfer);
    s.saveReceipt(home, uid);
  }
  return { configured: !!config, config, repo, transfer, changed, adopted: env.present, values };
}
function request(config, method, route, value, authenticated = true, expected = 200, timeout = 10000) {
  const payload = value === undefined ? null : Buffer.from(JSON.stringify(value));
  s.insist(!payload || payload.length <= 65536, 'AI_REQUEST_TOO_LARGE');
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = (e, data) => { if (complete) return; complete = true; clearTimeout(timer); if (e) reject(e); else resolve(data); };
    const transport = config.url.protocol === 'https:' ? https : http;
    const timer = setTimeout(() => { req.destroy(Object.assign(new Error(), { code: 'AI_TIMEOUT' })); }, timeout);
    let req;
    try {
      // Native HTTP does not use shell/env proxies and never follows redirects.
      req = transport.request({ protocol: config.url.protocol, hostname: config.url.hostname.replace(/^\[|\]$/g, ''),
        port: config.url.port || (transport === https ? 443 : 80), method, path: route, agent: false,
        ca: config.ca, rejectUnauthorized: true, maxHeaderSize: 16384,
        headers: { Accept: 'application/json', ...(config.token && authenticated ? { Authorization: 'Bearer ' + config.token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
        if (response.statusCode !== expected) { response.destroy(); finish(Object.assign(new Error(), { code: 'AI_HTTP_' + response.statusCode })); return; }
        if (expected !== 200) { response.destroy(); finish(null, null); return; }
        if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')) { response.destroy(); finish(Object.assign(new Error(), { code: 'AI_RESPONSE_INVALID' })); return; }
        const chunks = []; let count = 0;
        response.on('data', chunk => { count += chunk.length; if (count > 262144) { response.destroy(); finish(Object.assign(new Error(), { code: 'AI_RESPONSE_TOO_LARGE' })); } else chunks.push(chunk); });
        response.once('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks))); } catch { finish(Object.assign(new Error(), { code: 'AI_RESPONSE_INVALID' })); } });
        response.once('error', e => finish(e));
      });
      req.once('error', e => finish(e)); req.end(payload);
    } catch (e) { finish(e); }
  });
}
function remoteMetadata(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 15) return false;
  return Object.entries(value).some(([key, item]) => (/remote|cloud/i.test(key) && ![undefined, null, '', false, 0].includes(item)) || (key === 'capabilities' && Array.isArray(item) && item.some(x => /remote|cloud/i.test(String(x)))) || remoteMetadata(item, depth + 1));
}
function rawDenied(host, port = 11434) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 3000);
    const done = e => { clearTimeout(timer); socket.destroy(); if (e && ['ECONNREFUSED', 'ETIMEDOUT'].includes(e.code)) resolve(); else reject(e || Object.assign(new Error(), { code: 'AI_RAW_PORT_REACHABLE' })); };
    socket.once('connect', () => done()); socket.once('error', e => done(e));
  });
}
async function qualify(config, { generate = false, call = request, checkRaw = rawDenied, print = console.log } = {}) {
  let stage = 'authenticated AI metadata';
  try {
    const status = await call(config, 'GET', '/api/status'); s.insist(status?.cloud?.disabled === true, 'AI_CLOUD_ENABLED');
    const tags = await call(config, 'GET', '/api/tags');
    const names = new Set([config.model, config.model.includes(':') ? config.model : config.model + ':latest']);
    const models = Array.isArray(tags?.models) ? tags.models.filter(m => names.has(m?.name) || names.has(m?.model)) : [];
    s.insist(models.length === 1 && Number.isSafeInteger(models[0].size) && models[0].size > 0 && /^[a-f0-9]{64}$/i.test(models[0].digest || '') && !remoteMetadata(models[0]), 'AI_MODEL_INVALID');
    if (config.model === s.MODEL) s.insist(models[0].digest === s.DIGEST, 'AI_MODEL_DIGEST_MISMATCH');
    const show = await call(config, 'POST', '/api/show', { model: config.model, verbose: false });
    s.insist(show?.model_info && typeof show.model_info === 'object' && Object.keys(show.model_info).length && !remoteMetadata(show), 'AI_MODEL_INVALID');
    print('PASS: authenticated connection and verified local model');
    if (config.lan) {
      stage = 'unauthenticated HTTPS denial'; await call(config, 'GET', '/api/status', undefined, false, 403); print('PASS: unauthenticated HTTPS denied');
      stage = 'raw AI port isolation'; await checkRaw(config.url.hostname); print('PASS: raw AI port unreachable');
    }
    if (generate) {
      stage = 'explicit synthetic generation';
      try {
        const result = await call(config, 'POST', '/api/generate', { model: config.model, prompt: 'Reply exactly: Local AI is ready.', stream: false, think: false, keep_alive: 0, options: { temperature: 0, num_ctx: 4096, num_predict: 32, num_thread: 2 } }, true, 200, config.timeout);
        s.insist(result?.response?.trim() === 'Local AI is ready.' && result.done === true && result.done_reason === 'stop', 'AI_SMOKE_FAILED');
        print('PASS: explicit synthetic generation');
      } finally {
        try { await call(config, 'POST', '/api/generate', { model: config.model, stream: false, keep_alive: 0 }, true, 200, 15000); }
        catch { print('WARN: immediate model unloading could not be confirmed'); }
      }
    }
  } catch (error) { throw Object.assign(new Error('FAIL: ' + stage + ' [' + safeCode(error) + ']'), { safe: true }); }
}
async function diagnose(result, print = console.log) {
  const config = result.config;
  if (!config) { print('Configured AI enabled: false'); return; }
  print('Configured AI enabled: ' + result.configured);
  if (exists(result.transfer)) {
    try { const incoming = s.readTransfer(result.transfer, process.getuid()); print('Endpoint matches transfer: ' + (incoming.values.SKAO_AI_URL === config.url.href.replace(/\/$/, ''))); }
    catch { print('Transfer comparison: unavailable'); }
  }
  const host = config.url.hostname, port = +(config.url.port || (config.lan ? 443 : 11434));
  const route = spawnSync('ip', ['-j', 'route', 'get', host], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  let row;
  try { row = route.status === 0 ? JSON.parse(route.stdout)[0] : undefined; } catch {}
  print('Route query succeeded: ' + !!row);
  if (row) {
    print('Source address selected: ' + !!row.prefsrc); print('Route uses gateway: ' + !!row.gateway);
    const link = spawnSync('ip', ['-j', 'link', 'show', 'dev', String(row.dev || '')], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    let state = 'UNKNOWN'; try { const v = JSON.parse(link.stdout)[0]?.operstate; if (['UP', 'DOWN', 'UNKNOWN', 'DORMANT', 'LOWERLAYERDOWN', 'NOTPRESENT'].includes(v)) state = v; } catch {}
    print('Interface state: ' + state);
    const neighbor = spawnSync('ip', ['-j', 'neigh', 'show', 'to', row.gateway || host, 'dev', String(row.dev || '')], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    let states = []; try { states = JSON.parse(neighbor.stdout)[0]?.state || []; } catch {}
    print('Next-hop neighbour: ' + (states.filter(x => ['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'INCOMPLETE', 'FAILED', 'PERMANENT', 'NOARP'].includes(x)).join(', ') || 'unreported'));
  }
  await new Promise(resolve => {
    const socket = net.createConnection({ host, port }), timer = setTimeout(() => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 5000);
    const done = label => { clearTimeout(timer); socket.destroy(); print('Node TCP gateway: ' + label); resolve(); };
    socket.once('connect', () => done('CONNECTED')); socket.once('error', e => done(safeCode(e)));
  });
  const python = spawnSync('python3', ['-c', [
    'import errno, socket, sys',
    'try:',
    '    connection = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=5)',
    '    connection.close(); print("CONNECTED")',
    'except OSError as error:',
    '    print(errno.errorcode.get(error.errno, "UNAVAILABLE"))',
  ].join('\n'), host, String(port)], { encoding: 'utf8', timeout: 7000, maxBuffer: 1024 });
  const label = python.status === 0 && /^(CONNECTED|E[A-Z0-9_]+|UNAVAILABLE)\s*$/.test(python.stdout) ? python.stdout.trim() : 'UNAVAILABLE';
  print('Python TCP gateway: ' + label);
}
function argumentsFor(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--repo', '--transfer-dir'].includes(arg)) { s.insist(i + 1 < argv.length && !argv[i + 1].startsWith('--'), 'AI_ARGUMENT_INVALID'); result[arg === '--repo' ? 'repo' : 'transfer'] = path.resolve(argv[++i]); }
    else if (['--check', '--diagnose', '--prepare', '--if-configured', '--import', '--test-generation'].includes(arg)) result[arg.slice(2)] = true;
    else s.insist(false, 'AI_ARGUMENT_INVALID');
  }
  s.insist([result.check, result.diagnose, result.prepare].filter(Boolean).length <= 1, 'AI_ARGUMENT_INVALID');
  s.insist(!result['test-generation'] || (!result.check && !result.diagnose && !result.prepare), 'AI_ARGUMENT_INVALID');
  s.insist(!result.import || (!result.check && !result.diagnose), 'AI_ARGUMENT_INVALID');
  result.readonly = !!(result.check || result.diagnose); return result;
}
async function main(argv = process.argv.slice(2)) {
  let stage = 'arguments and normal-user checks';
  try {
    const opts = argumentsFor(argv); s.insist(process.getuid() !== 0 && typeof require('node:util').parseEnv === 'function', 'AI_NORMAL_USER_REQUIRED');
    stage = 'private settings and certificate preparation'; const result = prepare(opts);
    if (opts.diagnose) { await diagnose(result); return; }
    if (!result.configured) {
      if (opts.prepare || opts['if-configured']) { console.log('AI preparation: disabled or not configured; application setup may continue'); return; }
      s.insist(false, 'AI_NOT_CONFIGURED');
    }
    console.log(result.changed ? 'PASS: six AI settings imported; unrelated settings preserved; private backup saved' : 'PASS: existing AI settings preserved');
    if (opts.prepare) { console.log('PASS: offline AI preparation; laptop availability was not required'); return; }
    stage = 'private connection qualification'; await qualify(result.config, { generate: !!opts['test-generation'] });
  } catch (error) { console.error(error.safe ? error.message : 'FAIL: ' + stage + ' [' + safeCode(error) + ']'); process.exitCode = 1; }
}
module.exports = { prepare, request, qualify, rawDenied, diagnose, argumentsFor, safeCode, main };
if (require.main === module) main();
