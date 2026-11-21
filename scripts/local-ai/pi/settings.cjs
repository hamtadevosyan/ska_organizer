'use strict';
// Only AI connection values leave this module. No application packages are loaded.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');
const { randomUUID, X509Certificate } = require('node:crypto');
const KEYS = ['SKAO_AI_MODEL', 'SKAO_AI_LAN', 'SKAO_AI_URL', 'SKAO_AI_TOKEN', 'SKAO_AI_CA_FILE', 'SKAO_AI_TIMEOUT_MS'];
const MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const DIGEST = '0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0';
const CA = '/etc/skao/ai/ca.pem';
function insist(condition, code = 'AI_CONFIGURATION_INVALID') { if (!condition) throw Object.assign(new Error(), { code }); }
function ownedFile(filename, limit, uid, mode) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    insist(stat.isFile() && stat.uid === uid && stat.size <= limit && (mode === undefined || (stat.mode & 0o7777) === mode), 'AI_FILE_UNSAFE');
    const buffer = Buffer.alloc(limit + 1); let count = 0;
    while (count < buffer.length) { const read = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read; }
    const data = buffer.subarray(0, count); insist(data.length === stat.size && data.length <= limit, 'AI_FILE_CHANGED');
    return { data, stat };
  } finally { fs.closeSync(fd); }
}
function publicCertificate(data) {
  const text = data.toString('ascii');
  insist(data.length > 0 && data.length <= 65536 && Buffer.from(text, 'ascii').equals(data), 'AI_CA_INVALID');
  insist(/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(text), 'AI_CA_INVALID');
  const cert = new X509Certificate(data); insist(cert.ca, 'AI_CA_INVALID'); return data;
}
function privateIp(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every(p => /^(0|[1-9]\d{0,2})$/.test(p) && +p <= 255)) return false;
  const p = parts.map(Number); return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}
function select(values) { return Object.fromEntries(KEYS.filter(k => Object.hasOwn(values, k)).map(k => [k, values[k]])); }
function readEnvironment(repo, uid) {
  const filename = path.join(repo, 'server', '.env');
  let original;
  try { original = ownedFile(filename, 1048576, uid); }
  catch (error) { if (error.code !== 'ENOENT') throw error; original = null; }
  const text = original?.data.toString('utf8') || '';
  insist(!original || Buffer.from(text).equals(original.data), 'AI_ENV_ENCODING');
  const values = parseEnv(text), present = KEYS.some(k => Object.hasOwn(values, k));
  if (present && original) insist((original.stat.mode & 0o7777) === 0o600, 'AI_ENV_PERMISSIONS');
  return { filename, original, text, values: select(values), present };
}
function readTransfer(folder, uid) {
  const stat = fs.lstatSync(folder);
  insist(stat.isDirectory() && stat.uid === uid && (stat.mode & 0o7777) === 0o700, 'AI_TRANSFER_UNSAFE');
  const source = ownedFile(path.join(folder, 'ai.env'), 16384, uid, 0o600);
  const values = {};
  insist(Buffer.from(source.data.toString('ascii'), 'ascii').equals(source.data), 'AI_TRANSFER_INVALID');
  for (const line of source.data.toString('ascii').split(/\r?\n/)) {
    if (!line) continue;
    const pair = /^([A-Z_]+)=([^\r\n]*)$/.exec(line);
    insist(pair && KEYS.includes(pair[1]) && !Object.hasOwn(values, pair[1]), 'AI_TRANSFER_INVALID');
    values[pair[1]] = pair[2];
  }
  insist(Object.keys(values).length === KEYS.length && values.SKAO_AI_MODEL === MODEL && values.SKAO_AI_LAN === '1' && values.SKAO_AI_CA_FILE === CA, 'AI_TRANSFER_INVALID');
  insist(/^[A-Za-z0-9_-]{43}$/.test(values.SKAO_AI_TOKEN) && values.SKAO_AI_TIMEOUT_MS === '120000', 'AI_TRANSFER_INVALID');
  const url = new URL(values.SKAO_AI_URL);
  insist(privateIp(url.hostname) && values.SKAO_AI_URL === 'https://' + url.hostname + ':8443', 'AI_TRANSFER_INVALID');
  const certificate = ownedFile(path.join(folder, 'ca.pem'), 65536, uid, 0o600);
  publicCertificate(certificate.data);
  return { values, ca: certificate.data, source: path.join(folder, 'ca.pem') };
}
function configuration(values, certificate) {
  const model = (values.SKAO_AI_MODEL || '').trim();
  if (!model) return null;
  insist(model.length <= 128 && /^[a-z0-9][a-z0-9._/:-]*$/i.test(model) && !/cloud|remote|:\/\/|:.*:/i.test(model));
  insist(['', '0', '1'].includes(values.SKAO_AI_LAN || ''));
  const address = values.SKAO_AI_URL || 'http://127.0.0.1:11434', url = new URL(address);
  const local = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(address);
  const lan = values.SKAO_AI_LAN === '1' && privateIp(url.hostname) && /^https:\/\/[0-9.]+(?::[0-9]+)?\/?$/.test(address);
  insist((local || lan) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && (!url.port || (+url.port > 0 && +url.port <= 65535)));
  if (lan) insist(/^[A-Za-z0-9_-]{32,256}$/.test(values.SKAO_AI_TOKEN || '') && values.SKAO_AI_CA_FILE === CA);
  const raw = values.SKAO_AI_TIMEOUT_MS || '120000'; insist(/^\d+$/.test(raw) && +raw >= 1000 && +raw <= 300000);
  return { model, url, lan, timeout: +raw, token: lan ? values.SKAO_AI_TOKEN : undefined, ca: lan ? certificate : undefined };
}
function installedCertificate(filename = CA) {
  let current = path.parse(filename).root;
  for (const segment of path.dirname(filename).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const st = fs.lstatSync(current);
    insist(st.isDirectory() && st.uid === 0 && st.gid === 0 && !(st.mode & 0o022), 'AI_CA_PATH_UNSAFE');
  }
  const file = ownedFile(filename, 65536, 0, 0o644); insist(file.stat.gid === 0, 'AI_CA_PATH_UNSAFE'); return publicCertificate(file.data);
}
function writePrivate(filename, data) {
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function environmentPlan(env, values) {
  const before = parseEnv(env.text), kept = []; let quote = null;
  // Refuse ambiguous multiline records rather than removing a line from someone else's value.
  for (const [key, value] of Object.entries(before)) if (KEYS.includes(key.replace(/^\uFEFF/, ''))) insist(!/[\r\n]/.test(value), 'AI_ENV_MULTILINE');
  for (const record of env.text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean)) {
    const line = record.replace(/[\r\n]+$/, '');
    const assignment = /^[\uFEFF \t]*(?:export[ \t]+)?([^= \t]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    const ai = assignment && KEYS.includes(assignment[1]);
    if (quote) { insist(!ai, 'AI_ENV_MULTILINE'); if (line.includes(quote)) quote = null; kept.push(record); continue; }
    if (assignment && !/^[\uFEFF \t]*#/.test(line) && ['"', "'", '`'].includes(assignment[2][0]) && assignment[2].indexOf(assignment[2][0], 1) < 0) { insist(!ai, 'AI_ENV_MULTILINE'); quote = assignment[2][0]; }
    if (!ai) kept.push(record);
  }
  insist(!quote, 'AI_ENV_MULTILINE');
  let updated = kept.join(''); const ending = env.text.includes('\r\n') ? '\r\n' : '\n';
  insist(KEYS.every(k => !Object.hasOwn(parseEnv(updated), k)), 'AI_ENV_AMBIGUOUS');
  if (updated && !/[\r\n]$/.test(updated)) updated += ending;
  updated += KEYS.map(k => k + '=' + values[k]).join(ending) + ending;
  if (env.text.startsWith('\uFEFF') && !updated.startsWith('\uFEFF')) updated = '\uFEFF' + ending + updated;
  const after = parseEnv(updated), unrelated = v => JSON.stringify(Object.keys(v).filter(k => !KEYS.includes(k.replace(/^\uFEFF/, ''))).sort().map(k => [k, v[k]]));
  insist(unrelated(before) === unrelated(after) && KEYS.every(k => after[k] === values[k]), 'AI_ENV_AMBIGUOUS');
  return Buffer.from(updated);
}
function gitSafe(repo) {
  const run = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const ignored = run(['check-ignore', '-q', '--', 'server/.env']), tracked = run(['ls-files', '-z', '--', 'server/.env']);
  insist(ignored.status === 0 && tracked.status === 0 && tracked.stdout === '', 'AI_ENV_TRACKED');
}
function importPreflight(repo, env, values, uid) {
  gitSafe(repo); const bytes = environmentPlan(env, values);
  const parent = fs.lstatSync(path.dirname(env.filename)); insist(parent.isDirectory() && parent.uid === uid && !(parent.mode & 0o022), 'AI_ENV_PATH_UNSAFE');
  let current; try { current = ownedFile(env.filename, 1048576, uid); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  insist(env.original ? current && current.data.equals(env.original.data) && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].every(k => current.stat[k] === env.original.stat[k]) : !current, 'AI_ENV_CHANGED');
  return bytes;
}
function importSettings(repo, env, values, uid, transfer, beforeCommit) {
  if (KEYS.every(k => env.values[k] === values[k])) return false;
  const bytes = importPreflight(repo, env, values, uid);
  const backup = fs.mkdtempSync(path.join(transfer, 'ai-import-backup-')); fs.chmodSync(backup, 0o700);
  if (env.original) writePrivate(path.join(backup, 'server.env'), env.original.data);
  const temporary = path.join(path.dirname(env.filename), '.env.skao-ai-' + randomUUID());
  try {
    writePrivate(temporary, bytes); if (beforeCommit) beforeCommit();
    let current; try { current = ownedFile(env.filename, 1048576, uid); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    insist(env.original ? current && current.data.equals(env.original.data) && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].every(k => current.stat[k] === env.original.stat[k]) : !current, 'AI_ENV_CHANGED');
    if (env.original) fs.renameSync(temporary, env.filename);
    else { fs.linkSync(temporary, env.filename); fs.unlinkSync(temporary); }
  } finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  return true;
}
function stateFile(home) { return path.join(home, '.local', 'state', 'skao', 'local-ai', 'pi-setup.json'); }
function hasReceipt(home, uid) {
  try {
    // An absent receipt must not make an otherwise unrelated home path an AI prerequisite.
    fs.lstatSync(stateFile(home));
    let current = home;
    for (const part of ['.', '.local', 'state', 'skao', 'local-ai']) {
      current = path.join(current, part); const st = fs.lstatSync(current);
      insist(st.isDirectory() && st.uid === uid && !(st.mode & 0o022), 'AI_RECEIPT_UNSAFE');
    }
    const file = ownedFile(stateFile(home), 4096, uid, 0o600); const data = JSON.parse(file.data); insist(data.version === 1 && data.adopted === true, 'AI_RECEIPT_INVALID'); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function saveReceipt(home, uid) {
  if (hasReceipt(home, uid)) return;
  let current = home;
  for (const part of ['.local', 'state', 'skao', 'local-ai']) {
    current = path.join(current, part); try { fs.mkdirSync(current, 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(current); insist(st.isDirectory() && st.uid === uid && !(st.mode & 0o022), 'AI_RECEIPT_UNSAFE');
  }
  const filename = stateFile(home), temp = filename + '.' + randomUUID();
  try { writePrivate(temp, Buffer.from('{"version":1,"adopted":true}\n')); fs.linkSync(temp, filename); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
module.exports = { KEYS, MODEL, DIGEST, CA, insist, ownedFile, publicCertificate, privateIp, readEnvironment, readTransfer, configuration, installedCertificate, environmentPlan, importPreflight, importSettings, hasReceipt, saveReceipt };
