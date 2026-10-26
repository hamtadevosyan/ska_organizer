const { randomUUID, randomBytes } = require('node:crypto');
const supertest = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const config = require('../auth/config');
const service = require('../services/billingService');
const fixture = require('./helpers/authenticatedRequest');
const api = fixture(app);
const frozen = '2026-10-06T18:00:00Z';
let child;
const token = () => fixture.credentials().cookie.split('=')[1];
const path = suffix => '/api/billing/children/' + child.id + (suffix ? '/' + suffix : '');
const payload = (version, extra = {}) => ({ version, requestId: randomUUID(), ...extra });
const profile = (version = 0, extra = {}) => payload(version, { billingStart: '2026-10-01', billingEnd: null, enabled: true, effectiveMonth: '2026-10', familyCents: 30000, ccrcCents: 70000, familyDueDay: 1, ccrcDueDay: 15, registrationCents: 20000, ...extra });
async function post(suffix, body, status = 200) {
  const response = await api.post(path(suffix)).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status >= 400 ? expect.anything() : undefined });
  return response.body.data;
}
async function detail() { return service.get(token(), child.id); }
function setTime(value) { jest.setSystemTime(new Date(value)); }
beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'] });
  setTime(frozen);
  // Use a fresh ordinary session at the synthetic clock time; production expiry
  // remains enabled rather than relying on the real runner's calendar date.
  const credentials = fixture.credentials();
  await db.updateSession(auth.digest(token()), { createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.absoluteMs) });
  child = await db.createChild({ id: randomUUID(), firstName: 'Synthetic', lastName: 'Billing child', dateOfBirth: '2022-05-06', active: true, roomId: null });
  expect(credentials.account.role).toBe('admin');
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

test('billing GETs never generate charges, and profile save records a fixed monthly snapshot exactly once', async () => {
  const empty = await detail();
  expect(empty).toMatchObject({ version: 0, profile: null, charges: [], payments: [] });
  expect(await db.getChildBillingRecord(child.id)).toBeNull();
  const body = profile(), saved = await post('profile', body);
  expect(saved).toMatchObject({ version: 1, pendingMonthlyCharges: 0, totals: { chargedCents: 100000, familyOutstandingCents: 30000, ccrcOutstandingCents: 70000 } });
  expect(saved.charges).toHaveLength(1); expect(saved.charges[0].id).toBe('monthly:2026-10');
  expect((await post('profile', body)).version).toBe(1);
  expect((await post('profile', { ...body, version: 1 })).version).toBe(1);
  expect(await post('profile', { ...body, familyCents: 30001 }, 409)).toBeUndefined();
  const generated = await post('generate', payload(1, { throughMonth: '2026-10' }));
  expect(generated.charges).toHaveLength(1);
  expect((await db.listAudit({ actions: ['billing.profile'] })).length).toBe(1);
});

test('partial family receipts leave expected CCRC money separate and resolve only the paid balance', async () => {
  const setup = await post('profile', profile());
  expect((await service.alerts(token())).items).toMatchObject([{ payer: 'family', outstandingCents: 30000, daysOverdue: 5 }]);
  const request = payload(setup.version, { payer: 'family', amountCents: 10001, date: '2026-10-06', method: 'check', reference: 'Synthetic receipt', chargeId: setup.charges[0].id });
  const saved = await post('payments', request);
  expect(saved.totals).toMatchObject({ paidCents: 10001, familyOutstandingCents: 19999, ccrcOutstandingCents: 70000, overdueCents: 19999 });
  expect((await post('payments', request)).payments).toHaveLength(1);
  await post('payments', { ...request, amountCents: 10002 }, 409);
  const next = await post('payments', payload(saved.version, { payer: 'family', amountCents: 19999, date: '2026-10-06', method: 'cash', reference: '', chargeId: setup.charges[0].id }));
  expect(next.totals.familyOutstandingCents).toBe(0);
  expect((await service.alerts(token())).items).toEqual([]);
});

test('overpayments stay payer-specific credit, can be applied explicitly and reverse without deleting history', async () => {
  let saved = await post('profile', profile());
  saved = await post('payments', payload(saved.version, { payer: 'family', amountCents: 50000, date: '2026-10-06', method: 'bank-transfer', reference: '', chargeId: saved.charges[0].id }));
  const payment = saved.payments[0];
  expect(payment).toMatchObject({ allocatedCents: 30000, creditCents: 20000 });
  expect(saved.totals).toMatchObject({ familyOutstandingCents: 0, ccrcOutstandingCents: 70000, creditCents: 20000 });
  const invalid = payload(saved.version, { paymentId: payment.id, chargeId: saved.charges[0].id, amountCents: 1 });
  await post('credits', invalid, 400);
  saved = await post('charges', payload(saved.version, { kind: 'registration', title: 'Registration', familyCents: 20000, ccrcCents: 0, familyDueDate: '2026-10-01', ccrcDueDate: '2026-10-01', reason: 'Enrollment fee' }));
  const registration = saved.charges.find(row => row.kind === 'registration');
  saved = await post('credits', payload(saved.version, { paymentId: payment.id, chargeId: registration.id, amountCents: 20000 }));
  expect(saved.totals).toMatchObject({ familyOutstandingCents: 0, creditCents: 0, ccrcOutstandingCents: 70000 });
  saved = await post('payments/' + payment.id + '/reverse', payload(saved.version, { reason: 'Corrected duplicate external receipt' }));
  expect(saved.payments[0]).toMatchObject({ reversed: true, allocatedCents: 0, creditCents: 0 });
  expect(saved.totals).toMatchObject({ familyOutstandingCents: 50000, paidCents: 0, ccrcOutstandingCents: 70000 });
  expect(saved.history.map(row => row.type)).toEqual(expect.arrayContaining(['payment', 'credit', 'payment_reversal']));
});

test('registration is explicit, repeat charging needs confirmation, and waivers preserve the original fee', async () => {
  let saved = await post('profile', profile());
  expect(saved.charges.every(row => row.kind === 'monthly')).toBe(true);
  const body = payload(saved.version, { kind: 'registration', title: 'Registration', familyCents: 20000, ccrcCents: 0, familyDueDate: '2026-10-01', ccrcDueDate: '2026-10-01', reason: 'Explicit enrollment fee' });
  saved = await post('charges', body);
  await post('charges', { ...body, requestId: randomUUID(), version: saved.version }, 409);
  const fee = saved.charges.find(row => row.kind === 'registration');
  saved = await post('charges/' + fee.id + '/adjustments', payload(saved.version, { payer: 'family', amountCents: -20000, reason: 'Administrator waives registration' }));
  expect(saved.charges.find(row => row.id === fee.id)).toMatchObject({ status: 'waived', amountCents: 0, adjustments: [{ amountCents: -20000 }] });
  expect((await db.getChildBillingRecord(child.id)).data.charges.find(row => row.id === fee.id).payers.family.amountCents).toBe(20000);
});

test('a receipt with no selected charge stays unapplied rather than hiding an overdue debt', async () => {
  const setup = await post('profile', profile());
  const saved = await post('payments', payload(setup.version, { payer: 'ccrc', amountCents: 10000, date: '2026-10-06', method: 'ccrc', reference: 'Statement reported', chargeId: null }));
  expect(saved.totals).toMatchObject({ ccrcCreditCents: 10000, ccrcOutstandingCents: 70000, familyOutstandingCents: 30000 });
  expect((await service.alerts(token())).items).toHaveLength(1);
});

test('rates and due dates change future uncharged months, never old charge snapshots', async () => {
  let saved = await post('profile', profile());
  const storedOriginal = (await db.getChildBillingRecord(child.id)).data.charges[0];
  saved = await post('profile', profile(saved.version, { effectiveMonth: '2026-11', familyCents: 40000, ccrcCents: 80000, familyDueDay: 31 }));
  expect((await db.getChildBillingRecord(child.id)).data.charges[0]).toEqual(storedOriginal);
  setTime('2026-11-06T18:00:00Z');
  await db.updateSession(auth.digest(token()), { createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.absoluteMs) });
  expect((await detail()).pendingMonthlyCharges).toBe(1);
  expect((await service.alerts(token())).pendingMonthlyCharges).toBe(1);
  const first = await service.runMaintenance(), again = await service.runMaintenance();
  expect(first).toMatchObject({ generated: 1, failed: 0 }); expect(again.generated).toBe(0);
  saved = await detail();
  expect((await db.getChildBillingRecord(child.id)).data.charges[0]).toEqual(storedOriginal);
  expect(saved.charges[1]).toMatchObject({ month: '2026-11', payers: { family: { amountCents: 40000, dueDate: '2026-11-30' }, ccrc: { amountCents: 80000 } } });
});

test('moving billing start earlier without a covering rate is rejected atomically', async () => {
  const saved = await post('profile', profile());
  await post('profile', profile(saved.version, { billingStart: '2026-09-01' }), 400);
  expect((await detail()).version).toBe(saved.version);
  expect((await detail()).profile.billingStart).toBe('2026-10-01');
});

test.each(['inactive', 'disabled', 'ended'])('maintenance stops new charges for %s while retaining past balances', async mode => {
  let saved = await post('profile', profile(0, mode === 'ended' ? { billingEnd: '2026-10-15' } : {}));
  if (mode === 'inactive') await db.updateChild(child.id, { active: false });
  if (mode === 'disabled') saved = await post('profile', profile(saved.version, { enabled: false }));
  setTime('2026-11-06T18:00:00Z');
  expect((await service.runMaintenance()).generated).toBe(0);
  expect((await db.getChildBillingRecord(child.id)).data.charges).toHaveLength(1);
});

test('an audit failure rolls back the payment, version, history and idempotency reservation', async () => {
  const saved = await post('profile', profile()), before = await db.getChildBillingRecord(child.id);
  const request = payload(saved.version, { payer: 'family', amountCents: 1, date: '2026-10-06', method: 'cash', reference: '', chargeId: saved.charges[0].id });
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await post('payments', request, 500); } finally { audit.mockRestore(); logging.mockRestore(); }
  expect(await db.getChildBillingRecord(child.id)).toEqual(before);
  expect((await post('payments', request)).payments).toHaveLength(1);
});

test('stale versions, invalid money and reductions below applied payments never change the ledger', async () => {
  let saved = await post('profile', profile());
  await post('payments', payload(0, { payer: 'family', amountCents: 1, date: '2026-10-06' }), 409);
  for (const amountCents of [-1, 0, 1.1, '100']) await post('payments', payload(saved.version, { payer: 'family', amountCents, date: '2026-10-06', chargeId: null }), 400);
  saved = await post('payments', payload(saved.version, { payer: 'family', amountCents: 10000, date: '2026-10-06', method: 'cash', reference: '', chargeId: saved.charges[0].id }));
  await post('charges/' + saved.charges[0].id + '/adjustments', payload(saved.version, { payer: 'family', amountCents: -20001, reason: 'Invalid reduction' }), 400);
  expect((await detail()).version).toBe(saved.version);
});

test.each(['editor', 'teacher', 'viewer'])('%s cannot read billing pages, alerts or modify payments', async role => {
  const root = await db.getAccount(fixture.credentials().account.id), id = randomUUID(), sessionToken = randomBytes(32).toString('hex');
  await db.createAccount({ id, username: 'billing-' + id, displayName: 'Synthetic ' + role, passwordHash: root.passwordHash, role, disabled: false, mustChangePassword: false, roomId: null, staffMemberId: null });
  await db.createSession({ id: auth.digest(sessionToken), accountId: id, createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.absoluteMs) });
  for (const route of ['/api/billing', '/api/billing/alerts', path()]) {
    const response = await supertest(app).get(route).set('Cookie', 'skao_session=' + sessionToken);
    expect(response.status).toBe(403); expect(JSON.stringify(response.body)).not.toContain(child.firstName);
  }
  const response = await supertest(app).post(path('profile')).set('Cookie', 'skao_session=' + sessionToken).set('Origin', fixture.origin).set('X-CSRF-Token', auth.csrfToken(sessionToken)).send(profile());
  expect(response.status).toBe(403); expect(await db.getChildBillingRecord(child.id)).toBeNull();
});

test('ordinary session, origin and CSRF protections remain active on billing requests', async () => {
  expect((await supertest(app).get('/api/billing')).status).toBe(401);
  const noCsrf = await supertest(app).post(path('profile')).set('Origin', fixture.origin).set('Cookie', fixture.credentials().cookie).send(profile());
  expect(noCsrf.status).toBe(403); expect(noCsrf.body.error.code).toBe('CSRF_INVALID');
  const untrusted = await supertest(app).post(path('profile')).set('Origin', 'http://untrusted.invalid').set('Cookie', fixture.credentials().cookie).set('X-CSRF-Token', fixture.credentials().csrf).send(profile());
  expect(untrusted.status).toBe(403); expect(untrusted.body.error.code).toBe('UNTRUSTED_ORIGIN');
  expect((await api.get('/api/billing')).headers['cache-control']).toContain('no-store');
});

test('billing rechecks current role inside the transaction and rejects a disabled administrator', async () => {
  const id = fixture.credentials().account.id;
  await db.updateAccount(id, { role: 'editor' });
  await expect(service.profile(token(), child.id, profile())).rejects.toMatchObject({ status: 403 });
  await db.updateAccount(id, { role: 'admin', disabled: true });
  await expect(service.summary(token())).rejects.toMatchObject({ status: 401 });
  expect(await db.getChildBillingRecord(child.id)).toBeNull();
});

test('an attributed due-date correction resolves an alert without rewriting the original date', async () => {
  let saved = await post('profile', profile()); const charge = saved.charges[0];
  expect((await service.alerts(token())).items).toHaveLength(1);
  saved = await post('charges/' + charge.id + '/adjustments', payload(saved.version, { payer: 'family', amountCents: 0, dueDate: '2026-10-10', reason: 'Corrected agreed due date' }));
  expect((await service.alerts(token())).items).toEqual([]);
  const stored = (await db.getChildBillingRecord(child.id)).data.charges[0];
  expect(stored.payers.family.dueDate).toBe('2026-10-01'); expect(stored.adjustments[0].dueDate).toBe('2026-10-10');
});

test('the fifth-day alert starts at facility midnight, not after 120 elapsed hours', async () => {
  await post('profile', profile());
  const previousZone = process.env.FACILITY_TIME_ZONE;
  process.env.FACILITY_TIME_ZONE = 'America/Los_Angeles';
  try {
    setTime('2026-10-06T06:59:59Z');
    await db.updateSession(auth.digest(token()), { createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.absoluteMs) });
    expect((await service.alerts(token())).items).toEqual([]);
    setTime('2026-10-06T07:00:00Z');
    const alerts = await service.alerts(token());
    expect(alerts.items).toMatchObject([{ daysOverdue: 5, dueDate: '2026-10-01', payer: 'family' }]);
    expect((await service.alerts(token())).items[0].id).toBe(alerts.items[0].id);
  } finally { if (previousZone === undefined) delete process.env.FACILITY_TIME_ZONE; else process.env.FACILITY_TIME_ZONE = previousZone; }
});

test('two different payment requests from one stale screen cannot both commit', async () => {
  const saved = await post('profile', profile());
  const payment = { payer: 'family', amountCents: 1, date: '2026-10-06', method: 'cash', reference: '', chargeId: saved.charges[0].id };
  const responses = await Promise.all([api.post(path('payments')).send(payload(saved.version, payment)), api.post(path('payments')).send(payload(saved.version, payment))]);
  expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
  expect((await detail()).payments).toHaveLength(1);
});

test('ten years of existing monthly charges do not prevent the next new month', async () => {
  const math = require('../services/billingMath');
  let period = '2016-10'; const charges = [];
  for (let index = 0; index < 120; index++) {
    charges.push({ id: 'monthly:' + period, kind: 'monthly', month: period, title: 'Synthetic historic tuition', createdAt: '2026-01-01T00:00:00Z',
      payers: { family: { amountCents: 100, dueDate: period + '-01' }, ccrc: { amountCents: 0, dueDate: period + '-01' } }, adjustments: [] });
    period = math.nextMonth(period);
  }
  const rate = { effectiveMonth: '2016-10', familyCents: 100, ccrcCents: 0, familyDueDay: 1, ccrcDueDay: 1 };
  await db.saveChildBillingRecord({ childId: child.id, version: 1, data: { profile: { ...rate, billingStart: '2016-10-01', billingEnd: null, enabled: true, registrationCents: 0, rates: [rate] }, charges, payments: [], requests: [], history: [] } });
  expect(await service.runMaintenance()).toMatchObject({ generated: 1, failed: 0 });
  expect((await db.getChildBillingRecord(child.id)).data.charges).toHaveLength(121);
});

test('a failed scheduled child transaction does not prevent another child from catching up', async () => {
  const setup = await post('profile', profile());
  const another = await db.createChild({ id: randomUUID(), firstName: 'Second', lastName: 'Synthetic billing', dateOfBirth: '2022-05-06', active: true, roomId: null });
  const stored = await db.getChildBillingRecord(child.id);
  await db.saveChildBillingRecord({ childId: another.id, version: 1, data: { ...stored.data, history: [], requests: [] } });
  setTime('2026-11-06T18:00:00Z');
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic scheduled audit failure'));
  try {
    expect(await service.runMaintenance()).toMatchObject({ generated: 1, failed: 1 });
    expect((await db.listChildBillingRecords()).map(row => row.data.charges.length).sort()).toEqual([1, 2]);
  } finally { audit.mockRestore(); }
  expect(await service.runMaintenance()).toMatchObject({ generated: 1, failed: 0 });
  expect(setup.charges).toHaveLength(1);
});

test('stopping monthly maintenance waits for its active transaction before closing storage', async () => {
  let finish;
  jest.spyOn(service, 'runMaintenance').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const stop = service.startMaintenance(); let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish({ generated: 0, failed: 0 }); await stopping;
  expect(stopped).toBe(true);
});

test('a billing start later this month does not charge or warn before that calendar date', async () => {
  const saved = await post('profile', profile(0, { billingStart: '2026-10-20' }));
  expect(saved.charges).toEqual([]); expect(saved.pendingMonthlyCharges).toBe(0);
  expect(await service.runMaintenance()).toMatchObject({ generated: 0, failed: 0 });
  setTime('2026-10-20T18:00:00Z');
  expect(await service.runMaintenance()).toMatchObject({ generated: 1, failed: 0 });
  expect((await db.getChildBillingRecord(child.id)).data.charges).toHaveLength(1);
});

test.each(['', '/enrollment'])('ending enrollment through the %s route pauses billing and reactivation cannot bill the inactive gap', async route => {
  await post('profile', profile());
  const closed = await api.put('/api/children/' + child.id + route).send({ active: false });
  expect(closed.status).toBe(200);
  expect(JSON.stringify(closed.body)).not.toMatch(/familyCents|ccrcCents|billingStart/);
  let row = await db.getChildBillingRecord(child.id);
  expect(row).toMatchObject({ version: 2, data: { profile: { enabled: false, pausedForEnrollment: true, pausedOn: '2026-10-06' } } });
  expect(row.data.history.at(-1)).toMatchObject({ type: 'enrollment_billing_pause', actorId: fixture.credentials().account.id });
  setTime('2026-12-06T18:00:00Z');
  await db.updateSession(auth.digest(token()), { createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.absoluteMs) });
  expect((await api.put('/api/children/' + child.id + route).send({ active: true })).status).toBe(200);
  expect(await service.runMaintenance()).toMatchObject({ generated: 0, failed: 0 });
  expect((await detail()).pendingMonthlyCharges).toBe(0);
  row = await db.getChildBillingRecord(child.id);
  expect(row.data.charges.map(charge => charge.month)).toEqual(['2026-10']);
  await post('profile', profile(row.version), 400);
  const resumed = await post('profile', profile(row.version, { billingStart: '2026-12-01', effectiveMonth: '2026-12' }));
  expect(resumed.profile).toMatchObject({ enabled: true, pausedForEnrollment: false });
  expect(resumed.charges.map(charge => charge.month)).toEqual(['2026-10', '2026-12']);
  expect(resumed.charges.filter(charge => charge.kind === 'registration')).toHaveLength(0);
});

test('a failed enrollment pause audit rolls back both the child status and financial record', async () => {
  await post('profile', profile());
  const before = await db.getChildBillingRecord(child.id), append = db.appendAudit;
  const audit = jest.spyOn(db, 'appendAudit').mockImplementation(row => row.action === 'billing.enrollment_pause' ? Promise.reject(new Error('Synthetic enrollment pause audit failure')) : append(row));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await api.put('/api/children/' + child.id + '/enrollment').send({ active: false });
    expect(response.status).toBe(500);
  } finally { audit.mockRestore(); logging.mockRestore(); }
  expect((await db.getChildById(child.id)).active).toBe(true);
  expect(await db.getChildBillingRecord(child.id)).toEqual(before);
});

test('profile corrections retain attributed before and after settings without duplicating rate arrays', async () => {
  const initial = await post('profile', profile());
  const saved = await post('profile', profile(initial.version, { enabled: false, billingEnd: '2026-10-20', registrationCents: 15000, reason: 'Corrected enrollment billing agreement' }));
  const event = saved.history.filter(row => row.type === 'profile').at(-1);
  expect(event).toMatchObject({ actorId: fixture.credentials().account.id, actorName: 'Test Administrator', reason: 'Corrected enrollment billing agreement',
    before: { enabled: true, billingEnd: null, registrationCents: 20000 }, after: { enabled: false, billingEnd: '2026-10-20', registrationCents: 15000 } });
  expect(event.before).not.toHaveProperty('rates'); expect(event.after).not.toHaveProperty('rates');
  expect(saved.profile.rates).toHaveLength(2);
});
