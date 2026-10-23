const { randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const vault = require('./payrollVault');
const time = require('./facilityTime');
const math = require('./payrollMath');
const v = require('./childDocumentValidation');
const emptyLedger = () => ({ sessions: [], approvals: {}, history: [], requests: [], timeZone: time.timeZone() });
const emptyProfile = () => ({ legalName: '', paymentMethod: 'provider', payFrequency: 'biweekly', providerReference: '', instructions: '', taxId: '', bankAccount: '', routingNumber: '', requiredDocuments: [], rates: [], history: [], rules: { mode: 'ca-standard', workweekStart: 1, confirmed: false, reference: '', dailyScheduledMinutes: 480 } });
const integer = (value, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || value < 0 || value > max) throw auth.problem('Enter a valid non-negative whole number.'); return value; };
const text = (value, name = 'details', max = 2000) => v.text(value, name, max);
const reason = value => v.text(value, 'reason', 1000, { required: true });
const rowId = (kind, staffId) => kind + ':' + staffId;
async function read(kind, staffId) { const row = await db.getPayrollRecord(rowId(kind, staffId)); return row ? { data: vault.open(row), version: row.version } : { data: kind === 'ledger' ? emptyLedger() : emptyProfile(), version: 0 }; }
async function write(kind, staffId, data, version, id = rowId(kind, staffId)) {
  const previous = await db.getPayrollRecord(id); const now = new Date();
  const row = { id, staffId, kind, version: version + 1, createdAt: previous?.createdAt || now, updatedAt: now };
  return db.savePayrollRecord({ ...row, ciphertext: vault.seal(row, data) });
}
async function employee(id) { v.identifier(id, 'staff'); const staff = await db.getStaffById(id); if (!staff) throw auth.problem('Staff record not found.', 404); return staff; }
const authorized = (token, admin, fn) => db.withAuthLock(async () => {
  const actor = await auth.sessionAccount(token, { touch: true }); auth.operationalPermission(actor, false);
  if (admin === 'manager' && !['admin', 'editor'].includes(actor.role)) throw auth.problem('Administrator or editor work-time access is required.', 403, 'FORBIDDEN');
  if (admin === true && actor.role !== 'admin') throw auth.problem('Administrator payroll access is required.', 403, 'FORBIDDEN');
  vault.check(); return fn(actor);
});
const expectVersion = (payload, version) => { if (payload.version !== version) throw auth.problem('This payroll record changed. Refresh before saving.', 409, 'PAYROLL_CONFLICT'); };
const stamp = actor => ({ actorId: actor.id, at: new Date().toISOString() });
function instant(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now()) throw auth.problem('Enter an ISO timestamp with Z or a UTC offset, no later than now.'); time.validateDate(value.slice(0,10)); return new Date(value).toISOString(); }
function validateSession(session, sessions) {
  const end = session.end ? Date.parse(session.end) : Infinity, start = Date.parse(session.start);
  if (end <= start || (Number.isFinite(end) && end - start > 7 * 86400000)) throw auth.problem('Checkout must follow check-in and span no more than seven days.');
  if (sessions.some(s => s.id !== session.id && !s.voided && start < (s.end ? Date.parse(s.end) : Infinity) && end > Date.parse(s.start))) throw auth.problem('This time overlaps another work session.', 409);
  const breaks = session.breaks.filter(b => b.end).sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < breaks.length; i++) {
    const b = breaks[i]; const finish = b.end ? Date.parse(b.end) : Infinity;
    if (Date.parse(b.start) < start || finish > end || finish <= Date.parse(b.start) || typeof b.paid !== 'boolean' || (i && Date.parse(b.start) < (breaks[i - 1].end ? Date.parse(breaks[i - 1].end) : Infinity))) throw auth.problem('Breaks must be inside the work session and cannot overlap.');
  }
}
function invalidate(ledger, sessions) {
  for (const [date, approval] of Object.entries(ledger.approvals)) {
    if (approval.status === 'approved' && sessions.some(s => date >= time.dateAt(s.start, ledger.timeZone) && date <= time.dateAt(s.end || new Date(), ledger.timeZone))) approval.status = 'needs-review';
  }
}
const ledgerDto = value => ({ version: value.version, timeZone: value.data.timeZone, sessions: value.data.sessions, days: math.daily(value.data), history: value.data.history });
const readableDuration = millis => {
  if (millis > 0 && millis < 1000) return 'less than 1 second';
  const seconds = Math.max(0, Math.floor(millis / 1000));
  return [Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)} hr` : '', Math.floor(seconds % 3600 / 60) ? `${Math.floor(seconds % 3600 / 60)} min` : '', seconds % 60 ? `${seconds % 60} sec` : ''].filter(Boolean).join(' ') || '0 min';
};
const readableClock = clock => {
  const [hours, minutes] = clock.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};
function shortDayGroups(rows, rules) {
  const groups = new Map();
  for (const row of rows) {
    if (row.incomplete || !row.hasCapturedAllowance || row.plannedMinutes <= 0 || row.paidMillis >= row.plannedMinutes * 60000) continue;
    const context = math.overtimeContext(row, [], rules);
    const group = groups.get(context.weekStart) || { weekStart: context.weekStart, weekEnd: context.weekEnd, dates: [], planned: new Set() };
    group.dates.push(row.date); group.planned.add(row.plannedMinutes); groups.set(context.weekStart, group);
  }
  return groups;
}
function shortDayWarnings(staff, rows, rules, start, end) {
  return [...shortDayGroups(rows, rules).values()].filter(group => group.dates.length > 1 && (!start || group.weekEnd >= start) && (!end || group.weekStart <= end)).map(group => ({
    staffId: staff.id, name: staff.name, weekStart: group.weekStart, weekEnd: group.weekEnd, count: group.dates.length, dates: group.dates,
    ...(group.planned.size === 1 ? { plannedMinutes: [...group.planned][0] } : {}),
  }));
}
function roundingReview(day, work, rows, rules, overrideCurrent = false) {
  const credit = math.scheduledPayCredit(day, work), context = math.overtimeContext(day, [], rules);
  const shortDates = shortDayGroups(rows, rules).get(context.weekStart)?.dates || [];
  const shortDayOrdinal = shortDates.includes(day.date) ? shortDates.filter(date => date <= day.date).length : 0;
  const requiresRoundingReview = credit.roundingCreditMillis > 0 && (!credit.eligible || shortDayOrdinal > 1);
  const fingerprint = math.hash({ policy: 'whole-hour-round-up-v1', date: day.date, paidMillis: day.paidMillis,
    sessionIds: day.sessionIds, incomplete: day.incomplete, suggestedPaidMillis: credit.suggestedPaidMillis,
    plannedStart: work?.plannedStart, plannedEnd: work?.plannedEnd, plannedMinutes: work?.plannedMinutes,
    outsideMillis: work?.outsideMillis, scheduleIssue: work?.scheduleIssue, workweekStart: context.weekStart, shortDayOrdinal });
  const approval = day.approval;
  const current = approval?.status === 'approved' && approval.rulesReviewed &&
    (approval.paidMillis ?? approval.regularMillis) >= credit.suggestedPaidMillis && approval.roundingFingerprint === fingerprint;
  const belowProposal = approval?.status === 'approved' && (approval.paidMillis ?? approval.regularMillis) < credit.suggestedPaidMillis;
  return { ...credit, requiresRoundingReview, shortDayOrdinal, fingerprint,
    pending: !day.incomplete && !overrideCurrent && (belowProposal || requiresRoundingReview && !current) };
}
function overtimeReview(day, days, work, rules, rates) {
  const context = math.overtimeContext(day, days, rules);
  const requiresOvertimeReview = context.requiresReview || !!(work?.outsideMillis || work?.extraMillis || work?.scheduleIssue || day.approval?.overtimeMillis || day.approval?.doubleMillis || day.approval?.rateMillis);
  const approval = day.approval;
  const current = approval?.status === 'approved' && approval.mode === 'manual-reviewed' && approval.overtimeReviewed === true && approval.rulesFingerprint === math.hash(rules) &&
    approval.overtimeFingerprint === math.overtimeFingerprint(day, days, rules, rates);
  return { ...context, requiresOvertimeReview, pending: requiresOvertimeReview && !current };
}
async function payrollReviewDays(staffId, ledger, profile, days) {
  if (!days.length) return days;
  // These are private, current explanations. No clock record or approval is
  // changed by a read; additional scheduled pay remains a separate proposal.
  const workRowsForStaff = await workRows(staffId, ledger, days[0].date, days.at(-1).date);
  const workByDate = new Map(workRowsForStaff.map(row => [row.date, row]));
  const previewByDate = new Map(math.preview(ledger.data, profile, days[0].date, days.at(-1).date).rows.map(row => [row.date, row]));
  const rules = profile.rules, rulesFingerprint = math.hash(rules), policyReady = rules.confirmed && !!rules.reference.trim() && rules.mode === 'ca-standard';
  const shortGroups = shortDayGroups(workRowsForStaff, rules);
  return days.map(day => {
    const reasons = [], approval = day.approval, work = workByDate.get(day.date), preview = previewByDate.get(day.date);
    const add = (code, message, action, date) => { if (!reasons.some(reason => reason.code === code && reason.message === message)) reasons.push({ code, message, action, ...(date ? { date } : {}) }); };
    const review = overtimeReview(day, days, work, rules, profile.rates);
    const credit = roundingReview(day, work, workRowsForStaff, rules, math.validHoursOverride(day, days, ledger.data, profile));
    const week = days.filter(row => row.date >= review.weekStart && row.date <= review.weekEnd);
    if (day.incomplete) add('MISSING_CHECKOUT', 'Checkout is missing. Record the actual departure before approving this day.', 'time');
    if (!rules.confirmed || !rules.reference.trim()) add('POLICY_UNCONFIRMED', 'The employee\'s payroll rules have not been reviewed and confirmed.', 'profile');
    if (rules.mode !== 'ca-standard') add('POLICY_UNSUPPORTED', 'The saved payroll rules require payroll-provider review.', 'profile');
    if (!preview.rate) add('RATE_MISSING', 'No hourly rate applies to this date. Add a rate effective on or before this day.', 'rates');
    else if (preview.rate.currency !== 'USD') add('CURRENCY_UNSUPPORTED', 'The saved hourly rate uses ' + preview.rate.currency + '. This calculator supports USD; review the rate or use your payroll provider.', 'rates');
    if (approval?.status === 'returned') add('APPROVAL_RETURNED', 'Returned for correction: ' + approval.reason, 'time');
    if (approval?.status === 'needs-review') add('CLOCK_CHANGED', 'Clock records changed after approval. Review the updated recorded time and approve this day again.', 'time');
    if (credit.pending) {
      const cause = credit.eligible && credit.shortDayOrdinal > 1 ? ' Short workdays have repeated this week. Please review this day.' : credit.eligible ? ' Update the earlier paid-hours decision.' : ' No matching approved daily schedule is available for this day.';
      add('ROUNDING_REVIEW', 'Review rounding from ' + readableDuration(day.paidMillis) + ' to ' + readableDuration(credit.suggestedPaidMillis) + ' paid time.' + cause, 'approve');
    }
    if (work?.status === 'pending') {
      if (work.scheduleIssue) add('SCHEDULE_ISSUE', work.scheduleIssue, 'work-time');
      else if (work.plannedStart && work.plannedEnd) {
        const parts = [work.earlyMillis ? readableDuration(work.earlyMillis) + ' before the approved start' : '', work.lateMillis ? readableDuration(work.lateMillis) + ' after the approved end' : ''].filter(Boolean);
        add('OUTSIDE_SCHEDULE', 'Recorded work includes ' + parts.join(' and ') + '. Approved schedule: ' + readableClock(work.plannedStart) + '–' + readableClock(work.plannedEnd) + ' (' + work.scheduleTimeZone + '). Confirm the work or correct a verified clock error in Work time.', 'work-time');
      } else add('OUTSIDE_SCHEDULE', 'Recorded work exceeds the earlier daily-hours allowance by ' + readableDuration(work.extraMillis) + '. Confirm the work or correct a verified clock error in Work time.', 'work-time');
    }
    if (review.pending && !day.incomplete) {
      const causes = [];
      if (review.daily) causes.push(readableDuration(day.paidMillis) + ' was recorded, which exceeds eight hours.');
      if (review.weekly) causes.push(readableDuration(review.weekMillis) + ' was recorded in this workweek, which exceeds forty hours.');
      if (review.seventhDay) causes.push('This is the seventh recorded workday in the workweek.');
      if (work?.outsideMillis || work?.extraMillis) causes.push('Recorded work includes time outside the approved schedule.');
      add('OVERTIME_REVIEW', causes.join(' ') + ' Overtime needs your explicit review. Choose the paid hours and rate; no multiplier is applied automatically.', 'time');
    }
    const missingCheckouts = review.requiresOvertimeReview ? week.filter(row => row.incomplete && row.date < day.date) : [];
    if (missingCheckouts.length) add('WORKWEEK_CHECKOUT', 'Checkout is missing on these workweek dates: ' + missingCheckouts.map(row => row.date).join(', ') + '. Record the actual departures before reviewing overtime.', 'time', missingCheckouts[0].date);
    for (const message of preview.issues) {
      if (['Missing checkout.', 'Daily paid time is not approved.', 'No effective hourly rate.'].includes(message) || message.startsWith('Overtime needs explicit') || message.startsWith('Paid time needs rounding review.')) continue;
      if (message === 'The complete workweek needs approved time for overtime review.') {
        const unresolved = week.filter(row => row.incomplete || row.approval?.status !== 'approved' || row.approval.rulesFingerprint !== rulesFingerprint);
        const dates = unresolved.map(row => row.date + ' (' + (row.incomplete ? 'missing checkout' : row.approval?.status !== 'approved' ? 'not approved' : 'payroll policy changed') + ')');
        add('WORKWEEK_APPROVALS', 'Recorded days in this workweek still need review: ' + dates.join(', ') + '. Review those dates before calculating.', 'time', unresolved[0]?.date);
      } else if (message.includes('policy changed')) add('POLICY_CHANGED', message, 'time');
      else add('PAYROLL_VALIDATION', message, 'time');
    }
    const attention = reasons.length > 0;
    if (!attention && approval?.status !== 'approved') add('APPROVAL_REQUIRED', 'Recorded time has not been approved yet.', 'approve');
    const unchangedAllocation = !approval || !approval.overtimeMillis && !approval.doubleMillis && !approval.adjustmentCents && !approval.premiumCents && !approval.rateMillis && (!approval.multiplierHundredths || approval.multiplierHundredths === 100) && (approval.paidMillis ?? approval.regularMillis) === credit.suggestedPaidMillis;
    const canApproveRecorded = !attention && policyReady && !day.incomplete && !review.requiresOvertimeReview && unchangedAllocation;
    const workTime = work ? Object.fromEntries(['plannedStart', 'plannedEnd', 'plannedMinutes', 'hasCapturedAllowance', 'scheduleTimeZone', 'timeZone', 'checkin', 'checkout', 'sessions', 'earlyMillis', 'lateMillis', 'outsideMillis', 'status', 'reason', 'scheduleIssue'].map(key => [key, work[key]])) : undefined;
    return { ...day, review: { state: attention ? 'needs-attention' : approval?.status === 'approved' ? 'approved' : 'awaiting-approval', reasons, canApproveRecorded, workTime,
      suggestedPaidMillis: credit.suggestedPaidMillis, scheduledCreditMillis: credit.scheduledCreditMillis,
      roundingCreditMillis: credit.roundingCreditMillis, requiresRoundingReview: credit.requiresRoundingReview, shortDayOrdinal: credit.shortDayOrdinal,
      requiresOvertimeReview: review.requiresOvertimeReview, shortDayCount: shortGroups.get(review.weekStart)?.dates.length || 0, workweekStart: review.weekStart } };
  });
}
function maskedProfile(data) {
  const result = structuredClone(data); delete result.history;
  for (const key of ['taxId', 'bankAccount', 'routingNumber']) result[key] = data[key] ? '••••' + data[key].slice(-4) : '';
  return result;
}
const personalClockDenied = async () => { throw auth.problem('Use the staff clock managed by an administrator, editor or paired clock station.', 403, 'PERSONAL_CLOCK_DISABLED'); };
exports.own = personalClockDenied;
exports.clock = personalClockDenied;
async function clockState(staffId) {
  const staff = await employee(staffId), ledger = await read('ledger', staff.id);
  return { id: staff.id, name: staff.name, active: staff.active, checkedIn: ledger.data.sessions.some(session => !session.voided && !session.end), version: ledger.version };
}
exports.clockStatus = token => authorized(token, 'manager', async actor => {
  const staff = [];
  for (let page = 1;; page++) {
    const batch = await db.listStaff({ page, pageSize: 100 });
    for (const person of batch) staff.push(await clockState(person.id));
    if (batch.length < 100) break;
  }
  await auth.audit(actor, 'employee_clock.status');
  return { staff, timeZone: time.timeZone() };
});
async function clockEmployee(actor, staffId, payload, source = {}) {
  v.object(payload, ['action', 'requestId', 'version']);
  if (!['checkin', 'checkout'].includes(payload.action)) throw auth.problem('Use check in or check out. A manager handles time corrections.');
  const requestId = v.requestId(payload.requestId);
  const staff = await employee(staffId); if (!staff.active) throw auth.problem('Staff record is inactive.', 403);
  const ledger = await read('ledger', staff.id); const data = ledger.data;
  const previouslyClocked = new Set(math.daily(data).map(day => day.date));
  const actorKey = source.stationId ? 'station:' + source.stationId + ':' + source.grantId : 'manager:' + actor.id;
  const attribution = { ...stamp(actor), actorUsername: actor.username, staffId: staff.id, ...(source.stationId ? { stationId: source.stationId, actorType: 'clock-station' } : { actorType: 'manager' }) };
  const replay = data.requests.find(r => r.id === requestId);
  if (replay) { if (replay.action !== payload.action || replay.actorKey !== actorKey) throw auth.problem('Request identifier was already used for another action or actor.', 409); return { replayed: true }; }
  expectVersion(payload, ledger.version);
  const open = data.sessions.find(s => !s.voided && !s.end); const now = new Date().toISOString();
  if (payload.action === 'checkin') {
    if (open) throw auth.problem('You are already checked in.', 409);
    if (data.sessions.length >= 20000) throw auth.problem('Time ledger requires archival before adding more entries.', 409);
    const next = { id: randomUUID(), start: now, end: null, original: { start: now, end: null }, breaks: [], ...attribution, version: 1 };
    validateSession(next, data.sessions); data.sessions.push(next);
  } else {
    if (!open) throw auth.problem('Check in before recording a departure.', 409);
    open.end = now; if (!open.original.end) open.original.end = now;
    open.version++; validateSession(open, data.sessions);
  }
  invalidate(data, [payload.action === 'checkin' ? data.sessions.at(-1) : open]); data.requests.push({ id: requestId, action: payload.action, actorKey });
  if (data.requests.length > 20000) throw auth.problem('Time ledger requires archival.', 409);
  data.history.push({ type: payload.action, sessionId: (payload.action === 'checkin' ? data.sessions.at(-1) : open).id, requestId, ...attribution });
  await captureWorkLimits(data, staff.id, previouslyClocked);
  await write('ledger', staff.id, data, ledger.version); await auth.audit(actor, 'employee_clock.' + payload.action.replace('-', '_'), staff.id);
  return { replayed: false };
}
exports.managerClock = (token, staffId, payload) => authorized(token, 'manager', actor => clockEmployee(actor, staffId, payload));
// Trusted server composition only. The station service validates its own
// credential and employee grant inside this same auth lock before invoking it.
exports.stationClock = (credential, payload, options) => require('./clockStationService').clock(credential, payload, options, clockEmployee);
exports.stationIdentify = (credential, payload, options) => require('./clockStationService').identify(credential, payload, options, clockState);
exports.get = (token, staffId) => authorized(token, true, async actor => {
  const staff = await employee(staffId);
  // authorized() holds one transaction/client. Finish each query before
  // issuing the next; pg does not support concurrent queries on that client.
  const profile = await read('profile', staffId), ledger = await read('ledger', staffId);
  const docs = await db.listPayrollRecords(staffId, 'document'), snapshots = await db.listPayrollRecords(staffId, 'snapshot');
  const ledgerDetails = ledgerDto(ledger);
  ledgerDetails.days = await payrollReviewDays(staffId, ledger, profile.data, ledgerDetails.days);
  await auth.audit(actor, 'payroll.view', staffId);
  const documents = docs.map(row => { const d = vault.open(row); return { id: row.id, version: row.version, title: d.title, category: d.category,
    revisions: d.revisions.map(({ dataBase64, ...r }) => r) }; });
  return { staff: { id: staff.id, name: staff.name, active: staff.active }, profile: { ...maskedProfile(profile.data), version: profile.version },
    ledger: ledgerDetails, shortDayWarnings: shortDayWarnings(staff, ledgerDetails.days.map(day => ({...day,...day.review?.workTime})), profile.data.rules), documents, missingDocuments: profile.data.requiredDocuments.filter(name => !documents.some(d => d.title.toLowerCase() === name.toLowerCase())),
    snapshots: snapshots.map(row => { const value = vault.open(row); return { id: row.id, start: value.preview.start, end: value.preview.end, at: value.at, grossCents: value.preview.grossCents, currency: value.preview.currency }; }) };
});
exports.profile = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['version', 'reason', 'legalName', 'paymentMethod', 'payFrequency', 'providerReference', 'instructions', 'taxId', 'bankAccount', 'routingNumber', 'requiredDocuments', 'rules']);
  await employee(staffId); const current = await read('profile', staffId); expectVersion(payload, current.version); const data = current.data, before = structuredClone(data); const why = reason(payload.reason);
  for (const key of ['legalName', 'providerReference', 'instructions']) if (payload[key] !== undefined) data[key] = text(payload[key], key);
  for (const key of ['taxId', 'bankAccount', 'routingNumber']) if (payload[key] !== undefined) data[key] = payload[key] === null ? '' : text(payload[key], key, 100);
  if (payload.paymentMethod !== undefined) { if (!['cash', 'check', 'direct-deposit', 'provider'].includes(payload.paymentMethod)) throw auth.problem('Choose a payment method.'); data.paymentMethod = payload.paymentMethod; }
  if (payload.payFrequency !== undefined) { if (!['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(payload.payFrequency)) throw auth.problem('Choose a pay frequency.'); data.payFrequency = payload.payFrequency; }
  if (payload.requiredDocuments !== undefined) { if (!Array.isArray(payload.requiredDocuments) || payload.requiredDocuments.length > 30) throw auth.problem('Add at most 30 required payroll document names.'); data.requiredDocuments = [...new Set(payload.requiredDocuments.map(name => v.text(name, 'document name', 160, { required: true })))]; }
  if (payload.rules !== undefined) {
    v.object(payload.rules, ['mode', 'workweekStart', 'confirmed', 'reference', 'dailyScheduledMinutes']);
    if (!['ca-standard', 'external-review'].includes(payload.rules.mode) || typeof payload.rules.confirmed !== 'boolean') throw auth.problem('Choose and confirm the payroll rule review.');
    data.rules = { mode: payload.rules.mode, confirmed: payload.rules.confirmed, workweekStart: integer(payload.rules.workweekStart, 6), reference: text(payload.rules.reference, 'rules reference'), dailyScheduledMinutes: integer(payload.rules.dailyScheduledMinutes, 1440) };
    if (data.rules.confirmed && !data.rules.reference) throw auth.problem('Describe the verified payroll policy before confirming it.');
  }
  data.history.push({ before: { ...before, history: undefined }, reason: why, ...stamp(actor) });
  await write('profile', staffId, data, current.version); await auth.audit(actor, 'payroll.profile_update', staffId); return { saved: true };
});
exports.rate = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['version', 'effectiveOn', 'cents', 'currency', 'reason']); await employee(staffId);
  const current = await read('profile', staffId); expectVersion(payload, current.version);
  const cents = integer(payload.cents, 10000000); if (!cents || !/^[A-Z]{3}$/.test(payload.currency || '')) throw auth.problem('Enter a positive hourly rate in cents and a three-letter currency.');
  const rate = { id: randomUUID(), effectiveOn: time.validateDate(payload.effectiveOn), cents, currency: payload.currency, sequence: current.data.rates.length + 1, reason: reason(payload.reason), ...stamp(actor) };
  current.data.rates.push(rate); await write('profile', staffId, current.data, current.version); await auth.audit(actor, 'payroll.rate_add', staffId); return rate;
});
exports.correct = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['version', 'sessionId', 'start', 'end', 'endLocal', 'endOccurrence', 'breaks', 'voided', 'reason']); await employee(staffId);
  const ledger = await read('ledger', staffId); expectVersion(payload, ledger.version); const old = ledger.data.sessions.find(s => s.id === payload.sessionId);
  if (!old) throw auth.problem('Time session not found.', 404);
  let end = payload.end;
  if (payload.endLocal !== undefined) {
    if (payload.end !== undefined) throw auth.problem('Choose a local checkout time or an offset-qualified checkout, not both.');
    if (typeof payload.endLocal !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.endLocal)) throw auth.problem('Enter the actual checkout date and time.');
    time.validateDate(payload.endLocal.slice(0, 10));
    if (payload.endOccurrence !== undefined && !['earlier', 'later'].includes(payload.endOccurrence)) throw auth.problem('Choose the first or second occurrence of the checkout time.');
    const choices = wallTimeChoices(payload.endLocal.slice(0, 10), payload.endLocal.slice(11), ledger.data.timeZone);
    if (!choices.length) throw auth.problem('That checkout time does not exist because the clocks moved forward. Choose another time.');
    if (choices.length > 1 && !['earlier', 'later'].includes(payload.endOccurrence)) throw auth.problem('That checkout time occurs twice because the clocks moved back. Choose its first or second occurrence.');
    end = new Date(payload.endOccurrence === 'later' ? choices.at(-1) : choices[0]).toISOString();
  } else if (payload.endOccurrence !== undefined) throw auth.problem('Choose a local checkout time before selecting its occurrence.');
  if (payload.breaks !== undefined && (!Array.isArray(payload.breaks) || payload.breaks.length > 30) || typeof payload.voided !== 'boolean') throw auth.problem('Supply valid time records and record status.');
  const next = { ...old, start: instant(payload.start), end: end === null ? null : instant(end), voided: payload.voided,
    breaks: payload.breaks === undefined ? structuredClone(old.breaks) : payload.breaks.map(b => { v.object(b, ['start', 'end', 'paid']); return { start: instant(b.start), end: b.end === null ? null : instant(b.end), paid: b.paid }; }), version: old.version + 1 };
  if (!next.voided) validateSession(next, ledger.data.sessions);
  ledger.data.history.push({ type: 'correction', before: structuredClone(old), after: structuredClone(next), reason: reason(payload.reason), ...stamp(actor) });
  invalidate(ledger.data, [old, next]); Object.assign(old, next); await write('ledger', staffId, ledger.data, ledger.version); await auth.audit(actor, 'employee_clock.correct', staffId); return { saved: true };
});
exports.approve = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['version', 'profileVersion', 'date', 'status', 'mode', 'paidMillis', 'premiumCents', 'overtimeReviewed', 'regularMillis', 'overtimeMillis', 'doubleMillis', 'adjustmentCents', 'rulesReviewed', 'reason', 'hoursOverride', 'clockErrorConfirmed', 'rateMillis', 'multiplierHundredths', 'replaceLegacyPremium']); await employee(staffId);
  const ledger = await read('ledger', staffId); expectVersion(payload, ledger.version); const date = time.validateDate(payload.date);
  const days = math.daily(ledger.data), day = days.find(row => row.date === date); if (!day) throw auth.problem('No time records exist on this day.', 404);
  if (!['approved', 'returned'].includes(payload.status) || typeof payload.rulesReviewed !== 'boolean') throw auth.problem('Choose approved or returned and confirm the daily rule review.');
  if (payload.status === 'approved' && day.incomplete) throw auth.problem('Record the missing checkout before approving.', 409);
  const profile = await read('profile', staffId), context = math.overtimeContext(day, days, profile.data.rules);
  const workWeek = await workRows(staffId, ledger, context.weekStart, context.weekEnd), work = workWeek.find(row => row.date === date);
  const review = overtimeReview(day, days, work, profile.data.rules, profile.data.rates), credit = roundingReview(day, work, workWeek, profile.data.rules);
  const allocatedRate = payload.rateMillis !== undefined || payload.multiplierHundredths !== undefined;
  const manual = payload.mode === 'manual-reviewed' || payload.paidMillis !== undefined || allocatedRate;
  if (manual && payload.profileVersion !== profile.version) throw auth.problem('The employee pay setup changed. Refresh the employee setup and selected rate before saving.', 409, 'PAYROLL_CONFLICT');
  if (payload.mode !== undefined && payload.mode !== 'manual-reviewed') throw auth.problem('Use manually reviewed paid hours and choose their rate.');
  if (payload.overtimeMillis || payload.doubleMillis) throw auth.problem('Automatic overtime allocations are no longer used. Enter reviewed paid hours and choose the portion and rate explicitly.');
  if (manual && (payload.regularMillis !== undefined || payload.overtimeMillis !== undefined || payload.doubleMillis !== undefined)) throw auth.problem('Enter paid hours once, without separate automatic overtime allocations.');
  const paidMillis = integer(manual ? payload.paidMillis : payload.regularMillis, 48 * 3600000);
  let rateMillis, multiplierHundredths;
  if (allocatedRate) {
    if (payload.premiumCents !== undefined) throw auth.problem('Choose a rate or retain a legacy fixed additional amount, not both.');
    rateMillis = integer(payload.rateMillis, paidMillis); multiplierHundredths = integer(payload.multiplierHundredths, 1000);
    if (multiplierHundredths < 100) throw auth.problem('Choose a rate between 1x and 10x, with at most two decimal places.');
    if (payload.replaceLegacyPremium !== undefined && typeof payload.replaceLegacyPremium !== 'boolean') throw auth.problem('Confirm replacement of the earlier fixed additional amount.');
    if (day.approval?.premiumCents > 0 && payload.replaceLegacyPremium !== true) throw auth.problem('Confirm that the selected rate replaces the earlier fixed additional amount. The earlier decision has been kept.', 409, 'LEGACY_PAY_REPLACEMENT_REQUIRED');
  } else if (payload.replaceLegacyPremium !== undefined) throw auth.problem('Choose an explicit rate allocation before replacing the earlier fixed additional amount.');
  const premiumCents = allocatedRate ? undefined : manual ? integer(payload.premiumCents, 100000000) : 0;
  for (const field of ['hoursOverride', 'clockErrorConfirmed']) if (payload[field] !== undefined && typeof payload[field] !== 'boolean') throw auth.problem('Confirm the approved-hours change and any verified clock error.');
  const hoursOverride = payload.hoursOverride === true, clockErrorConfirmed = payload.clockErrorConfirmed === true, why = reason(payload.reason);
  if (clockErrorConfirmed && !hoursOverride) throw auth.problem('Confirm that you are changing the approved paid hours before confirming a clock error.');
  if (payload.overtimeReviewed !== undefined && typeof payload.overtimeReviewed !== 'boolean') throw auth.problem('Confirm whether overtime has been reviewed.');
  const overtimeReviewed = payload.overtimeReviewed === true;
  if (payload.status === 'approved' && (review.requiresOvertimeReview || allocatedRate && rateMillis > 0) && (!manual || !overtimeReviewed)) throw auth.problem('Overtime always needs administrator review. Choose the paid hours and rate explicitly, then confirm the review.');
  if (payload.status === 'approved' && paidMillis !== credit.suggestedPaidMillis && !hoursOverride) throw auth.problem('Confirm the changed paid hours and enter a reason, or use the proposed paid time.');
  if (payload.status === 'approved' && paidMillis < day.paidMillis && (!hoursOverride || !clockErrorConfirmed)) throw auth.problem('Verify that the clock record is incorrect before approving fewer hours, and enter the reason.');
  const adjustmentCents = payload.adjustmentCents === undefined ? day.approval?.adjustmentCents || 0 : payload.adjustmentCents;
  if (!Number.isSafeInteger(adjustmentCents) || Math.abs(adjustmentCents) > 100000000) throw auth.problem('Approved time or adjustment is outside the supported range.');
  const approval = { mode: 'manual-reviewed', rulesFingerprint: math.hash(profile.data.rules), date, status: payload.status,
    paidMillis, ...(allocatedRate ? { rateMillis, multiplierHundredths,
      rateFingerprint: math.rateAllocationFingerprint(day, days, ledger.data, profile.data, paidMillis, rateMillis, multiplierHundredths, why),
      ...(day.approval?.premiumCents > 0 ? { replacedLegacyPremiumCents: day.approval.premiumCents } : {}) } : { premiumCents }),
    overtimeReviewed, requiresOvertimeReview: review.requiresOvertimeReview || allocatedRate && rateMillis > 0,
    overtimeFingerprint: math.overtimeFingerprint(day, days, profile.data.rules, profile.data.rates),
    // Preserve these keys for older readers without choosing a multiplier.
    regularMillis: paidMillis, overtimeMillis: 0, doubleMillis: 0, adjustmentCents,
    scheduledCreditMillis: credit.eligible && paidMillis === credit.suggestedPaidMillis ? credit.scheduledCreditMillis : 0,
    roundingCreditMillis: paidMillis === credit.suggestedPaidMillis ? credit.roundingCreditMillis : 0,
    roundingReviewed: payload.status === 'approved' && payload.rulesReviewed,
    roundingFingerprint: credit.fingerprint,
    hoursOverride, clockErrorConfirmed,
    ...(hoursOverride ? { hoursOverrideFingerprint: math.hoursOverrideFingerprint(day, days, ledger.data, profile.data, paidMillis, clockErrorConfirmed, why),
      hoursOverrideRecord: { rawMillis: day.rawMillis, recordedMillis: day.paidMillis, proposedMillis: credit.suggestedPaidMillis, approvedMillis: paidMillis, reason: why } } : {}),
    rulesReviewed: payload.rulesReviewed, reason: why, ...stamp(actor) };
  if (approval.status === 'approved' && !approval.rulesReviewed) throw auth.problem('Review actual hours, overtime and adjustments first.');
  ledger.data.history.push({ type: 'approval', ...stamp(actor), reason: approval.reason, before: ledger.data.approvals[date] || null, after: approval }); ledger.data.approvals[date] = approval;
  await write('ledger', staffId, ledger.data, ledger.version); await auth.audit(actor, 'payroll.daily_' + payload.status, staffId); return approval;
});
async function calculate(staffId, payload) {
  const start = time.validateDate(payload.start), end = time.validateDate(payload.end);
  if (end < start || end > time.addDays(start, 92)) throw auth.problem('Choose an ordered period of at most 93 days.');
  const ledger = await read('ledger', staffId), profile = await read('profile', staffId);
  const result = math.preview(ledger.data, profile.data, start, end);
  const work = await workRows(staffId, ledger, start, end);
  for (const row of work) if (row.status === 'pending') result.blockers.push(row.date + ': Extra work time needs manager review in Work time.');
  const days = math.daily(ledger.data), reviewDays = await payrollReviewDays(staffId, ledger, profile.data, days);
  for (const day of reviewDays.filter(row => row.date >= start && row.date <= end)) {
    for (const issue of day.review.reasons.filter(reason => reason.code === 'ROUNDING_REVIEW')) result.blockers.push(day.date + ': ' + issue.message);
  }
  result.canFinalize = !result.blockers.length;
  return result;
}
exports.preview = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['start', 'end']); await employee(staffId); const result = await calculate(staffId, payload); await auth.audit(actor, 'payroll.preview', staffId); return result;
});
exports.finalize = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['start', 'end', 'fingerprint', 'requestId']); await employee(staffId); const requestId = v.requestId(payload.requestId); const id = 'snapshot:' + requestId;
  const replay = await db.getPayrollRecord(id);
  if (replay) { const saved = vault.open(replay); if (replay.staffId !== staffId || saved.preview.fingerprint !== payload.fingerprint) throw auth.problem('Snapshot request was already used.', 409); return { id, replayed: true }; }
  const preview = await calculate(staffId, payload);
  if (!preview.canFinalize || preview.fingerprint !== payload.fingerprint) throw auth.problem('Resolve payroll blockers and refresh the preview before saving a snapshot.', 409);
  await write('snapshot', staffId, { preview, ...stamp(actor) }, 0, id); await auth.audit(actor, 'payroll.snapshot_save', staffId); return { id, replayed: false };
});
exports.snapshot = (token, staffId, id) => authorized(token, true, async actor => {
  const row = await db.getPayrollRecord(id); if (!row || row.staffId !== staffId || row.kind !== 'snapshot') throw auth.problem('Payroll snapshot not found.', 404);
  const saved = vault.open(row); const current = await calculate(staffId, saved.preview); await auth.audit(actor, 'payroll.snapshot_read', staffId);
  return { ...saved, sourceChanged: current.fingerprint !== saved.preview.fingerprint };
});
exports.document = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['id', 'version', 'title', 'category', 'documentDate', 'file', 'reason']); await employee(staffId);
  const id = payload.id || 'document:' + randomUUID(); const old = await db.getPayrollRecord(id);
  if (payload.id && !old) throw auth.problem('Payroll document not found.', 404);
  if (old && (old.staffId !== staffId || old.kind !== 'document')) throw auth.problem('Payroll document not found.', 404);
  expectVersion(payload, old?.version || 0); if (old?.version >= 10) throw auth.problem('Document revision limit reached.', 409);
  const data = old ? vault.open(old) : { revisions: [] }; const file = v.file(payload.file);
  data.title = v.text(payload.title, 'title', 160, { required: true }); data.category = v.text(payload.category, 'category', 80, { required: true });
  data.revisions.push({ revision: (old?.version || 0) + 1, documentDate: time.validateDate(payload.documentDate), filename: file.filename, contentType: file.contentType, byteLength: file.byteLength, sha256: file.sha256, dataBase64: file.content.toString('base64'), reason: reason(payload.reason), ...stamp(actor) });
  await write('document', staffId, data, old?.version || 0, id); await auth.audit(actor, 'payroll.document_upload', id); return { id };
});
exports.content = (token, staffId, id, revision) => authorized(token, true, async actor => {
  const row = await db.getPayrollRecord(id); if (!row || row.staffId !== staffId || row.kind !== 'document') throw auth.problem('Payroll document not found.', 404);
  const data = vault.open(row); const file = data.revisions.find(r => r.revision === Number(revision)); if (!file) throw auth.problem('Revision not found.', 404);
  await auth.audit(actor, 'payroll.document_download', id); return { ...file, content: Buffer.from(file.dataBase64, 'base64') };
});

// Work schedule and review projections are separate from private pay/tax DTOs.
// Existing encrypted record kinds suffice; no new database migration is needed.
async function workSchedule(staffId) {
  const row = await db.getPayrollRecord('profile:work-schedule:' + staffId);
  if (row) return { data: vault.open(row), version: row.version };
  const profile = await read('profile', staffId);
  return { data: { fallbackMinutes: profile.data.rules.dailyScheduledMinutes, entries: [] }, version: 0 };
}
function scheduleEntryOn(schedule, date, legacyOnly = false) {
  return [...schedule.data.entries].filter(entry => entry.effectiveOn <= date && (!legacyOnly || !entry.startTime)).sort((a,b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.sequence-a.sequence)[0];
}
function limitOn(schedule, date, legacyOnly = false) {
  return scheduleEntryOn(schedule, date, legacyOnly)?.minutes ?? schedule.data.fallbackMinutes;
}
async function captureWorkLimits(ledger, staffId, previouslyClocked) {
  ledger.workLimits ||= {}; ledger.workWindows ||= {};
  const schedule = await workSchedule(staffId);
  for (const day of math.daily(ledger)) if (!Object.hasOwn(ledger.workLimits, day.date)) {
    // Old started days keep their duration-only allowance. Never assign new
    // wall-clock times retrospectively to an existing attendance record.
    const oldDay = previouslyClocked.has(day.date);
    ledger.workLimits[day.date] = limitOn(schedule, day.date, oldDay);
    const entry = !oldDay && scheduleEntryOn(schedule, day.date);
    if (entry?.startTime && entry.endTime) ledger.workWindows[day.date] = {
      startTime: entry.startTime, endTime: entry.endTime, timeZone: entry.timeZone,
      effectiveOn: entry.effectiveOn, sequence: entry.sequence,
    };
  }
}
function windowFingerprint(sessions, date, minutes, window) {
  // Preserve the original shape for duration-only records and their decisions.
  return math.hash({ sessions, date, minutes, ...(window ? { window } : {}) });
}
function wallTimeChoices(date, clock, zone) {
  const target = date + 'T' + clock + ':00', guess = Date.parse(target + 'Z'), offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = guess + hours*3600000;
    offsets.add(Date.parse(time.localTime(sample, zone) + 'Z') - sample);
  }
  return [...offsets].map(offset => guess-offset).filter(value => time.localTime(value, zone) === target).sort((a,b) => a-b);
}
function paidIntervals(sessions, bounds) {
  const from = Date.parse(bounds.from), to = Date.parse(bounds.to); const intervals = [];
  for (const session of sessions) {
    let pieces = [[Math.max(Date.parse(session.start),from), Math.min(session.end ? Date.parse(session.end) : Date.now(),to)]];
    // Honor only known historical unpaid intervals; never infer a missing end.
    for (const rest of session.breaks.filter(item => !item.paid && item.end)) {
      const start = Date.parse(rest.start), end = Date.parse(rest.end);
      pieces = pieces.flatMap(([a,b]) => end <= a || start >= b ? [[a,b]] : [[a,Math.min(b,start)],[Math.max(a,end),b]]).filter(([a,b]) => b>a);
    }
    intervals.push(...pieces.filter(([a,b]) => b>a));
  }
  const merged = [];
  for (const [start,end] of intervals.sort((a,b)=>a[0]-b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1],end);
    else merged.push([start,end]);
  }
  return merged;
}
function outsideWindow(sessions, date, zone, window) {
  if (!window) return { earlyMillis:0, lateMillis:0, outsideMillis:0, scheduleIssue:null };
  if (window.timeZone !== zone) return { earlyMillis:0, lateMillis:0, outsideMillis:0, scheduleIssue:'The approved schedule and recorded work use different time zones. Review this day manually.' };
  const starts = wallTimeChoices(date,window.startTime,zone), ends = wallTimeChoices(date,window.endTime,zone);
  if (!starts.length || !ends.length) return { earlyMillis:0, lateMillis:0, outsideMillis:0, scheduleIssue:'An approved clock time does not occur on this date because the clocks changed. Review this day manually.' };
  // Include both repeated occurrences on a fall-back date. This never guesses
  // a deduction or removes recorded work from payroll.
  const start = starts[0], end = ends.at(-1), intervals = paidIntervals(sessions,time.dayBounds(date,zone));
  const earlyMillis = intervals.reduce((sum,[a,b])=>sum+Math.max(0,Math.min(b,start)-a),0);
  const lateMillis = intervals.reduce((sum,[a,b])=>sum+Math.max(0,b-Math.max(a,end)),0);
  return {earlyMillis,lateMillis,outsideMillis:earlyMillis+lateMillis,scheduleIssue:null};
}
async function workRows(staffId, ledger, start, end) {
  const schedule = await workSchedule(staffId);
  return math.daily(ledger.data).filter(day => day.date >= start && day.date <= end).map(day => {
    const sessions = ledger.data.sessions.filter(s => !s.voided && day.sessionIds.includes(s.id));
    const ordered = [...sessions].sort((a,b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id)), first = ordered[0], last = ordered.at(-1);
    const chronological = math.sessionsForDay(ledger.data, day.date), latestEnd = ordered.some(session => !session.end) ? null : ordered.reduce((latest, session) => !latest || Date.parse(session.end) > Date.parse(latest) ? session.end : latest, null);
    const window = ledger.data.workWindows?.[day.date] || null;
    const minutes = ledger.data.workLimits?.[day.date] ?? limitOn(schedule,day.date,true);
    const fingerprint = windowFingerprint(sessions,day.date,minutes,window);
    const decision = ledger.data.workReviews?.[day.date]; const current = decision?.fingerprint === fingerprint ? decision : null;
    const outside = outsideWindow(sessions,day.date,ledger.data.timeZone,window);
    const extraMillis = window ? outside.outsideMillis : Math.max(0,day.paidMillis-minutes*60000);
    const credit = math.scheduledPayCredit(day, { plannedMinutes: minutes, plannedStart: window?.startTime, plannedEnd: window?.endTime, ...outside });
    return { staffId, date: day.date, version: ledger.version, timeZone: ledger.data.timeZone,
      suggestedPaidMillis: credit.suggestedPaidMillis, scheduledCreditMillis: credit.scheduledCreditMillis,
      plannedMinutes: minutes, hasCapturedAllowance: Object.hasOwn(ledger.data.workLimits || {}, day.date) || !!window, plannedStart:window?.startTime || null, plannedEnd:window?.endTime || null,
      scheduleTimeZone:window?.timeZone || ledger.data.timeZone, checkin:first?.start || null, sessions: chronological,
      ...outside, rawMillis: day.rawMillis, paidMillis: day.paidMillis, extraMillis, incomplete: day.incomplete,
      status: day.incomplete ? 'incomplete' : (extraMillis || outside.scheduleIssue) && !current ? 'pending' : current?.decision === 'worked' ? 'confirmed' : current?.decision === 'clock-error' ? 'corrected' : 'within-schedule',
      reason: current?.reason || '', sessionId: last?.id, checkout: latestEnd,
      canCorrect: !outside.scheduleIssue && (!window || !outside.earlyMillis) && ledger.data.timeZone === time.timeZone() && !!last?.end && time.dateAt(last.start, ledger.data.timeZone) === day.date && time.dateAt(last.end, ledger.data.timeZone) === day.date };
  });
}
exports.workTime = (token, { start, end } = {}) => authorized(token, 'manager', async actor => {
  const today = time.dateAt(); start = start === undefined ? time.addDays(today,-60) : time.validateDate(start); end = end === undefined ? today : time.validateDate(end);
  if (end < start || end > time.addDays(start,92)) throw auth.problem('Choose a work-time period of at most 93 days.');
  const people = []; for (let page=1;;page++) { const batch = await db.listStaff({page,pageSize:100}); people.push(...batch); if (batch.length<100) break; }
  const staff = [], items = [], warnings = []; let overtimeReviewCount = 0;
  for (const person of people) {
    const schedule = await workSchedule(person.id), ledger = await read('ledger',person.id);
    staff.push({ id: person.id, name: person.name, active: person.active, scheduleVersion: schedule.version, defaultMinutes: schedule.data.fallbackMinutes, entries: schedule.data.entries });
    const rows = await workRows(person.id,ledger,time.addDays(start,-6),time.addDays(end,6));
    items.push(...rows.filter(row => row.date >= start && row.date <= end).map(row => ({...row,name:person.name})));
    if (actor.role === 'admin') {
      const profile = await read('profile',person.id), days = math.daily(ledger.data), workByDate = new Map(rows.map(row => [row.date,row]));
      warnings.push(...shortDayWarnings(person, rows, profile.data.rules, start, end));
      overtimeReviewCount += days.filter(day => day.date >= start && day.date <= end && !day.incomplete && overtimeReview(day, days, workByDate.get(day.date), profile.data.rules, profile.data.rates).pending).length;
    }
  }
  await auth.audit(actor,'employee_time.review_list');
  return { today, timeZone:time.timeZone(), start, end, staff, items: items.sort((a,b)=>b.date.localeCompare(a.date)||a.name.localeCompare(b.name)),
    ...(actor.role === 'admin' ? { shortDayWarnings: warnings, overtimeReviewCount } : {}) };
});
exports.schedule = (token, staffId, payload) => authorized(token,'manager',async actor => {
  v.object(payload,['version','effectiveOn','approvedHours','startTime','endTime','reason']); await employee(staffId);
  const schedule = await workSchedule(staffId); expectVersion(payload,schedule.version);
  const hasWindow = payload.startTime !== undefined || payload.endTime !== undefined;
  let minutes, window = {};
  if (hasWindow) {
    if (payload.approvedHours !== undefined || typeof payload.startTime !== 'string' || typeof payload.endTime !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.endTime)) throw auth.problem('Enter approved start and end times in HH:mm format without a separate daily-hours value.');
    const asMinutes = value => Number(value.slice(0,2))*60+Number(value.slice(3));
    minutes = asMinutes(payload.endTime)-asMinutes(payload.startTime);
    if (minutes <= 0) throw auth.problem('Choose an approved end after the start on the same day. Overnight schedules are not supported here.');
    window = {startTime:payload.startTime,endTime:payload.endTime,timeZone:time.timeZone()};
  } else {
    minutes = Math.round(payload.approvedHours*60);
    if (typeof payload.approvedHours !== 'number' || !Number.isFinite(payload.approvedHours) || minutes<0 || minutes>1440 || Math.abs(payload.approvedHours*60-minutes)>0.000001) throw auth.problem('Enter daily hours between 0 and 24, to the nearest minute.');
  }
  const effectiveOn = time.validateDate(payload.effectiveOn);
  if (effectiveOn < time.dateAt()) throw auth.problem('Schedule changes apply today or later. Existing clocked days keep their original approved schedule.');
  schedule.data.entries.push({effectiveOn,minutes,...window,sequence:schedule.data.entries.length+1,reason:reason(payload.reason),...stamp(actor)});
  await write('profile',staffId,schedule.data,schedule.version,'profile:work-schedule:'+staffId);
  await auth.audit(actor,'employee_time.schedule_set',staffId); return {saved:true};
});
exports.reviewWork = (token,staffId,payload) => authorized(token,'manager',async actor => {
  v.object(payload,['version','date','decision','reason','workEndedAt','occurrence','noWorkAfterEnd']); await employee(staffId);
  const ledger = await read('ledger',staffId); expectVersion(payload,ledger.version); const date = time.validateDate(payload.date);
  const row = (await workRows(staffId,ledger,date,date))[0]; if (!row || row.incomplete) throw auth.problem('Resolve incomplete clock records before reviewing extra time.',409);
  if (row.status!=='pending') throw auth.problem('This day no longer has pending extra time. Refresh the work-time list.',409);
  if (!['worked','clock-error'].includes(payload.decision)) throw auth.problem('Choose worked time or a verified clock error.');
  const why = reason(payload.reason);
  if (payload.decision==='clock-error') {
    if (!row.canCorrect || payload.noWorkAfterEnd!==true) throw auth.problem('Confirm no work was performed after the corrected time. Overnight changes need administrator review.');
    const session = ledger.data.sessions.find(s=>s.id===row.sessionId); const before = structuredClone(session);
    const finish = time.resolveTime(payload.workEndedAt,payload.occurrence);
    if (Date.parse(finish)>Date.parse(session.end) || Date.parse(finish)>Date.now() || time.dateAt(finish,ledger.data.timeZone)!==date) throw auth.problem('Choose an actual work-end time on this day, no later than the recorded checkout.');
    const next = {...session,end:finish,version:session.version+1}; validateSession(next,ledger.data.sessions);
    ledger.data.history.push({type:'clock-error-review',before,after:structuredClone(next),reason:why,...stamp(actor)});
    invalidate(ledger.data,[before,next]); Object.assign(session,next);
    const updated = (await workRows(staffId,ledger,date,date))[0];
    if (updated.extraMillis || updated.scheduleIssue) throw auth.problem('The corrected day still has time outside its approved schedule. Confirm actual work or use administrator review.');
  }
  const day = math.daily(ledger.data).find(d=>d.date===date); const sessions=ledger.data.sessions.filter(s=>!s.voided&&day.sessionIds.includes(s.id));
  ledger.data.workReviews ||= {};
  const decision = {decision:payload.decision,reason:why,fingerprint:windowFingerprint(sessions,date,row.plannedMinutes,ledger.data.workWindows?.[date]),...stamp(actor)};
  ledger.data.history.push({type:'extra-time-review',date,after:decision,...stamp(actor)}); ledger.data.workReviews[date]=decision;
  await write('ledger',staffId,ledger.data,ledger.version); await auth.audit(actor,'employee_time.'+payload.decision.replace('-','_'),staffId); return {saved:true};
});
