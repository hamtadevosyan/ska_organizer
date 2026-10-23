const { randomBytes, randomUUID, createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const vault = require('./payrollVault');
const v = require('./childDocumentValidation');
const { verifyPassword } = require('../auth/passwords');
const derive = promisify(scrypt);
const DAY = 86400000, STATION_LIFETIME = 90 * DAY, PAIR_LIFETIME = 10 * 60000, GRANT_LIFETIME = 45000;
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = purpose => createHmac('sha256', vault.check()).update('skao-clock-station:' + purpose + ':v1').digest();
const hmac = (purpose, value) => createHmac('sha256', secret(purpose)).update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const stationError = () => auth.problem('This clock station has expired or been revoked. Pair this device again.', 401, 'STATION_EXPIRED');
const grantError = () => auth.problem('This clock action is out of date. Enter your PIN again.', 409, 'CLOCK_GRANT_STALE');
const stationActor = station => ({ id: null, username: 'clock-station:' + station.id });
const configuredPin = row => !!row && typeof row.pinHash === 'string' && row.pinHash.startsWith('scrypt$');
const publicStation = row => ({ id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt });
const sessionData = (station, credential) => ({ station: { name: station.name, expiresAt: station.expiresAt }, csrfToken: csrf(credential) });
const csrf = credential => createHmac('sha256', credential).update('skao-clock-station-csrf-v1').digest('hex');
const assertCsrf = (credential, supplied) => { if (!/^[a-f0-9]{64}$/.test(supplied || '') || !safeEqual(supplied, csrf(credential))) throw auth.problem('Reload the clock station and try again.', 403, 'STATION_CSRF_INVALID'); };
async function currentStation(credential) {
  if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential)) throw stationError();
  const station = await db.getClockStationByCredentialHash(hash(credential));
  if (!station || station.revokedAt || new Date(station.expiresAt).getTime() <= Date.now()) throw stationError();
  vault.check(); return station;
}
async function administrator(token) { const actor = await auth.administrator(token); vault.check(); return actor; }
async function staffList() {
  const people = [];
  for (let page = 1;; page++) { const batch = await db.listStaff({ page, pageSize: 100 }); people.push(...batch); if (batch.length < 100) break; }
  return people;
}
// Reserve in a separate committed transaction. A later invalid PIN, expired
// grant or rolled-back clock mutation must never refund the attempt budget.
const limited = retryAfter => Object.assign(auth.problem('Too many clock attempts. Please try again later.', 429, 'STATION_RATE_LIMITED'), { retryAfter });
async function attemptBudget(kind, ip, stationId, increment = true) {
  const windowMs = kind === 'pair' ? 10 * 60000 : kind === 'pin-denial' ? DAY : 5 * 60000;
  const limits = kind === 'pair' ? [50, 10] : kind === 'identify' ? [120, 40, 20] : kind === 'pin-denial' ? [180, 60, 30] : [240, 120, 60];
  const labels = ['global', 'ip:' + String(ip || 'unknown').slice(0, 100), ...(stationId ? ['station:' + stationId] : [])];
  const now = Date.now(); await db.pruneClockStationAttempts(new Date(now - DAY));
  const rows = [];
  for (const label of labels) rows.push(await db.getClockStationAttempt(hmac('attempt', kind + ':' + label)));
  for (let index = 0; index < rows.length; index++) {
    const previous = rows[index], start = previous ? new Date(previous.startedAt).getTime() : 0;
    if (previous && now - start < windowMs && previous.count >= limits[index]) return Math.max(1, Math.ceil((start + windowMs - now) / 1000));
  }
  if (increment) for (let index = 0; index < rows.length; index++) {
    const previous = rows[index], start = previous ? new Date(previous.startedAt).getTime() : 0, active = previous && now - start < windowMs;
    await db.saveClockStationAttempt({ id: hmac('attempt', kind + ':' + labels[index]), startedAt: active ? previous.startedAt : new Date(now), count: active ? previous.count + 1 : 1 });
  }
  return 0;
}
async function reserve(kind, ip, stationId) {
  const retryAfter = await db.withAuthLock(() => attemptBudget(kind, ip, stationId));
  if (retryAfter) throw limited(retryAfter);
}
async function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const result = await derive(pin, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return 'scrypt$131072$8$1$' + salt + '$' + result.toString('hex');
}
let dummyPin;
async function verifyPin(pin, row) {
  dummyPin ||= hashPin(randomBytes(16).toString('hex'));
  return verifyPassword(pin, configuredPin(row) ? row.pinHash : await dummyPin);
}
function signGrant(value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return body + '.' + hmac('grant', body);
}
function readGrant(value) {
  if (typeof value !== 'string' || value.length > 2048) throw grantError();
  const [body, signature, extra] = value.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body || '') || !safeEqual(signature, hmac('grant', body))) throw grantError();
  let grant; try { grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw grantError(); }
  if (!grant || typeof grant !== 'object' || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || !Number.isSafeInteger(grant.version) || !Number.isSafeInteger(grant.pinVersion) || !/^[a-f0-9]{32}$/.test(grant.id || '') || !['checkin', 'checkout'].includes(grant.action)) throw grantError();
  return grant;
}

exports.management = token => db.withAuthLock(async () => {
  const actor = await administrator(token), pins = await db.listStaffClockPins();
  const byStaff = new Map(pins.map(pin => [pin.staffId, pin]));
  const result = { stations: (await db.listClockStations()).map(publicStation), staff: (await staffList()).map(person => ({ id: person.id, name: person.name, active: person.active, pinConfigured: configuredPin(byStaff.get(person.id)) })) };
  await auth.audit(actor, 'clock_station.manage'); return result;
});
exports.createPairing = (token, payload) => db.withAuthLock(async () => {
  const actor = await administrator(token); v.object(payload, ['name']);
  const name = v.text(payload.name, 'station name', 160, { required: true });
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...randomBytes(12)].map(value => alphabet[value & 31]).join('');
  const now = new Date(), expiresAt = new Date(now.getTime() + PAIR_LIFETIME);
  await db.createClockPairing({ id: hash(code), name, createdBy: actor.id, createdAt: now, expiresAt, consumedAt: null });
  await auth.audit(actor, 'clock_station.pairing_create'); return { code, expiresAt };
});
exports.revoke = (token, id, payload) => db.withAuthLock(async () => {
  const actor = await administrator(token); v.object(payload, []); v.identifier(id, 'station');
  const station = await db.getClockStationById(id); if (!station) throw auth.problem('Clock station not found.', 404);
  if (!station.revokedAt) await db.updateClockStation(id, { revokedAt: new Date() });
  await auth.audit(actor, 'clock_station.revoke', id); return { saved: true };
});
exports.setPin = (token, staffId, payload) => db.withAuthLock(async () => {
  const actor = await administrator(token); v.object(payload, ['pin']); v.identifier(staffId, 'staff');
  const staff = await db.getStaffById(staffId); if (!staff) throw auth.problem('Staff record not found.', 404);
  const disabling = payload.pin === null || payload.pin === '';
  if (!disabling && (typeof payload.pin !== 'string' || !/^[0-9]{6}$/.test(payload.pin))) throw auth.problem('Choose a six-digit PIN.');
  const previous = await db.getStaffClockPin(staffId), now = new Date();
  const pinLookup = hmac('pin-lookup', disabling ? 'disabled:' + randomBytes(32).toString('hex') : payload.pin);
  const duplicate = await db.getStaffClockPinByLookup(pinLookup);
  if (duplicate && duplicate.staffId !== staffId) throw auth.problem('That PIN is already in use. Choose another PIN.', 409);
  await db.saveStaffClockPin({ staffId, pinLookup, pinHash: disabling ? 'disabled' : await hashPin(payload.pin), version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now });
  await auth.audit(actor, disabling ? 'clock_station.pin_disable' : 'clock_station.pin_set', staffId); return { saved: true };
});
exports.pair = async (payload, { ip, personalToken, previousCredential } = {}) => {
  v.object(payload, ['code']); await reserve('pair', ip);
  return db.withAuthLock(async () => {
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    const pairing = /^[A-HJ-NP-Z2-9]{12}$/.test(code) ? await db.getClockPairing(hash(code)) : null;
    if (!pairing || pairing.consumedAt || new Date(pairing.expiresAt).getTime() <= Date.now()) throw auth.problem('The pairing code is invalid or expired. Ask an administrator for a new code.', 401, 'STATION_PAIR_INVALID');
    const issuer = await db.getAccount(pairing.createdBy);
    if (!issuer || issuer.disabled || issuer.role !== 'admin') throw auth.problem('The pairing code is invalid or expired. Ask an administrator for a new code.', 401, 'STATION_PAIR_INVALID');
    const now = new Date(), credential = randomBytes(32).toString('hex');
    const station = await db.createClockStation({ id: randomUUID(), name: pairing.name, credentialHash: hash(credential), createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + STATION_LIFETIME), revokedAt: null });
    await db.updateClockPairing(pairing.id, { consumedAt: now });
    if (typeof personalToken === 'string' && /^[a-f0-9]{64}$/.test(personalToken)) await db.deleteSession(auth.digest(personalToken));
    if (typeof previousCredential === 'string' && /^[a-f0-9]{64}$/.test(previousCredential)) {
      const previous = await db.getClockStationByCredentialHash(hash(previousCredential));
      if (previous && !previous.revokedAt) await db.updateClockStation(previous.id, { revokedAt: now });
    }
    await auth.audit(stationActor(station), 'clock_station.pair', station.id);
    return { ...sessionData(station, credential), credential, maxAge: STATION_LIFETIME };
  });
};
exports.session = credential => db.withAuthLock(async () => {
  const station = await currentStation(credential); await db.updateClockStation(station.id, { lastUsedAt: new Date() });
  return sessionData(station, credential);
});
exports.hasActiveStation = async credential => {
  if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential)) return false;
  const station = await db.getClockStationByCredentialHash(hash(credential));
  return !!station && !station.revokedAt && new Date(station.expiresAt).getTime() > Date.now();
};
exports.logout = (credential, { csrfToken, personalToken } = {}) => db.withAuthLock(async () => {
  const station = await currentStation(credential); assertCsrf(credential, csrfToken);
  await db.updateClockStation(station.id, { revokedAt: new Date() });
  if (typeof personalToken === 'string' && /^[a-f0-9]{64}$/.test(personalToken)) await db.deleteSession(auth.digest(personalToken));
  await auth.audit(stationActor(station), 'clock_station.sign_out', station.id); return { saved: true };
});
exports.identify = async (credential, payload, { ip, csrfToken } = {}, getState) => {
  v.object(payload, ['pin']);
  const stationId = await db.withAuthLock(async () => { const station = await currentStation(credential); assertCsrf(credential, csrfToken); return station.id; });
  await reserve('identify', ip, stationId);
  const pin = typeof payload.pin === 'string' && /^[0-9]{6}$/.test(payload.pin) ? payload.pin : '';
  const candidate = await db.withAuthLock(async () => {
    const station = await currentStation(credential); assertCsrf(credential, csrfToken);
    const retryAfter = await attemptBudget('pin-denial', ip, station.id, false);
    if (retryAfter) throw limited(retryAfter);
    return pin ? db.getStaffClockPinByLookup(hmac('pin-lookup', pin)) : null;
  });
  // Keep the expensive password hash outside the global authorization lock.
  // The second transaction validates the exact PIN revision again.
  const verified = await verifyPin(pin || '000000', candidate);
  const result = await db.withAuthLock(async () => {
    const station = await currentStation(credential); assertCsrf(credential, csrfToken);
    const retryAfter = await attemptBudget('pin-denial', ip, station.id, false);
    if (retryAfter) return { denied: limited(retryAfter) };
    const saved = candidate ? await db.getStaffClockPin(candidate.staffId) : null;
    const staff = saved ? await db.getStaffById(saved.staffId) : null;
    if (!verified || !configuredPin(saved) || saved.version !== candidate.version || saved.pinHash !== candidate.pinHash || saved.pinLookup !== candidate.pinLookup || !staff?.active) {
      await attemptBudget('pin-denial', ip, station.id);
      return { denied: auth.problem('PIN not recognized. Please try again.', 401, 'STATION_PIN_INVALID') };
    }
    const state = await getState(staff.id);
    const grant = { id: randomBytes(16).toString('hex'), stationId: station.id, credentialHash: station.credentialHash, staffId: staff.id, pinVersion: saved.version, pinLookup: saved.pinLookup,
      version: state.version, action: state.checkedIn ? 'checkout' : 'checkin', expiresAt: Date.now() + GRANT_LIFETIME };
    await db.updateClockStation(station.id, { lastUsedAt: new Date() });
    return { staff: { id: staff.id, name: staff.name }, checkedIn: state.checkedIn, version: state.version, clockToken: signGrant(grant) };
  });
  // Commit failed PIN counters before reporting denial. A successful PIN never
  // clears them, so the normal arrival queue cannot reset a guessing budget.
  if (result.denied) throw result.denied;
  return result;
};
exports.clock = async (credential, payload, { ip, csrfToken } = {}, mutate) => {
  v.object(payload, ['clockToken', 'action', 'requestId', 'version']);
  const stationId = await db.withAuthLock(async () => { const station = await currentStation(credential); assertCsrf(credential, csrfToken); return station.id; });
  await reserve('clock', ip, stationId);
  return db.withAuthLock(async () => {
    const station = await currentStation(credential); assertCsrf(credential, csrfToken); const grant = readGrant(payload.clockToken);
    if (grant.stationId !== station.id || grant.credentialHash !== station.credentialHash || payload.version !== grant.version || payload.action !== grant.action) throw grantError();
    const pin = await db.getStaffClockPin(grant.staffId), staff = await db.getStaffById(grant.staffId);
    if (!configuredPin(pin) || pin.version !== grant.pinVersion || pin.pinLookup !== grant.pinLookup || !staff?.active) throw grantError();
    const result = await mutate(stationActor(station), staff.id, { action: payload.action, requestId: payload.requestId, version: payload.version }, { stationId: station.id, grantId: grant.id });
    await db.updateClockStation(station.id, { lastUsedAt: new Date() });
    return { action: payload.action, replayed: result.replayed };
  });
};
