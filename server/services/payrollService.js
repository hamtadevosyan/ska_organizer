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
function maskedProfile(data) {
  const result = structuredClone(data); delete result.history;
  for (const key of ['taxId', 'bankAccount', 'routingNumber']) result[key] = data[key] ? '••••' + data[key].slice(-4) : '';
  return result;
}
exports.own = token => authorized(token, false, async actor => {
  if (!actor.staffMemberId) throw auth.problem('Ask an administrator to link your account to your active staff record.', 403, 'STAFF_LINK_REQUIRED');
  const staff = await employee(actor.staffMemberId); if (!staff.active) throw auth.problem('Your staff record is inactive.', 403);
  const ledger = await read('ledger', staff.id);
  const open = ledger.data.sessions.find(session => !session.voided && !session.end);
  return { staff: { id: staff.id, name: staff.name }, version: ledger.version, timeZone: ledger.data.timeZone,
    checkedIn: !!open, needsReview: false };
});
exports.clock = (token, payload) => authorized(token, false, async actor => {
  v.object(payload, ['action', 'requestId', 'version']);
  if (!['checkin', 'checkout'].includes(payload.action)) throw auth.problem('Use check in or check out. A manager handles time corrections.');
  const requestId = v.requestId(payload.requestId);
  if (!actor.staffMemberId) throw auth.problem('An active linked staff identity is required.', 403);
  const staff = await employee(actor.staffMemberId); if (!staff.active) throw auth.problem('Staff record is inactive.', 403);
  const ledger = await read('ledger', staff.id); const data = ledger.data;
  const replay = data.requests.find(r => r.id === requestId);
  if (replay) { if (replay.action !== payload.action) throw auth.problem('Request identifier was already used for another action.', 409); return { replayed: true }; }
  expectVersion(payload, ledger.version);
  const open = data.sessions.find(s => !s.voided && !s.end); const now = new Date().toISOString();
  if (payload.action === 'checkin') {
    if (open) throw auth.problem('You are already checked in.', 409);
    if (data.sessions.length >= 20000) throw auth.problem('Time ledger requires archival before adding more entries.', 409);
    const next = { id: randomUUID(), start: now, end: null, original: { start: now, end: null }, breaks: [], ...stamp(actor), version: 1 };
    validateSession(next, data.sessions); data.sessions.push(next);
  } else {
    if (!open) throw auth.problem('Check in before recording a departure.', 409);
    open.end = now; if (!open.original.end) open.original.end = now;
    open.version++; validateSession(open, data.sessions);
  }
  invalidate(data, [payload.action === 'checkin' ? data.sessions.at(-1) : open]); data.requests.push({ id: requestId, action: payload.action });
  if (data.requests.length > 20000) throw auth.problem('Time ledger requires archival.', 409);
  data.history.push({ type: payload.action, sessionId: (payload.action === 'checkin' ? data.sessions.at(-1) : open).id, requestId, ...stamp(actor) });
  await captureWorkLimits(data, staff.id);
  await write('ledger', staff.id, data, ledger.version); await auth.audit(actor, 'employee_clock.' + payload.action.replace('-', '_'), staff.id);
  return { replayed: false };
});
exports.get = (token, staffId) => authorized(token, true, async actor => {
  const staff = await employee(staffId);
  // authorized() holds one transaction/client. Finish each query before
  // issuing the next; pg does not support concurrent queries on that client.
  const profile = await read('profile', staffId), ledger = await read('ledger', staffId);
  const docs = await db.listPayrollRecords(staffId, 'document'), snapshots = await db.listPayrollRecords(staffId, 'snapshot');
  await auth.audit(actor, 'payroll.view', staffId);
  const documents = docs.map(row => { const d = vault.open(row); return { id: row.id, version: row.version, title: d.title, category: d.category,
    revisions: d.revisions.map(({ dataBase64, ...r }) => r) }; });
  return { staff: { id: staff.id, name: staff.name, active: staff.active }, profile: { ...maskedProfile(profile.data), version: profile.version },
    ledger: ledgerDto(ledger), documents, missingDocuments: profile.data.requiredDocuments.filter(name => !documents.some(d => d.title.toLowerCase() === name.toLowerCase())),
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
  v.object(payload, ['version', 'sessionId', 'start', 'end', 'breaks', 'voided', 'reason']); await employee(staffId);
  const ledger = await read('ledger', staffId); expectVersion(payload, ledger.version); const old = ledger.data.sessions.find(s => s.id === payload.sessionId);
  if (!old) throw auth.problem('Time session not found.', 404);
  if (payload.breaks !== undefined && (!Array.isArray(payload.breaks) || payload.breaks.length > 30) || typeof payload.voided !== 'boolean') throw auth.problem('Supply valid time records and record status.');
  const next = { ...old, start: instant(payload.start), end: payload.end === null ? null : instant(payload.end), voided: payload.voided,
    breaks: payload.breaks === undefined ? structuredClone(old.breaks) : payload.breaks.map(b => { v.object(b, ['start', 'end', 'paid']); return { start: instant(b.start), end: b.end === null ? null : instant(b.end), paid: b.paid }; }), version: old.version + 1 };
  if (!next.voided) validateSession(next, ledger.data.sessions);
  ledger.data.history.push({ type: 'correction', before: structuredClone(old), after: structuredClone(next), reason: reason(payload.reason), ...stamp(actor) });
  invalidate(ledger.data, [old, next]); Object.assign(old, next); await write('ledger', staffId, ledger.data, ledger.version); await auth.audit(actor, 'employee_clock.correct', staffId); return { saved: true };
});
exports.approve = (token, staffId, payload) => authorized(token, true, async actor => {
  v.object(payload, ['version', 'date', 'status', 'regularMillis', 'overtimeMillis', 'doubleMillis', 'adjustmentCents', 'rulesReviewed', 'reason']); await employee(staffId);
  const ledger = await read('ledger', staffId); expectVersion(payload, ledger.version); const date = time.validateDate(payload.date);
  const day = math.daily(ledger.data).find(row => row.date === date); if (!day) throw auth.problem('No time records exist on this day.', 404);
  if (!['approved', 'returned'].includes(payload.status) || typeof payload.rulesReviewed !== 'boolean') throw auth.problem('Choose approved or returned and confirm the daily rule review.');
  if (payload.status === 'approved' && day.incomplete) throw auth.problem('Record the missing checkout before approving.', 409);
  const profile = await read('profile', staffId);
  const approval = { rulesFingerprint: math.hash(profile.data.rules), date, status: payload.status, regularMillis: integer(payload.regularMillis, 48 * 3600000), overtimeMillis: integer(payload.overtimeMillis, 48 * 3600000), doubleMillis: integer(payload.doubleMillis, 48 * 3600000),
    adjustmentCents: payload.adjustmentCents, rulesReviewed: payload.rulesReviewed, reason: reason(payload.reason), ...stamp(actor) };
  if (!Number.isSafeInteger(approval.adjustmentCents) || Math.abs(approval.adjustmentCents) > 100000000 || approval.regularMillis + approval.overtimeMillis + approval.doubleMillis > 48 * 3600000) throw auth.problem('Approved time or adjustment is outside the supported range.');
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
function limitOn(schedule, date) {
  return [...schedule.data.entries].filter(entry => entry.effectiveOn <= date).sort((a,b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.sequence-a.sequence)[0]?.minutes ?? schedule.data.fallbackMinutes;
}
async function captureWorkLimits(ledger, staffId) {
  ledger.workLimits ||= {};
  const schedule = await workSchedule(staffId);
  for (const day of math.daily(ledger)) if (!Object.hasOwn(ledger.workLimits, day.date)) ledger.workLimits[day.date] = limitOn(schedule, day.date);
}
async function workRows(staffId, ledger, start, end) {
  const schedule = await workSchedule(staffId);
  return math.daily(ledger.data).filter(day => day.date >= start && day.date <= end).map(day => {
    const sessions = ledger.data.sessions.filter(s => !s.voided && day.sessionIds.includes(s.id));
    const last = [...sessions].sort((a,b) => b.start.localeCompare(a.start))[0];
    const minutes = ledger.data.workLimits?.[day.date] ?? limitOn(schedule, day.date);
    const fingerprint = math.hash({ sessions, date: day.date, minutes });
    const decision = ledger.data.workReviews?.[day.date]; const current = decision?.fingerprint === fingerprint ? decision : null;
    const extraMillis = Math.max(0, day.paidMillis - minutes*60000);
    return { staffId, date: day.date, version: ledger.version, timeZone: ledger.data.timeZone,
      plannedMinutes: minutes, rawMillis: day.rawMillis, paidMillis: day.paidMillis, extraMillis, incomplete: day.incomplete,
      status: day.incomplete ? 'incomplete' : extraMillis && !current ? 'pending' : current?.decision === 'worked' ? 'confirmed' : current?.decision === 'clock-error' ? 'corrected' : 'within-schedule',
      reason: current?.reason || '', sessionId: last?.id, checkout: last?.end || null,
      canCorrect: ledger.data.timeZone === time.timeZone() && !!last?.end && time.dateAt(last.start, ledger.data.timeZone) === day.date && time.dateAt(last.end, ledger.data.timeZone) === day.date };
  });
}
exports.workTime = (token, { start, end } = {}) => authorized(token, 'manager', async actor => {
  const today = time.dateAt(); start = start === undefined ? time.addDays(today,-60) : time.validateDate(start); end = end === undefined ? today : time.validateDate(end);
  if (end < start || end > time.addDays(start,92)) throw auth.problem('Choose a work-time period of at most 93 days.');
  const people = []; for (let page=1;;page++) { const batch = await db.listStaff({page,pageSize:100}); people.push(...batch); if (batch.length<100) break; }
  const staff = [], items = [];
  for (const person of people) {
    const schedule = await workSchedule(person.id), ledger = await read('ledger',person.id);
    staff.push({ id: person.id, name: person.name, active: person.active, scheduleVersion: schedule.version, defaultMinutes: schedule.data.fallbackMinutes, entries: schedule.data.entries });
    items.push(...(await workRows(person.id,ledger,start,end)).map(row => ({...row,name:person.name})));
  }
  await auth.audit(actor,'employee_time.review_list');
  return { today, timeZone:time.timeZone(), start, end, staff, items: items.sort((a,b)=>b.date.localeCompare(a.date)||a.name.localeCompare(b.name)) };
});
exports.schedule = (token, staffId, payload) => authorized(token,'manager',async actor => {
  v.object(payload,['version','effectiveOn','approvedHours','reason']); await employee(staffId);
  const schedule = await workSchedule(staffId); expectVersion(payload,schedule.version);
  const minutes = Math.round(payload.approvedHours*60);
  if (typeof payload.approvedHours !== 'number' || !Number.isFinite(payload.approvedHours) || minutes<0 || minutes>1440 || Math.abs(payload.approvedHours*60-minutes)>0.000001) throw auth.problem('Enter daily hours between 0 and 24, to the nearest minute.');
  const effectiveOn = time.validateDate(payload.effectiveOn);
  if (effectiveOn < time.dateAt()) throw auth.problem('Schedule changes apply today or later. Existing clocked days keep their original daily limit.');
  schedule.data.entries.push({effectiveOn,minutes,sequence:schedule.data.entries.length+1,reason:reason(payload.reason),...stamp(actor)});
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
    if (updated.extraMillis) throw auth.problem('The corrected day still exceeds its daily limit. Confirm actual extra work or use administrator review.');
  }
  const day = math.daily(ledger.data).find(d=>d.date===date); const sessions=ledger.data.sessions.filter(s=>!s.voided&&day.sessionIds.includes(s.id));
  ledger.data.workReviews ||= {};
  const decision = {decision:payload.decision,reason:why,fingerprint:math.hash({sessions,date,minutes:row.plannedMinutes}),...stamp(actor)};
  ledger.data.history.push({type:'extra-time-review',date,after:decision,...stamp(actor)}); ledger.data.workReviews[date]=decision;
  await write('ledger',staffId,ledger.data,ledger.version); await auth.audit(actor,'employee_time.'+payload.decision.replace('-','_'),staffId); return {saved:true};
});
