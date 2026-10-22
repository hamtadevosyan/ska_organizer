const { randomUUID, randomBytes } = require('node:crypto');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const service = require('../services/payrollService');
const fixture = require('./helpers/authenticatedRequest');
const http = require('supertest');
const app = require('../index');
let key;
beforeAll(() => { key = require('./helpers/payrollKey').install(); });
afterAll(() => key.cleanup());
afterEach(() => jest.useRealTimers());
const rules = { mode: 'ca-standard', workweekStart: 1, confirmed: true, reference: 'Synthetic reviewed policy', dailyScheduledMinutes: 480 };
const HOUR = 3600000;
function freeze(at = '2026-10-19T15:00:00Z') {
  jest.useFakeTimers({ doNotFake: ['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','nextTick','queueMicrotask','performance','hrtime'] });
  jest.setSystemTime(new Date(at));
}
async function token(account) {
  const value = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(value), accountId: account.id, remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 30 * 86400000) });
  return value;
}
async function actor(role, person) {
  return token(await db.createAccount({ id: randomUUID(), username: 'review-' + randomUUID(), displayName: 'Synthetic review actor', role, staffMemberId: person?.id || null, disabled: false, mustChangePassword: false, passwordHash: 'not used', roomId: null }));
}
async function clock(value, action) {
  const own = await service.own(value);
  await service.clock(value, { action, version: own.version, requestId: randomUUID() });
}
async function setup({ hours = 3, rate = true, policy = true, schedule, arrival = '2026-10-19T15:00:00Z' } = {}) {
  freeze(arrival);
  const person = await db.createStaff({ id: randomUUID(), name: 'Synthetic review employee', role: 'Teacher', active: true, roomId: null, version: 1 });
  const admin = await token(fixture.credentials().account), teacher = await actor('teacher', person);
  if (policy) await service.profile(admin, person.id, { version: 0, reason: 'Synthetic setup', rules });
  if (rate) await service.rate(admin, person.id, { version: policy ? 1 : 0, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic hourly rate' });
  if (schedule) await service.schedule(admin, person.id, { version: 0, effectiveOn: '2026-10-19', reason: 'Synthetic approved window', ...schedule });
  await clock(teacher, 'checkin');
  if (hours !== null) { jest.setSystemTime(new Date(Date.now() + hours * HOUR)); await clock(teacher, 'checkout'); }
  return { person, admin, teacher };
}
async function approve(admin, id, values = {}) {
  const detail = await service.get(admin, id), day = detail.ledger.days[0];
  await service.approve(admin, id, { version: detail.ledger.version, date: day.date, status: 'approved', regularMillis: day.paidMillis, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, rulesReviewed: true, reason: 'Synthetic verified approval', ...values });
}
const row = async ({ admin, person }) => (await service.get(admin, person.id)).ledger.days[0];

test('an ordinary unapproved day says awaiting approval without inventing a time issue', async () => {
  const context = await setup(), day = await row(context);
  expect(day.review).toMatchObject({ state: 'awaiting-approval', canApproveRecorded: true, reasons: [{ code: 'APPROVAL_REQUIRED', message: 'Recorded time has not been approved yet.', action: 'approve' }] });
  expect(day.review.workTime).toMatchObject({ checkin: '2026-10-19T15:00:00.000Z', checkout: '2026-10-19T18:00:00.000Z', timeZone: 'America/Los_Angeles', status: 'within-schedule' });
  expect(day.paidMillis).toBe(3 * HOUR);
  await approve(context.admin, context.person.id);
  expect((await row(context)).review).toMatchObject({ state: 'approved', reasons: [] });
});
test('missing checkout and missing employee setup explain their exact next steps', async () => {
  const context = await setup({ hours: null, rate: false, policy: false }), day = await row(context);
  expect(day.review.state).toBe('needs-attention'); expect(day.review.canApproveRecorded).toBe(false);
  expect(day.review.reasons).toEqual(expect.arrayContaining([
    { code: 'MISSING_CHECKOUT', message: expect.stringContaining('actual departure'), action: 'time' },
    { code: 'RATE_MISSING', message: expect.stringContaining('on or before this day'), action: 'rates' },
    { code: 'POLICY_UNCONFIRMED', message: expect.stringContaining('not been reviewed'), action: 'profile' },
  ]));
  expect(JSON.stringify(day.review)).not.toMatch(/break/i);
});
test('a short day outside approved start/end times explains both its cause and operational review', async () => {
  const context = await setup({ schedule: { startTime: '09:00', endTime: '17:00' } }), day = await row(context);
  expect(day.review).toMatchObject({ state: 'needs-attention', canApproveRecorded: false, workTime: { plannedStart: '09:00', plannedEnd: '17:00', earlyMillis: HOUR, outsideMillis: HOUR, status: 'pending' } });
  expect(day.review.reasons).toContainEqual({ code: 'OUTSIDE_SCHEDULE', action: 'work-time', message: expect.stringMatching(/1 hr before the approved start.*9:00 AM–5:00 PM/) });
  const work = (await service.workTime(context.admin)).items[0];
  await service.reviewWork(context.admin, context.person.id, { version: work.version, date: work.date, decision: 'worked', reason: 'Verified early work' });
  const reviewed = await row(context);
  expect(reviewed.review.state).toBe('awaiting-approval');
  expect(reviewed.review.canApproveRecorded).toBe(true);
  expect(reviewed.review.workTime).toMatchObject({ status: 'confirmed', checkin: day.review.workTime.checkin, checkout: day.review.workTime.checkout });
  expect(reviewed.paidMillis).toBe(day.paidMillis);
});
test('a changed clock record and returned decision retain explicit reasons for reapproval', async () => {
  const context = await setup(); await approve(context.admin, context.person.id);
  const detail = await service.get(context.admin, context.person.id), session = detail.ledger.sessions[0];
  await service.correct(context.admin, context.person.id, { version: detail.ledger.version, sessionId: session.id, start: session.start, end: '2026-10-19T17:00:00Z', voided: false, reason: 'Verified incorrect departure' });
  let day = await row(context);
  expect(day.review.reasons).toContainEqual({ code: 'CLOCK_CHANGED', message: expect.stringContaining('Clock records changed after approval'), action: 'time' });
  await approve(context.admin, context.person.id, { status: 'returned', reason: 'Verify departure with the manager' });
  day = await row(context);
  expect(day.review.reasons).toContainEqual({ code: 'APPROVAL_RETURNED', message: 'Returned for correction: Verify departure with the manager', action: 'time' });
});
test('a changed payroll policy uses the same stale-approval explanation as calculation', async () => {
  const context = await setup(); await approve(context.admin, context.person.id);
  let detail = await service.get(context.admin, context.person.id);
  await service.profile(context.admin, context.person.id, { version: detail.profile.version, reason: 'Synthetic policy update', rules: { ...rules, reference: 'Changed verified policy reference' } });
  const day = await row(context), preview = await service.preview(context.admin, context.person.id, { start: day.date, end: day.date });
  const issue = preview.rows[0].issues.find(message => message.includes('policy changed'));
  expect(day.review).toMatchObject({ state: 'needs-attention', canApproveRecorded: false });
  expect(day.review.reasons).toContainEqual({ code: 'POLICY_CHANGED', message: issue, action: 'time' });
  expect(day.review.reasons).toContainEqual({ code: 'WORKWEEK_APPROVALS', date: day.date, action: 'time', message: expect.stringContaining(day.date + ' (payroll policy changed)') });
});
test('daily overtime is visible before allocation and a valid approved allocation stays approved', async () => {
  const context = await setup({ hours: 9 });
  let day = await row(context);
  expect(day.review.reasons).toContainEqual({ code: 'DAILY_OVERTIME', message: expect.stringContaining('9 hr'), action: 'time' });
  const work = (await service.workTime(context.admin)).items[0];
  await service.reviewWork(context.admin, context.person.id, { version: work.version, date: work.date, decision: 'worked', reason: 'Verified all recorded work' });
  await approve(context.admin, context.person.id, { regularMillis: 8 * HOUR, overtimeMillis: HOUR, adjustmentCents: 100 });
  day = await row(context);
  expect(day.review).toMatchObject({ state: 'approved', reasons: [], canApproveRecorded: false });
});
test('an approved day points to the actual unapproved and incomplete workweek dates', async () => {
  const context = await setup(); await approve(context.admin, context.person.id);
  jest.setSystemTime(new Date('2026-10-20T15:00:00Z')); await clock(context.teacher, 'checkin');
  jest.setSystemTime(new Date('2026-10-20T17:00:00Z')); await clock(context.teacher, 'checkout');
  jest.setSystemTime(new Date('2026-10-21T15:00:00Z')); await clock(context.teacher, 'checkin');
  const days = (await service.get(context.admin, context.person.id)).ledger.days, day = days[0];
  expect(day.date).toBe('2026-10-19'); expect(day.approval.status).toBe('approved');
  expect(day.review.reasons).toContainEqual({
    code: 'WORKWEEK_APPROVALS', action: 'time', date: '2026-10-20',
    message: 'Recorded days in this workweek still need review: 2026-10-20 (not approved), 2026-10-21 (missing checkout). Review those dates before calculating.',
  });
  expect(day.review.reasons.find(reason => reason.code === 'WORKWEEK_APPROVALS').message).not.toContain('2026-10-19');
  expect(days[1].approval).toBeNull();
  expect(days[1].review.reasons).toContainEqual({
    code: 'WORKWEEK_CHECKOUT', action: 'time', date: '2026-10-21',
    message: 'Checkout is missing on these workweek dates: 2026-10-21. Record the actual departures before reviewing overtime.',
  });
});
test('weekly and seventh-day review causes are visible even when the selected day has a short shift', async () => {
  const context = await setup({ hours: 1 });
  for (let date = 20; date <= 25; date++) {
    jest.setSystemTime(new Date(`2026-10-${date}T15:00:00Z`));
    await clock(context.teacher, 'checkin');
    jest.setSystemTime(new Date(Date.now() + 8 * HOUR));
    await clock(context.teacher, 'checkout');
  }
  const day = await row(context);
  expect(day.paidMillis).toBe(HOUR);
  expect(day.review).toMatchObject({ state: 'needs-attention', canApproveRecorded: false });
  expect(day.review.reasons).toEqual(expect.arrayContaining([
    { code: 'WEEKLY_OVERTIME', message: expect.stringContaining('49 hr'), action: 'time' },
    { code: 'SEVENTH_DAY', message: expect.stringContaining('all seven days'), action: 'time' },
  ]));
});
test.each(['editor', 'viewer', 'teacher'])('%s cannot read private per-day payroll explanations', async role => {
  const context = await setup(), value = await actor(role);
  const response = await http(app).get('/api/payroll/staff/' + context.person.id).set('Cookie', 'skao_session=' + value).set('Origin', fixture.origin);
  expect(response.status).toBe(403);
  expect(JSON.stringify(response.body)).not.toMatch(/review\.reasons|checkin|hourly|2000/);
});
