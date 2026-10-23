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
async function clock(value, staffId, action) {
  const own = (await service.clockStatus(value)).staff.find(row => row.id === staffId);
  await service.managerClock(value, staffId, { action, version: own.version, requestId: randomUUID() });
}
async function setup({ hours = 3, rate = true, policy = true, schedule, arrival = '2026-10-19T15:00:00Z' } = {}) {
  freeze(arrival);
  const person = await db.createStaff({ id: randomUUID(), name: 'Synthetic review employee', role: 'Teacher', active: true, roomId: null, version: 1 });
  const admin = await token(fixture.credentials().account), teacher = await actor('teacher', person);
  if (policy) await service.profile(admin, person.id, { version: 0, reason: 'Synthetic setup', rules });
  if (rate) await service.rate(admin, person.id, { version: policy ? 1 : 0, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic hourly rate' });
  if (schedule) await service.schedule(admin, person.id, { version: 0, effectiveOn: '2026-10-19', reason: 'Synthetic approved window', ...schedule });
  await clock(admin, person.id, 'checkin');
  if (hours !== null) { jest.setSystemTime(new Date(Date.now() + hours * HOUR)); await clock(admin, person.id, 'checkout'); }
  return { person, admin, teacher };
}
async function approve(admin, id, values = {}) {
  const detail = await service.get(admin, id), day = detail.ledger.days[0];
  await service.approve(admin, id, { version: detail.ledger.version, profileVersion: detail.profile.version, date: day.date, status: 'approved', mode: 'manual-reviewed', paidMillis: day.paidMillis, premiumCents: 0, overtimeReviewed: true, adjustmentCents: 0, rulesReviewed: true, reason: 'Synthetic verified administrator additional-pay review', ...values });
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
  expect(reviewed.review.state).toBe('needs-attention');
  expect(reviewed.review.canApproveRecorded).toBe(false);
  expect(reviewed.review.requiresOvertimeReview).toBe(true);
  expect(reviewed.review.reasons).toContainEqual(expect.objectContaining({code:'OVERTIME_REVIEW'}));
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
});
test('daily overtime is visible before allocation and a valid approved allocation stays approved', async () => {
  const context = await setup({ hours: 9 });
  let day = await row(context);
  expect(day.review.reasons).toContainEqual({ code: 'OVERTIME_REVIEW', message: expect.stringContaining('9 hr'), action: 'time' });
  const work = (await service.workTime(context.admin)).items[0];
  await service.reviewWork(context.admin, context.person.id, { version: work.version, date: work.date, decision: 'worked', reason: 'Verified all recorded work' });
  await approve(context.admin, context.person.id, { paidMillis: 9 * HOUR, premiumCents: 100 });
  day = await row(context);
  expect(day.review).toMatchObject({ state: 'approved', reasons: [], canApproveRecorded: false });
});
test('later unapproved or unfinished workdays do not reopen an earlier ordinary approval', async () => {
  const context = await setup(); await approve(context.admin, context.person.id);
  jest.setSystemTime(new Date('2026-10-20T15:00:00Z')); await clock(context.admin, context.person.id, 'checkin');
  jest.setSystemTime(new Date('2026-10-20T17:00:00Z')); await clock(context.admin, context.person.id, 'checkout');
  jest.setSystemTime(new Date('2026-10-21T15:00:00Z')); await clock(context.admin, context.person.id, 'checkin');
  const days = (await service.get(context.admin, context.person.id)).ledger.days;
  expect(days[0].date).toBe('2026-10-19');
  expect(days[0].review).toMatchObject({ state: 'approved', reasons: [] });
  expect(days[1].review).toMatchObject({ state: 'awaiting-approval' });
  expect(days[2].review.reasons).toEqual(expect.arrayContaining([expect.objectContaining({code:'MISSING_CHECKOUT'})]));
});
test('weekly and seventh-day review apply to the affected later workday without reopening earlier short work', async () => {
  const context = await setup({ hours: 1 });
  for (let date = 20; date <= 25; date++) {
    jest.setSystemTime(new Date(`2026-10-${date}T15:00:00Z`));
    await clock(context.admin, context.person.id, 'checkin');
    jest.setSystemTime(new Date(Date.now() + 8 * HOUR));
    await clock(context.admin, context.person.id, 'checkout');
  }
  const days = (await service.get(context.admin, context.person.id)).ledger.days;
  expect(days[0].review).toMatchObject({state:'awaiting-approval', requiresOvertimeReview:false});
  const day = days.at(-1);
  expect(day.review).toMatchObject({state:'needs-attention', canApproveRecorded:false, requiresOvertimeReview:true});
  expect(day.review.reasons).toContainEqual({code:'OVERTIME_REVIEW',message:expect.stringMatching(/49 hr.*seventh recorded workday/),action:'time'});
});
test.each(['editor', 'viewer', 'teacher'])('%s cannot read private per-day payroll explanations', async role => {
  const context = await setup(), value = await actor(role);
  const response = await http(app).get('/api/payroll/staff/' + context.person.id).set('Cookie', 'skao_session=' + value).set('Origin', fixture.origin);
  expect(response.status).toBe(403);
  expect(JSON.stringify(response.body)).not.toMatch(/review\.reasons|checkin|hourly|2000/);
});
