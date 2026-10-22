const { randomUUID, randomBytes } = require('node:crypto');
const http = require('supertest');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const service = require('../services/payrollService');
const vault = require('../services/payrollVault');
const fixture = require('./helpers/authenticatedRequest');
const app = require('../index');
const HOUR = 3600000;
const rules = { mode: 'ca-standard', workweekStart: 1, confirmed: true, reference: 'Synthetic administrator reviews every overtime amount manually', dailyScheduledMinutes: 480 };
let key;
beforeAll(() => { key = require('./helpers/payrollKey').install(); });
afterAll(() => key.cleanup());
afterEach(() => jest.useRealTimers());
function freeze(value) {
  jest.useFakeTimers({ doNotFake: ['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','nextTick','queueMicrotask','performance','hrtime'] });
  jest.setSystemTime(new Date(value));
}
async function token(account) {
  const value = randomBytes(32).toString('hex'), now = new Date();
  await db.createSession({ id: auth.digest(value), accountId: account.id, remembered: true, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 30 * 86400000) });
  return value;
}
async function actor(role, person) {
  const account = await db.createAccount({ id: randomUUID(), username: 'manual-pay-' + randomUUID(), displayName: 'Synthetic manual pay actor', role, staffMemberId: person?.id || null, disabled: false, mustChangePassword: false, passwordHash: 'not used', roomId: null });
  return { token: await token(account), account };
}
async function setup({ schedule = true } = {}) {
  freeze('2026-10-19T14:00:00Z');
  const person = await db.createStaff({ id: randomUUID(), name: 'Synthetic scheduled employee', role: 'Teacher', active: true, roomId: null, version: 1 });
  const admin = await token(fixture.credentials().account), teacher = await actor('teacher', person), editor = await actor('editor');
  await service.profile(admin, person.id, { version: 0, reason: 'Synthetic manually reviewed payroll setup', rules });
  await service.rate(admin, person.id, { version: 1, effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic hourly rate' });
  if (schedule) await service.schedule(admin, person.id, { version: 0, effectiveOn: '2026-10-19', startTime: '08:00', endTime: '17:00', reason: 'Approved nine-hour work window' });
  return { person, admin, teacher, editor };
}
async function clock(context, action) {
  const own = await service.own(context.teacher.token);
  await service.clock(context.teacher.token, { action, version: own.version, requestId: randomUUID() });
}
async function work(context, date, hours, arrival = '15:00:00Z') {
  jest.setSystemTime(new Date(date + 'T' + arrival));
  await clock(context, 'checkin');
  if (hours !== null) { jest.setSystemTime(new Date(Date.now() + hours * HOUR)); await clock(context, 'checkout'); }
}
async function decision(context, date, changes = {}) {
  const detail = await service.get(context.admin, context.person.id), day = detail.ledger.days.find(row => row.date === date);
  return { version: detail.ledger.version, profileVersion: detail.profile.version, date, status: 'approved', mode: 'manual-reviewed', paidMillis: day.review.suggestedPaidMillis, premiumCents: 0, overtimeReviewed: true, rulesReviewed: true, reason: 'Administrator verified actual work and entered the additional pay explicitly', ...changes };
}

test('nine-hour scheduled credit is separate from actual work and needs an explicit overtime decision', async () => {
  const context = await setup(); await work(context, '2026-10-19', 8.5);
  let detail = await service.get(context.admin, context.person.id), day = detail.ledger.days[0];
  expect(day).toMatchObject({ paidMillis: 8.5 * HOUR, review: { suggestedPaidMillis: 9 * HOUR, scheduledCreditMillis: .5 * HOUR, requiresOvertimeReview: true, shortDayCount: 1 } });
  expect(day.review.reasons).toContainEqual(expect.objectContaining({ code: 'OVERTIME_REVIEW' }));
  const original = structuredClone(detail.ledger.sessions), base = await decision(context, day.date);
  await expect(service.approve(context.admin, context.person.id, { ...base, overtimeReviewed: false })).rejects.toMatchObject({status:400});
  const { premiumCents, ...missingAmount } = base;
  await expect(service.approve(context.admin, context.person.id, missingAmount)).rejects.toMatchObject({status:400});
  await expect(service.approve(context.admin, context.person.id, { ...base, paidMillis: 8 * HOUR })).rejects.toMatchObject({status:400});
  await service.approve(context.admin, context.person.id, { ...base, premiumCents: 1250 });
  detail = await service.get(context.admin, context.person.id); day = detail.ledger.days[0];
  expect(day.approval).toMatchObject({ mode:'manual-reviewed', paidMillis:9*HOUR, premiumCents:1250, overtimeReviewed:true, overtimeMillis:0, doubleMillis:0, scheduledCreditMillis:.5*HOUR });
  expect(day.paidMillis).toBe(8.5*HOUR); expect(detail.ledger.sessions).toEqual(original);
  const preview = await service.preview(context.admin, context.person.id, {start:day.date,end:day.date});
  expect(preview).toMatchObject({grossCents:19250,approvedMillis:9*HOUR,canFinalize:true});
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(0);
});

test('a seven-hour approved window rounds the first short day silently and the second asks for review', async () => {
  const context = await setup();
  await service.schedule(context.admin, context.person.id, { version: 1, effectiveOn: '2026-10-19', startTime: '08:00', endTime: '15:00', reason: 'Approved seven-hour workday' });
  await work(context, '2026-10-19', 6.695);
  let detail = await service.get(context.admin, context.person.id), first = detail.ledger.days[0];
  const originalSessions = structuredClone(detail.ledger.sessions);
  expect(first).toMatchObject({ paidMillis: 6.695 * HOUR, review: { state: 'awaiting-approval', suggestedPaidMillis: 7 * HOUR, roundingCreditMillis: 18 * 60000 + 18000, scheduledCreditMillis: 18 * 60000 + 18000, requiresRoundingReview: false, shortDayOrdinal: 1, requiresOvertimeReview: false } });
  expect(first.review.reasons.map(reason => reason.code)).toEqual(['APPROVAL_REQUIRED']);
  expect(detail.shortDayWarnings).toEqual([]);
  await service.approve(context.admin, context.person.id, await decision(context, first.date, { overtimeReviewed: false }));
  detail = await service.get(context.admin, context.person.id);
  expect(detail.ledger.sessions).toEqual(originalSessions);
  const firstFingerprint = detail.ledger.days[0].approval.roundingFingerprint;
  expect(await service.preview(context.admin, context.person.id, { start: first.date, end: first.date })).toMatchObject({ canFinalize: true, grossCents: 14000, approvedMillis: 7 * HOUR, rawMillis: 6.695 * HOUR });

  await work(context, '2026-10-20', 6.75);
  detail = await service.get(context.admin, context.person.id);
  const second = detail.ledger.days[1];
  expect(second.review).toMatchObject({ state: 'needs-attention', suggestedPaidMillis: 7 * HOUR, requiresRoundingReview: true, shortDayOrdinal: 2 });
  expect(second.review.reasons).toContainEqual({ code: 'ROUNDING_REVIEW', action: 'approve', message: expect.stringMatching(/rounding from 6 hr 45 min to 7 hr paid time.*Short workdays have repeated this week/) });
  expect(detail.shortDayWarnings[0]).toMatchObject({ count: 2, dates: [first.date, second.date] });
  expect(detail.ledger.days[0].review).toMatchObject({ state: 'approved', requiresRoundingReview: false, shortDayOrdinal: 1 });
  expect(detail.ledger.days[0].approval.roundingFingerprint).toBe(firstFingerprint);
  await service.approve(context.admin, context.person.id, await decision(context, second.date, { overtimeReviewed: false }));
  expect((await service.get(context.admin, context.person.id)).ledger.days[1].review).toMatchObject({ state: 'approved', reasons: [] });

  await work(context, '2026-10-26', 6.695);
  detail = await service.get(context.admin, context.person.id);
  const nextWeek = detail.ledger.days.at(-1);
  expect(nextWeek.review).toMatchObject({ state: 'awaiting-approval', requiresRoundingReview: false, shortDayOrdinal: 1, suggestedPaidMillis: 7 * HOUR });
  expect(nextWeek.review.reasons.map(reason => reason.code)).toEqual(['APPROVAL_REQUIRED']);
  expect((await service.workTime(context.admin, { start: nextWeek.date, end: nextWeek.date })).shortDayWarnings).toEqual([]);
});

test('unscheduled fractional work proposes seven hours with a visible review warning and rejects the old fraction', async () => {
  const context = await setup({ schedule: false }); await work(context, '2026-10-19', 6.695);
  const before = await db.getPayrollRecord('ledger:' + context.person.id);
  const detail = await service.get(context.admin, context.person.id), day = detail.ledger.days[0];
  expect(day.review).toMatchObject({ state: 'needs-attention', suggestedPaidMillis: 7 * HOUR, roundingCreditMillis: 18 * 60000 + 18000, scheduledCreditMillis: 0, requiresRoundingReview: true });
  expect(day.review.reasons).toContainEqual({ code: 'ROUNDING_REVIEW', action: 'approve', message: expect.stringContaining('Review rounding from 6 hr 41 min 42 sec to 7 hr paid time.') });
  expect(await db.getPayrollRecord(before.id)).toEqual(before);
  await expect(service.approve(context.admin, context.person.id, await decision(context, day.date, { paidMillis: day.paidMillis, overtimeReviewed: false }))).rejects.toMatchObject({ status: 400 });
  expect(await db.getPayrollRecord(before.id)).toEqual(before);
  await service.approve(context.admin, context.person.id, await decision(context, day.date, { overtimeReviewed: false, adjustmentCents: 123 }));
  const after = await service.get(context.admin, context.person.id);
  expect(after.ledger.sessions).toEqual(detail.ledger.sessions);
  expect(after.ledger.days[0].approval).toMatchObject({ paidMillis: 7 * HOUR, roundingCreditMillis: 18 * 60000 + 18000, scheduledCreditMillis: 0, adjustmentCents: 123, roundingReviewed: true });
  expect(after.ledger.days[0].review).toMatchObject({ state: 'approved', reasons: [] });
  expect(await service.preview(context.admin, context.person.id, { start: day.date, end: day.date })).toMatchObject({ grossCents: 14123, canFinalize: true, rawMillis: 6.695 * HOUR });
});

test('an unfinished day has no rounded proposal and cannot be approved', async () => {
  const context = await setup(); await work(context, '2026-10-19', null);
  jest.setSystemTime(new Date('2026-10-19T21:41:42Z'));
  const day = (await service.get(context.admin, context.person.id)).ledger.days[0];
  expect(day).toMatchObject({ incomplete: true, paidMillis: 6.695 * HOUR, review: { suggestedPaidMillis: 6.695 * HOUR, roundingCreditMillis: 0, requiresRoundingReview: false } });
  expect(day.review.reasons.map(reason => reason.code)).not.toContain('ROUNDING_REVIEW');
  await expect(service.approve(context.admin, context.person.id, await decision(context, day.date))).rejects.toMatchObject({ status: 409 });
});

test('exact whole hours stay unchanged, while out-of-window fractions round up with required review and are never capped', async () => {
  const context = await setup(); await work(context, '2026-10-19', 8);
  let day = (await service.get(context.admin, context.person.id)).ledger.days[0];
  expect(day.review).toMatchObject({ suggestedPaidMillis:8*HOUR,scheduledCreditMillis:0,requiresOvertimeReview:false });
  await work(context, '2026-10-20', 8.5, '14:30:00Z');
  day = (await service.get(context.admin, context.person.id)).ledger.days[1];
  expect(day.review).toMatchObject({suggestedPaidMillis:9*HOUR,scheduledCreditMillis:0,roundingCreditMillis:.5*HOUR,requiresRoundingReview:true,requiresOvertimeReview:true,workTime:{earlyMillis:.5*HOUR}});
  expect(day.review.reasons).toContainEqual(expect.objectContaining({code:'ROUNDING_REVIEW'}));
  await work(context, '2026-10-21', 10);
  day = (await service.get(context.admin, context.person.id)).ledger.days[2];
  expect(day.review).toMatchObject({suggestedPaidMillis:10*HOUR,scheduledCreditMillis:0,requiresOvertimeReview:true});
});

test('the second completed short day warns only administrators and still counts days rounded up for pay', async () => {
  const context = await setup();
  await work(context,'2026-10-19',8.5);
  expect((await service.get(context.admin,context.person.id)).shortDayWarnings).toEqual([]);
  expect((await service.workTime(context.admin)).shortDayWarnings).toEqual([]);
  await work(context,'2026-10-20',8.75);
  expect((await service.get(context.admin,context.person.id)).shortDayWarnings[0]).toMatchObject({count:2,dates:['2026-10-19','2026-10-20']});
  await work(context,'2026-10-21',8.25);
  let detail=await service.get(context.admin,context.person.id);
  expect(detail.ledger.days.map(day=>day.review.suggestedPaidMillis)).toEqual([9*HOUR,9*HOUR,9*HOUR]);
  expect(detail.shortDayWarnings).toEqual([{staffId:context.person.id,name:context.person.name,weekStart:'2026-10-19',weekEnd:'2026-10-25',count:3,dates:['2026-10-19','2026-10-20','2026-10-21'],plannedMinutes:540}]);
  expect((await service.workTime(context.admin)).shortDayWarnings).toEqual(detail.shortDayWarnings);
  const editor=await service.workTime(context.editor.token);
  expect(editor).not.toHaveProperty('shortDayWarnings');expect(editor).not.toHaveProperty('overtimeReviewCount');
  await work(context,'2026-10-22',null);
  detail=await service.get(context.admin,context.person.id);expect(detail.shortDayWarnings[0].count).toBe(3);
  jest.setSystemTime(new Date('2026-10-22T23:00:00Z'));await clock(context,'checkout');
  await work(context,'2026-10-26',8.5);
  expect((await service.workTime(context.admin,{start:'2026-10-26',end:'2026-10-26'})).shortDayWarnings).toEqual([]);
});

test('an editor can verify outside work but cannot waive the administrator overtime review', async () => {
  const context=await setup();await work(context,'2026-10-19',3,'14:00:00Z');
  const before=(await service.get(context.admin,context.person.id)).ledger.sessions;
  let row=(await service.workTime(context.editor.token)).items[0];
  await service.reviewWork(context.editor.token,context.person.id,{version:row.version,date:row.date,decision:'worked',reason:'Editor verified the early work'});
  const detail=await service.get(context.admin,context.person.id);
  expect(detail.ledger.days[0].review).toMatchObject({requiresOvertimeReview:true,workTime:{status:'confirmed'}});
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(1);
  const body=await decision(context,row.date);
  const response=await http(app).post('/api/payroll/staff/'+context.person.id+'/approvals').set('Cookie','skao_session='+context.editor.token).set('Origin',fixture.origin).set('X-CSRF-Token',auth.csrfToken(context.editor.token)).send(body);
  expect(response.status).toBe(403);
  await expect(service.approve(context.admin,context.person.id,{...body,overtimeReviewed:false})).rejects.toMatchObject({status:400});
  await service.approve(context.admin,context.person.id,body);
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(0);
  expect((await service.get(context.admin,context.person.id)).ledger.sessions).toEqual(before);
  expect(await service.preview(context.admin,context.person.id,{start:row.date,end:row.date})).toMatchObject({grossCents:6000,canFinalize:true});
});

test('new legacy multiplier writes are rejected and a failed manual decision audit rolls everything back', async () => {
  const context=await setup();await work(context,'2026-10-19',8.5);
  const base=await decision(context,'2026-10-19');
  await expect(service.approve(context.admin,context.person.id,{version:base.version,date:base.date,status:'approved',regularMillis:8*HOUR,overtimeMillis:.5*HOUR,doubleMillis:0,adjustmentCents:0,rulesReviewed:true,reason:'Old automatic multiplier request'})).rejects.toMatchObject({status:400});
  const original=await db.getPayrollRecord('ledger:'+context.person.id), audit=jest.spyOn(db,'appendAudit').mockRejectedValueOnce(new Error('Synthetic manual-decision audit failure'));
  try {await expect(service.approve(context.admin,context.person.id,base)).rejects.toThrow('Synthetic manual-decision audit failure');} finally {audit.mockRestore();}
  expect(await db.getPayrollRecord(original.id)).toEqual(original);
  expect(vault.open(await db.getPayrollRecord(original.id)).approvals).toEqual({});
});

test('weekly overtime uses actual work and flags the crossing day without reopening approved earlier days', async () => {
  const context=await setup();
  for (let date=19;date<=22;date++) {
    const day='2026-10-'+date;await work(context,day,8.5);
    await service.approve(context.admin,context.person.id,await decision(context,day));
  }
  await work(context,'2026-10-23',5);
  let detail=await service.get(context.admin,context.person.id);
  expect(detail.ledger.days.at(-1).review.requiresOvertimeReview).toBe(false);
  // Four rounded-up paid days plus this day total 41 paid hours, but only
  // 39 actual hours. The paid credit must not invent weekly hours worked.
  await service.approve(context.admin,context.person.id,await decision(context,'2026-10-23',{overtimeReviewed:false}));
  await work(context,'2026-10-24',3);
  detail=await service.get(context.admin,context.person.id);
  expect(detail.ledger.days.slice(0,5).map(day=>day.review.state)).toEqual(Array(5).fill('approved'));
  expect(detail.ledger.days.at(-1).review).toMatchObject({requiresOvertimeReview:true,state:'needs-attention'});
  expect(detail.ledger.days.at(-1).review.reasons).toContainEqual(expect.objectContaining({code:'OVERTIME_REVIEW',message:expect.stringContaining('42 hr')}));
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(1);
});

test('a frozen legacy allowance warns from the second short day and cannot grant a schedule-rounding exemption', async () => {
  const context=await setup();
  await service.schedule(context.admin,context.person.id,{version:1,effectiveOn:'2026-10-19',approvedHours:9,reason:'Synthetic earlier hours-only approved allowance'});
  for (const date of ['2026-10-19','2026-10-20','2026-10-21']) await work(context,date,8.5);
  const detail=await service.get(context.admin,context.person.id);
  expect(detail.shortDayWarnings[0]).toMatchObject({count:3,plannedMinutes:540});
  for(const day of detail.ledger.days) expect(day.review).toMatchObject({suggestedPaidMillis:9*HOUR,scheduledCreditMillis:0,roundingCreditMillis:.5*HOUR,requiresRoundingReview:true,workTime:{hasCapturedAllowance:true,plannedStart:null,plannedEnd:null}});
  // A restored old ledger with no captured allowance cannot acquire a guessed
  // attendance threshold merely from today's fallback configuration.
  const raw=await db.getPayrollRecord('ledger:'+context.person.id), ledger=vault.open(raw);
  delete ledger.workLimits;delete ledger.workWindows;
  await db.savePayrollRecord({...raw,ciphertext:vault.seal(raw,ledger)});
  expect((await service.get(context.admin,context.person.id)).shortDayWarnings).toEqual([]);
});

test('a changed payroll policy renews the administrator overtime reminder', async () => {
  const context=await setup();await work(context,'2026-10-19',8.5);
  await service.approve(context.admin,context.person.id,await decision(context,'2026-10-19'));
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(0);
  const detail=await service.get(context.admin,context.person.id);
  await service.profile(context.admin,context.person.id,{version:detail.profile.version,reason:'New reviewed policy reference',rules:{...rules,reference:'Synthetic changed review reference'}});
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(1);
});

test('a corrected effective hourly rate cannot reuse an older overtime amount without administrator review', async () => {
  const context=await setup();await work(context,'2026-10-19',8.5);
  await service.approve(context.admin,context.person.id,await decision(context,'2026-10-19',{premiumCents:1250}));
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(0);
  let detail=await service.get(context.admin,context.person.id);
  await service.rate(context.admin,context.person.id,{version:detail.profile.version,effectiveOn:'2026-10-19',cents:2500,currency:'USD',reason:'Corrected effective hourly rate'});
  detail=await service.get(context.admin,context.person.id);
  expect(detail.ledger.days[0].approval.premiumCents).toBe(1250);
  expect(detail.ledger.days[0].review).toMatchObject({state:'needs-attention',requiresOvertimeReview:true});
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(1);
  const preview=await service.preview(context.admin,context.person.id,{start:'2026-10-19',end:'2026-10-19'});
  expect(preview.canFinalize).toBe(false);expect(preview.blockers.join(' ')).toMatch(/hourly rate changed/);
  await service.approve(context.admin,context.person.id,await decision(context,'2026-10-19',{premiumCents:1600}));
  expect((await service.workTime(context.admin)).overtimeReviewCount).toBe(0);
  expect(await service.preview(context.admin,context.person.id,{start:'2026-10-19',end:'2026-10-19'})).toMatchObject({canFinalize:true,grossCents:24100});
});

test('a rate change between loading and saving a manual decision rejects the stale pay setup without changing the ledger', async () => {
  const context=await setup();await work(context,'2026-10-19',8.5);
  const body=await decision(context,'2026-10-19',{premiumCents:1250}), before=await db.getPayrollRecord('ledger:'+context.person.id);
  await service.rate(context.admin,context.person.id,{version:body.profileVersion,effectiveOn:'2026-10-19',cents:2500,currency:'USD',reason:'Another administrator corrected the effective hourly rate'});
  await expect(service.approve(context.admin,context.person.id,body)).rejects.toMatchObject({status:409,code:'PAYROLL_CONFLICT'});
  expect(await db.getPayrollRecord(before.id)).toEqual(before);
  const refreshed=await decision(context,'2026-10-19',{premiumCents:1600});
  await service.approve(context.admin,context.person.id,refreshed);
  expect(await service.preview(context.admin,context.person.id,{start:'2026-10-19',end:'2026-10-19'})).toMatchObject({canFinalize:true,grossCents:24100});
});
