const { randomUUID, randomBytes, createHash, createHmac } = require('node:crypto');
const http = require('supertest');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const payroll = require('../services/payrollService');
const station = require('../services/clockStationService');
const vault = require('../services/payrollVault');
const app = require('../index');
const fixture = require('./helpers/authenticatedRequest');
const hash = value => createHash('sha256').update(value).digest('hex');
let key;
beforeAll(() => { key = require('./helpers/payrollKey').install(); });
afterAll(() => key.cleanup());
afterEach(() => jest.restoreAllMocks());
const admin = () => fixture.credentials().cookie.split('=')[1];
const person = (name = 'Synthetic employee') => db.createStaff({ id: randomUUID(), name, role: 'Teacher', active: true, roomId: null, version: 1 });
async function actor(role) {
  const account = await db.createAccount({ id: randomUUID(), username: 'clock-test-' + randomUUID(), displayName: 'Synthetic', role, disabled: false, mustChangePassword: false, passwordHash: 'unused' });
  const token = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: account.id, remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 86400000) });
  return token;
}
const personalApi = (token, method, path, body) => http(app)[method]('/api' + path).set('Origin', fixture.origin).set('Cookie', 'skao_session=' + token).set('X-CSRF-Token', auth.csrfToken(token)).send(body);
const stationApi = (session, method, path, body) => http(app)[method]('/api/station-clock' + path).set('Origin', fixture.origin).set('Cookie', 'skao_clock_station=' + session.credential).set('X-CSRF-Token', session.csrfToken).send(body);
const options = session => ({ ip: '192.0.2.20', csrfToken: session.csrfToken });
async function paired(name = 'Synthetic entry tablet') {
  const pairing = await station.createPairing(admin(), { name });
  return station.pair({ code: pairing.code }, { ip: '192.0.2.20' });
}
async function prepared() {
  const staff = await person(), session = await paired();
  await station.setPin(admin(), staff.id, { pin: '246810' });
  return { staff, session, identify: () => payroll.stationIdentify(session.credential, { pin: '246810' }, options(session)) };
}
const action = (grant, extra = {}) => ({ clockToken: grant.clockToken, action: grant.checkedIn ? 'checkout' : 'checkin', version: grant.version, requestId: randomUUID(), ...extra });
const ledger = async id => vault.open(await db.getPayrollRecord('ledger:' + id));
function attemptId(kind, scope) {
  const secret = createHmac('sha256', vault.check()).update('skao-clock-station:attempt:v1').digest();
  return createHmac('sha256', secret).update(kind + ':' + scope).digest('hex');
}

test('only managers clock staff and personal self-clock endpoints are forbidden for every account role', async () => {
  const staff = await person();
  for (const role of ['admin', 'editor', 'teacher', 'viewer']) {
    const token = role === 'admin' ? admin() : await actor(role);
    for (const method of ['get', 'post']) expect((await personalApi(token, method, '/time-clock', method === 'post' ? { action: 'checkin', requestId: randomUUID(), version: 0 } : undefined)).status).toBe(403);
    const status = await personalApi(token, 'get', '/work-time/clock');
    const response = await personalApi(token, 'post', '/work-time/staff/' + staff.id + '/clock', { action: 'checkin', requestId: randomUUID(), version: role === 'editor' ? 2 : 0 });
    expect(status.status).toBe(['admin', 'editor'].includes(role) ? 200 : 403);
    expect(response.status).toBe(['admin', 'editor'].includes(role) ? 200 : 403);
    if (role === 'admin') await payroll.managerClock(token, staff.id, { action: 'checkout', requestId: randomUUID(), version: 1 });
  }
  const projection = (await payroll.clockStatus(admin())).staff.find(row => row.id === staff.id);
  expect(Object.keys(projection).sort()).toEqual(['active', 'checkedIn', 'id', 'name', 'version']);
  expect(projection.checkedIn).toBe(true);
});

test('station setup is admin-only; PINs are unique, salted, versioned and never returned', async () => {
  const one = await person(), two = await person(), editor = await actor('editor');
  for (const path of ['/clock-stations', '/clock-stations/pairing', '/clock-stations/staff/' + one.id + '/pin']) expect((await personalApi(editor, path === '/clock-stations' ? 'get' : 'post', path, { name: 'Restricted', pin: '246810' })).status).toBe(403);
  await station.setPin(admin(), one.id, { pin: '246810' });
  const original = await db.getStaffClockPin(one.id);
  expect(original.pinHash).toMatch(/^scrypt\$131072\$8\$1\$/); expect(original.pinHash).not.toContain('246810'); expect(original.pinLookup).toMatch(/^[a-f0-9]{64}$/);
  await expect(station.setPin(admin(), two.id, { pin: '246810' })).rejects.toMatchObject({ status: 409 });
  expect(await db.getStaffClockPin(two.id)).toBeNull();
  await station.setPin(admin(), one.id, { pin: null });
  expect((await station.management(admin())).staff.find(row => row.id === one.id).pinConfigured).toBe(false);
  await station.setPin(admin(), one.id, { pin: '246810' });
  const reset = await db.getStaffClockPin(one.id); expect(reset.version).toBe(3); expect(reset.pinHash).not.toBe(original.pinHash);
  const result = await station.management(admin()); expect(JSON.stringify(result)).not.toMatch(/pinHash|pinLookup|246810|credentialHash/);
});

test('pairing is single-use and replaces the personal session with a restricted host-only cookie', async () => {
  const token = admin(), pairing = await station.createPairing(token, { name: 'Entry tablet' });
  expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
  expect(await db.getClockPairing(hash(pairing.code))).toMatchObject({ consumedAt: null });
  const response = await personalApi(token, 'post', '/station-clock/pair', { code: pairing.code }); expect(response.status).toBe(200);
  const cookies = response.headers['set-cookie'], cookie = cookies.find(value => value.startsWith('skao_clock_station='));
  expect(cookie).toContain('Path=/api'); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).not.toContain('Domain=');
  expect(cookies.some(value => value.startsWith('skao_session=;'))).toBe(true);
  expect(await db.getSession(auth.digest(token))).toBeNull();
  expect(Object.keys(response.body.data).sort()).toEqual(['csrfToken', 'station']);
  expect(response.body.data.station).toEqual({ name: 'Entry tablet', expiresAt: expect.any(String) });
  expect((await http(app).post('/api/station-clock/pair').set('Origin', fixture.origin).send({ code: pairing.code })).status).toBe(401);
  expect((await db.getClockPairing(hash(pairing.code))).consumedAt).toBeTruthy();
});

test('expired pairing codes, disabled issuers and untrusted origins cannot pair a device', async () => {
  const pairing = await station.createPairing(admin(), { name: 'Expired' });
  await db.updateClockPairing(hash(pairing.code), { createdAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 1) });
  await expect(station.pair({ code: pairing.code }, { ip: '192.0.2.20' })).rejects.toMatchObject({ code: 'STATION_PAIR_INVALID' });
  const fresh = await station.createPairing(admin(), { name: 'Disabled issuer' }); await db.updateAccount(fixture.credentials().account.id, { disabled: true });
  await expect(station.pair({ code: fresh.code }, { ip: '192.0.2.20' })).rejects.toMatchObject({ code: 'STATION_PAIR_INVALID' });
  const denied = await http(app).post('/api/station-clock/pair').set('Origin', 'https://untrusted.invalid').send({ code: fresh.code }); expect(denied.status).toBe(403);
  expect(await db.listClockStations()).toEqual([]);
});

test('station mode blocks personal login and private API access even if another personal cookie is added', async () => {
  const session = await paired(), token = admin(), cookie = 'skao_clock_station=' + session.credential + '; skao_session=' + token;
  for (const path of ['/api/auth/session', '/api/accounts', '/api/work-time/clock', '/api/payroll/staff', '/api/children']) {
    const response = await http(app).get(path).set('Cookie', cookie); expect(response.status).toBe(403); expect(response.body.error.code).toBe('STATION_MODE');
  }
  expect((await http(app).post('/api/auth/login').set('Origin', fixture.origin).set('Cookie', cookie).send({ username: fixture.credentials().account.username, password: fixture.password })).body.error.code).toBe('STATION_MODE');
  expect((await http(app).post('/api/station-clock/logout').set('Origin', fixture.origin).set('Cookie', cookie).set('X-CSRF-Token', session.csrfToken).send({})).status).toBe(200);
  expect((await personalApi(token, 'get', '/auth/session')).status).toBe(401);
  expect((await stationApi(session, 'get', '/session')).body.error.code).toBe('STATION_EXPIRED');
});

test('identify returns one employee and one allowed action without a roster, pay or recorded hours', async () => {
  const { staff, session, identify } = await prepared(); await person('Other employee');
  expect(Object.keys(await station.session(session.credential)).sort()).toEqual(['csrfToken', 'station']);
  const grant = await identify(); expect(grant).toMatchObject({ staff: { id: staff.id, name: staff.name }, checkedIn: false, version: 0 });
  expect(Object.keys(grant).sort()).toEqual(['checkedIn', 'clockToken', 'staff', 'version']);
  expect(JSON.stringify(grant)).not.toMatch(/Other employee|paidMillis|rates|taxId|bankAccount|sessions/);
  const response = await stationApi(session, 'post', '/identify', { pin: '999999' });
  expect(response.status).toBe(401); expect(response.body.error.code).toBe('STATION_PIN_INVALID');
  expect((response.headers['set-cookie'] || []).some(value => value.startsWith('skao_clock_station=;'))).toBe(false);
  expect((await stationApi(session, 'get', '/session')).status).toBe(200);
  expect((await http(app).post('/api/station-clock/identify').set('Origin', fixture.origin).set('Cookie', 'skao_clock_station=' + session.credential).send({ pin: '246810' })).status).toBe(403);
});

test('station actions are server-timestamped, version-bound and idempotent with device and employee attribution', async () => {
  const { staff, session, identify } = await prepared(), grant = await identify(), payload = action(grant), before = Date.now();
  const results = await Promise.all([payroll.stationClock(session.credential, payload, options(session)), payroll.stationClock(session.credential, payload, options(session))]);
  expect(results).toEqual(expect.arrayContaining([{ action: 'checkin', replayed: false }, { action: 'checkin', replayed: true }]));
  const stored = await ledger(staff.id); expect(stored.sessions).toHaveLength(1); expect(stored.history).toHaveLength(1);
  const record = stored.sessions[0]; expect(Date.parse(record.start)).toBeGreaterThanOrEqual(before); expect(record.original.start).toBe(record.start);
  const device = (await db.listClockStations())[0]; expect(record).toMatchObject({ staffId: staff.id, stationId: device.id, actorType: 'clock-station', actorId: null });
  expect(stored.history[0]).toMatchObject({ stationId: device.id, staffId: staff.id, actorUsername: 'clock-station:' + device.id });
  expect((await db.listAudit({ actions: ['employee_clock.checkin'] }))).toMatchObject([{ actorId: null, actorUsername: 'clock-station:' + device.id, entityId: staff.id }]);
  await expect(payroll.stationClock(session.credential, { ...payload, requestId: randomUUID() }, options(session))).rejects.toMatchObject({ status: 409 });
  await expect(payroll.stationClock(session.credential, { ...payload, action: 'checkout', version: 1, requestId: randomUUID() }, options(session))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  const next = await identify(); expect(next.checkedIn).toBe(true);
  expect((await payroll.stationClock(session.credential, action(next), options(session))).action).toBe('checkout');
  expect((await ledger(staff.id)).sessions[0].end).toBeTruthy();
});

test('grants cannot cross stations, be edited, select another employee or survive their short expiry', async () => {
  const { staff, session, identify } = await prepared(), other = await paired('Other tablet'), grant = await identify(), payload = action(grant);
  await expect(payroll.stationClock(other.credential, payload, options(other))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  await expect(payroll.stationClock(session.credential, { ...payload, clockToken: payload.clockToken + 'a' }, options(session))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  await expect(payroll.stationClock(session.credential, { ...payload, staffId: randomUUID() }, options(session))).rejects.toMatchObject({ status: 400 });
  const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 46000);
  await expect(payroll.stationClock(session.credential, payload, options(session))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  expect(await db.getPayrollRecord('ledger:' + staff.id)).toBeNull();
});

test('resetting the same PIN, disabling it or deactivating staff invalidates already issued grants', async () => {
  const { staff, session, identify } = await prepared();
  const first = await identify(); await station.setPin(admin(), staff.id, { pin: '246810' });
  await expect(payroll.stationClock(session.credential, action(first), options(session))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  const second = await identify(); await station.setPin(admin(), staff.id, { pin: null }); await station.setPin(admin(), staff.id, { pin: '246810' });
  await expect(payroll.stationClock(session.credential, action(second), options(session))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  const third = await identify(); await db.updateStaff(staff.id, { active: false });
  await expect(payroll.stationClock(session.credential, action(third), options(session))).rejects.toMatchObject({ code: 'CLOCK_GRANT_STALE' });
  await expect(identify()).rejects.toMatchObject({ code: 'STATION_PIN_INVALID' }); expect(await db.getPayrollRecord('ledger:' + staff.id)).toBeNull();
});

test('revocation and expiry reject live station sessions and previously issued grants', async () => {
  const { staff, session, identify } = await prepared(), grant = await identify(), device = (await db.listClockStations())[0];
  await station.revoke(admin(), device.id, {});
  await expect(payroll.stationClock(session.credential, action(grant), options(session))).rejects.toMatchObject({ code: 'STATION_EXPIRED' });
  await expect(station.session(session.credential)).rejects.toMatchObject({ code: 'STATION_EXPIRED' });
  const next = await paired(); const row = (await db.listClockStations()).find(value => !value.revokedAt); await db.updateClockStation(row.id, { createdAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 1) });
  expect((await stationApi(next, 'get', '/session')).status).toBe(401); expect(await db.getPayrollRecord('ledger:' + staff.id)).toBeNull();
});

test('an audit failure rolls back clock state and last use but retains the committed request budget', async () => {
  const { staff, session, identify } = await prepared(), grant = await identify(), device = (await db.listClockStations())[0];
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic station audit failure'));
  await expect(payroll.stationClock(session.credential, action(grant), options(session))).rejects.toThrow('Synthetic station audit failure'); audit.mockRestore();
  expect(await db.getPayrollRecord('ledger:' + staff.id)).toBeNull(); expect((await db.getClockStationById(device.id)).lastUsedAt).toEqual(device.lastUsedAt);
  expect(await db.getClockStationAttempt(attemptId('clock', 'station:' + device.id))).toMatchObject({ count: 1 });
  expect((await payroll.stationClock(session.credential, action(grant), options(session))).replayed).toBe(false);
});

test('failed PIN counts commit, survive successful entries and stop guessing across throughput windows', async () => {
  const { session, identify } = await prepared(), device = (await db.listClockStations())[0];
  await expect(payroll.stationIdentify(session.credential, { pin: '999999' }, options(session))).rejects.toMatchObject({ code: 'STATION_PIN_INVALID' });
  const id = attemptId('pin-denial', 'station:' + device.id), saved = await db.getClockStationAttempt(id); expect(saved.count).toBe(1);
  await identify(); expect((await db.getClockStationAttempt(id)).count).toBe(1);
  // Simulate persisted earlier failures without spending the test run hashing
  // thirty wrong guesses. The production path above created this exact row.
  await db.saveClockStationAttempt({ ...saved, count: 30 });
  await expect(identify()).rejects.toMatchObject({ status: 429, code: 'STATION_RATE_LIMITED', retryAfter: expect.any(Number) });
  expect((await db.getClockStationAttempt(id)).count).toBe(30);
});

test('a normal queue of ten employees can identify and clock without a rate-limit lockout', async () => {
  const session = await paired();
  for (let index = 0; index < 10; index++) {
    const staff = await person('Synthetic employee ' + index), pin = String(200000 + index);
    await station.setPin(admin(), staff.id, { pin });
    const grant = await payroll.stationIdentify(session.credential, { pin }, options(session));
    expect((await payroll.stationClock(session.credential, action(grant), options(session))).replayed).toBe(false);
    expect((await ledger(staff.id)).sessions).toHaveLength(1);
  }
}, 60000);

test('invalid pairing attempts remain durable and return a retry delay without creating stations', async () => {
  for (let index = 0; index < 10; index++) await expect(station.pair({ code: 'ZZZZZZZZZZZZ' }, { ip: '192.0.2.77' })).rejects.toMatchObject({ code: 'STATION_PAIR_INVALID' });
  await expect(station.pair({ code: 'ZZZZZZZZZZZZ' }, { ip: '192.0.2.77' })).rejects.toMatchObject({ status: 429, retryAfter: expect.any(Number) });
  expect(await db.getClockStationAttempt(attemptId('pair', 'ip:192.0.2.77'))).toMatchObject({ count: 10 });
  expect(await db.listClockStations()).toHaveLength(0);
});
