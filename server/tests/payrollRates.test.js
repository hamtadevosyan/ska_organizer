const { randomUUID, randomBytes } = require('node:crypto');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const service = require('../services/payrollService');
const vault = require('../services/payrollVault');
const fixture = require('./helpers/authenticatedRequest');

const HOUR = 3600000;
const date = '2026-10-19';
const period = { start: date, end: date };
const rules = { mode: 'ca-standard', workweekStart: 1, confirmed: true,
  reference: 'Synthetic administrator selects each additional rate explicitly', dailyScheduledMinutes: 540 };
let key;
let previousZone;
beforeAll(() => {
  key = require('./helpers/payrollKey').install();
  previousZone = process.env.FACILITY_TIME_ZONE;
  process.env.FACILITY_TIME_ZONE = 'America/Los_Angeles';
});
afterAll(() => {
  key.cleanup();
  if (previousZone === undefined) delete process.env.FACILITY_TIME_ZONE;
  else process.env.FACILITY_TIME_ZONE = previousZone;
});
afterEach(() => jest.useRealTimers());
function freeze(instant) {
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'] });
  jest.setSystemTime(new Date(instant));
}
async function setup({ cents = 2000 } = {}) {
  freeze('2026-10-19T14:00:00Z');
  const person = await db.createStaff({ id: randomUUID(), name: 'Synthetic explicitly rated employee',
    role: 'Teacher', active: true, roomId: null, version: 1 });
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: fixture.credentials().account.id,
    remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 30 * 86400000) });
  await service.profile(token, person.id, { version: 0, reason: 'Synthetic reviewed pay setup', rules });
  await service.rate(token, person.id, { version: 1, effectiveOn: '2026-01-01', cents,
    currency: 'USD', reason: 'Synthetic effective hourly rate' });
  await service.schedule(token, person.id, { version: 0, effectiveOn: date, startTime: '08:00',
    endTime: '17:00', reason: 'Approved daily work window' });
  return { person, token };
}
async function clock(context, action, instant) {
  jest.setSystemTime(new Date(instant));
  const own = (await service.clockStatus(context.token)).staff.find(row => row.id === context.person.id);
  await service.managerClock(context.token, context.person.id, { action, version: own.version, requestId: randomUUID() });
}
async function work(context, hours = 8.5) {
  await clock(context, 'checkin', date + 'T15:00:00Z');
  await clock(context, 'checkout', new Date(Date.parse(date + 'T15:00:00Z') + hours * HOUR).toISOString());
}
async function decision(context, changes = {}) {
  const detail = await service.get(context.token, context.person.id);
  const day = detail.ledger.days.find(row => row.date === date);
  return { version: detail.ledger.version, profileVersion: detail.profile.version, date, status: 'approved',
    mode: 'manual-reviewed', paidMillis: day.review.suggestedPaidMillis, rateMillis: HOUR,
    multiplierHundredths: 150, overtimeReviewed: true, rulesReviewed: true,
    reason: 'Administrator verified actual hours and deliberately selected this rate and duration', ...changes };
}
const preview = context => service.preview(context.token, context.person.id, period);

test.each([
  { title: 'regular rate', rateMillis: HOUR, multiplierHundredths: 100, grossCents: 18000 },
  { title: 'selected one-and-a-half rate', rateMillis: HOUR, multiplierHundredths: 150, grossCents: 19000 },
  { title: 'custom one-and-a-quarter rate', rateMillis: 3 * HOUR, multiplierHundredths: 125, grossCents: 19500 },
  { title: 'no hours at the selected higher rate', rateMillis: 0, multiplierHundredths: 150, grossCents: 18000 },
  { title: 'all approved hours at a custom rate', rateMillis: 9 * HOUR, multiplierHundredths: 125, grossCents: 22500 },
])('$title applies only to the explicitly allocated approved hours', async ({ rateMillis, multiplierHundredths, grossCents }) => {
  const context = await setup(); await work(context);
  const before = await service.get(context.token, context.person.id);
  const approval = await service.approve(context.token, context.person.id,
    await decision(context, { rateMillis, multiplierHundredths }));
  expect(approval).toMatchObject({ paidMillis: 9 * HOUR, rateMillis, multiplierHundredths, overtimeReviewed: true });
  expect(approval.rateFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(approval).not.toHaveProperty('premiumCents');
  expect((await service.get(context.token, context.person.id)).ledger.sessions).toEqual(before.ledger.sessions);
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents, approvedMillis: 9 * HOUR,
    rawMillis: 8.5 * HOUR, rows: [{ grossCents, approval: { rateMillis, multiplierHundredths } }] });
  const stored = vault.open(await db.getPayrollRecord('ledger:' + context.person.id)).approvals[date];
  expect(stored).toEqual(approval);
  expect(stored).not.toHaveProperty('premiumCents');
});

test('the combined regular and explicitly rated portions round once per day rather than once per portion', async () => {
  const context = await setup({ cents: 101 }); await work(context, 1);
  await service.approve(context.token, context.person.id, await decision(context,
    { rateMillis: HOUR / 2, multiplierHundredths: 150 }));
  // 50.5 + 75.75 cents = 126.25 cents; separately rounding the portions would incorrectly pay 127 cents.
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 126, approvedMillis: HOUR });
});

test('missing, mixed, malformed and out-of-range rate choices never change approval state or create an approval audit', async () => {
  const context = await setup(); await work(context);
  const body = await decision(context);
  const { multiplierHundredths, ...missingMultiplier } = body;
  const { rateMillis, ...missingDuration } = body;
  const invalid = [missingMultiplier, missingDuration,
    ...[
      { rateMillis: -1 }, { rateMillis: body.paidMillis + 1 }, { rateMillis: .5 },
      { rateMillis: '3600000' }, { rateMillis: null },
      { multiplierHundredths: 99 }, { multiplierHundredths: 1001 },
      { multiplierHundredths: 125.5 }, { multiplierHundredths: '150' }, { multiplierHundredths: null },
      { premiumCents: 0 }, { premiumCents: 100 }, { overtimeReviewed: false }, { rulesReviewed: false }, { reason: ' ' },
    ].map(changes => ({ ...body, ...changes })),
  ];
  const original = await db.getPayrollRecord('ledger:' + context.person.id);
  const audits = await db.listAudit({ actions: ['payroll.daily_approved'] });
  for (const payload of invalid) {
    await expect(service.approve(context.token, context.person.id, payload)).rejects.toMatchObject({ status: 400 });
    expect(await db.getPayrollRecord(original.id)).toEqual(original);
  }
  expect(await db.listAudit({ actions: ['payroll.daily_approved'] })).toEqual(audits);
});

test('an overtime threshold never selects a multiplier or bypasses an administrator reason and review', async () => {
  const context = await setup(); await work(context, 9);
  const body = await decision(context, { rateMillis: HOUR, multiplierHundredths: 100 });
  await expect(service.approve(context.token, context.person.id, { ...body, overtimeReviewed: false })).rejects.toMatchObject({ status: 400 });
  await expect(service.approve(context.token, context.person.id, { ...body, reason: '' })).rejects.toMatchObject({ status: 400 });
  await service.approve(context.token, context.person.id, body);
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 18000 });
});

test('the existing explicit additional-pay decision retains its original calculation and snapshot', async () => {
  const context = await setup(); await work(context);
  const { rateMillis, multiplierHundredths, ...body } = await decision(context);
  const legacy = await service.approve(context.token, context.person.id, { ...body, premiumCents: 1250 });
  expect(legacy).toMatchObject({ premiumCents: 1250, paidMillis: 9 * HOUR });
  expect(legacy).not.toHaveProperty('rateMillis');
  const first = await preview(context);
  expect(first).toMatchObject({ canFinalize: true, grossCents: 19250 });
  const saved = await service.finalize(context.token, context.person.id,
    { ...period, fingerprint: first.fingerprint, requestId: randomUUID() });
  const snapshotRow = await db.getPayrollRecord(saved.id);
  const replacement = await decision(context);
  const before = await db.getPayrollRecord('ledger:' + context.person.id);
  await expect(service.approve(context.token, context.person.id, replacement)).rejects.toMatchObject({
    status: 409, code: 'LEGACY_PAY_REPLACEMENT_REQUIRED',
  });
  expect(await db.getPayrollRecord(before.id)).toEqual(before);
  const approval = await service.approve(context.token, context.person.id, { ...replacement, replaceLegacyPremium: true });
  expect(approval).toMatchObject({ rateMillis: HOUR, multiplierHundredths: 150, replacedLegacyPremiumCents: 1250 });
  expect((await service.get(context.token, context.person.id)).ledger.history.at(-1)).toMatchObject({
    type: 'approval', before: { premiumCents: 1250 }, after: { rateMillis: HOUR, replacedLegacyPremiumCents: 1250 },
  });
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 19000 });
  expect(await db.getPayrollRecord(saved.id)).toEqual(snapshotRow);
  expect(await service.snapshot(context.token, context.person.id, saved.id)).toMatchObject({ sourceChanged: true,
    preview: { grossCents: 19250, rows: [{ approval: { premiumCents: 1250 } }] } });
});

test('corrected rates and payroll rules invalidate current rate allocations while leaving the saved snapshot immutable', async () => {
  const context = await setup(); await work(context);
  await service.approve(context.token, context.person.id, await decision(context));
  const first = await preview(context);
  const saved = await service.finalize(context.token, context.person.id,
    { ...period, fingerprint: first.fingerprint, requestId: randomUUID() });
  const snapshotRow = await db.getPayrollRecord(saved.id);
  let detail = await service.get(context.token, context.person.id);
  const firstFingerprint = detail.ledger.days[0].approval.rateFingerprint;
  await service.rate(context.token, context.person.id, { version: detail.profile.version, effectiveOn: date,
    cents: 2200, currency: 'USD', reason: 'Verified effective hourly rate correction' });
  let changed = await preview(context);
  expect(changed.canFinalize).toBe(false);
  expect(changed.blockers.join(' ')).toMatch(/rate|review/i);
  expect((await service.get(context.token, context.person.id)).ledger.days[0].approval.rateFingerprint).toBe(firstFingerprint);
  await service.approve(context.token, context.person.id, await decision(context));
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 20900 });
  detail = await service.get(context.token, context.person.id);
  expect(detail.ledger.days[0].approval.rateFingerprint).not.toBe(firstFingerprint);
  await service.profile(context.token, context.person.id, { version: detail.profile.version,
    reason: 'Administrator changed the reviewed pay policy', rules: { ...rules, reference: 'Synthetic newly verified pay policy' } });
  changed = await preview(context);
  expect(changed.canFinalize).toBe(false);
  expect(changed.blockers.join(' ')).toMatch(/policy|rule|review/i);
  await service.approve(context.token, context.person.id, await decision(context));
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 20900 });
  expect(await db.getPayrollRecord(saved.id)).toEqual(snapshotRow);
  expect(await service.snapshot(context.token, context.person.id, saved.id)).toMatchObject({ sourceChanged: true,
    preview: { grossCents: 19000, rows: [{ approval: { rateMillis: HOUR, multiplierHundredths: 150 } }] } });
});

test('a same-duration timestamp correction cannot reuse a previously reviewed rate allocation, even with a restored approved status', async () => {
  const context = await setup(); await work(context);
  await service.approve(context.token, context.person.id, await decision(context));
  let detail = await service.get(context.token, context.person.id);
  const original = structuredClone(detail.ledger.sessions[0]);
  const fingerprint = detail.ledger.days[0].approval.rateFingerprint;
  jest.setSystemTime(new Date('2026-10-20T02:00:00Z'));
  await service.correct(context.token, context.person.id, { version: detail.ledger.version, sessionId: original.id,
    start: new Date(Date.parse(original.start) + 60000).toISOString(),
    end: new Date(Date.parse(original.end) + 60000).toISOString(), voided: false,
    reason: 'Verified both timestamps were one minute later; the duration is unchanged' });
  expect((await preview(context)).canFinalize).toBe(false);
  // Restoring an older approval status must not make the stale allocation current.
  const row = await db.getPayrollRecord('ledger:' + context.person.id), ledger = vault.open(row);
  ledger.approvals[date].status = 'approved';
  await db.savePayrollRecord({ ...row, ciphertext: vault.seal(row, ledger) });
  const changed = await preview(context);
  expect(changed.canFinalize).toBe(false);
  expect(changed.blockers.join(' ')).toMatch(/record|clock|rate|review/i);
  detail = await service.get(context.token, context.person.id);
  expect(detail.ledger.days[0].paidMillis).toBe(8.5 * HOUR);
  expect(detail.ledger.days[0].approval.rateFingerprint).toBe(fingerprint);
  expect(detail.ledger.sessions[0].original).toEqual(original.original);
  await service.approve(context.token, context.person.id, await decision(context));
  expect((await service.get(context.token, context.person.id)).ledger.days[0].approval.rateFingerprint).not.toBe(fingerprint);
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 19000 });
});

test('a failed rate-approval audit restores the prior allocation, version and approval history atomically', async () => {
  const context = await setup(); await work(context);
  await service.approve(context.token, context.person.id, await decision(context,
    { rateMillis: HOUR, multiplierHundredths: 100 }));
  const body = await decision(context, { rateMillis: 2 * HOUR, multiplierHundredths: 125 });
  const original = await db.getPayrollRecord('ledger:' + context.person.id);
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic rate-allocation audit failure'));
  try {
    await expect(service.approve(context.token, context.person.id, body)).rejects.toThrow('Synthetic rate-allocation audit failure');
  } finally { audit.mockRestore(); }
  expect(await db.getPayrollRecord(original.id)).toEqual(original);
  expect(await preview(context)).toMatchObject({ canFinalize: true, grossCents: 18000 });
});

test('work-time sessions are chronological, retain actual and original timestamps, and clip only their daily projection', async () => {
  const context = await setup();
  await clock(context, 'checkin', '2026-10-19T15:00:00Z');
  await clock(context, 'checkout', '2026-10-19T16:00:00Z');
  await clock(context, 'checkin', '2026-10-19T18:00:00Z');
  await clock(context, 'checkout', '2026-10-19T19:00:00Z');
  await clock(context, 'checkin', '2026-10-20T06:00:00Z');
  await clock(context, 'checkout', '2026-10-20T09:00:00Z');
  let detail = await service.get(context.token, context.person.id);
  const early = detail.ledger.sessions.find(session => session.start === '2026-10-19T15:00:00.000Z');
  await service.correct(context.token, context.person.id, { version: detail.ledger.version, sessionId: early.id,
    start: '2026-10-19T15:15:00.000Z', end: '2026-10-19T16:15:00.000Z', voided: false,
    reason: 'Verified actual morning arrival and departure' });
  await clock(context, 'checkin', '2026-10-20T11:00:00Z');
  jest.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  // Restored ledgers need not have retained insertion order. Projection order
  // follows timestamps while the source clock records remain untouched.
  const raw = await db.getPayrollRecord('ledger:' + context.person.id), ledger = vault.open(raw);
  ledger.sessions.reverse();
  await db.savePayrollRecord({ ...raw, ciphertext: vault.seal(raw, ledger) });
  const items = (await service.workTime(context.token, { start: date, end: '2026-10-20' })).items;
  const first = items.find(row => row.date === date), second = items.find(row => row.date === '2026-10-20');
  expect(first.sessions.map(session => session.start)).toEqual([
    '2026-10-19T15:15:00.000Z', '2026-10-19T18:00:00.000Z', '2026-10-20T06:00:00.000Z',
  ]);
  expect(first.sessions[0]).toMatchObject({ id: early.id, start: '2026-10-19T15:15:00.000Z',
    end: '2026-10-19T16:15:00.000Z', dayStart: '2026-10-19T15:15:00.000Z', dayEnd: '2026-10-19T16:15:00.000Z',
    originalStart: '2026-10-19T15:00:00.000Z', originalEnd: '2026-10-19T16:00:00.000Z' });
  expect(first.sessions.at(-1)).toMatchObject({ start: '2026-10-20T06:00:00.000Z', end: '2026-10-20T09:00:00.000Z',
    dayStart: '2026-10-20T06:00:00.000Z', dayEnd: '2026-10-20T07:00:00.000Z',
    originalStart: '2026-10-20T06:00:00.000Z', originalEnd: '2026-10-20T09:00:00.000Z' });
  expect(second.sessions.map(session => session.start)).toEqual(['2026-10-20T06:00:00.000Z', '2026-10-20T11:00:00.000Z']);
  expect(second.sessions[0]).toMatchObject({ start: '2026-10-20T06:00:00.000Z', end: '2026-10-20T09:00:00.000Z',
    dayStart: '2026-10-20T07:00:00.000Z', dayEnd: '2026-10-20T09:00:00.000Z' });
  expect(second.sessions[1]).toMatchObject({ start: '2026-10-20T11:00:00.000Z', end: null,
    dayStart: '2026-10-20T11:00:00.000Z', dayEnd: null, originalStart: '2026-10-20T11:00:00.000Z', originalEnd: null });
  detail = await service.get(context.token, context.person.id);
  expect(detail.ledger.days.find(row => row.date === date).review.workTime.sessions).toEqual(first.sessions);
  expect(detail.ledger.days.find(row => row.date === '2026-10-20').review.workTime.sessions).toEqual(second.sessions);
});

test('an open overnight session clips the historical day while keeping the current checkout visibly missing', async () => {
  const context = await setup();
  await clock(context, 'checkin', '2026-10-20T06:00:00Z');
  jest.setSystemTime(new Date('2026-10-20T09:00:00Z'));
  const original = await db.getPayrollRecord('ledger:' + context.person.id);
  const items = (await service.workTime(context.token, { start: date, end: '2026-10-20' })).items;
  const historical = items.find(row => row.date === date), current = items.find(row => row.date === '2026-10-20');
  expect(historical).toMatchObject({ rawMillis: HOUR, incomplete: true, sessions: [{
    start: '2026-10-20T06:00:00.000Z', end: null,
    dayStart: '2026-10-20T06:00:00.000Z', dayEnd: '2026-10-20T07:00:00.000Z', dayMillis: HOUR,
    originalStart: '2026-10-20T06:00:00.000Z', originalEnd: null,
  }] });
  expect(current).toMatchObject({ rawMillis: 2 * HOUR, incomplete: true, sessions: [{
    start: '2026-10-20T06:00:00.000Z', end: null,
    dayStart: '2026-10-20T07:00:00.000Z', dayEnd: null, dayMillis: 2 * HOUR,
    originalStart: '2026-10-20T06:00:00.000Z', originalEnd: null,
  }] });
  const detail = await service.get(context.token, context.person.id);
  expect(detail.ledger.days.map(day => ({ date: day.date, rawMillis: day.rawMillis, incomplete: day.incomplete }))).toEqual([
    { date, rawMillis: HOUR, incomplete: true },
    { date: '2026-10-20', rawMillis: 2 * HOUR, incomplete: true },
  ]);
  expect(detail.ledger.days[0].review.workTime.sessions).toEqual(historical.sessions);
  expect(detail.ledger.days[1].review.workTime.sessions).toEqual(current.sessions);
  expect(await db.getPayrollRecord(original.id)).toEqual(original);
});
