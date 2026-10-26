const { randomUUID, createHash } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const time = require('./facilityTime');
const v = require('./childDocumentValidation');
const math = require('./billingMath');
const empty = () => ({ profile: null, charges: [], payments: [], history: [], requests: [] });
const stamp = actor => ({ actorId: actor.id, actorName: actor.id ? actor.displayName || actor.username : 'Automatic monthly billing', at: new Date().toISOString() });
const profileSettings = profile => profile ? Object.fromEntries(['billingStart', 'billingEnd', 'enabled', 'registrationCents', 'effectiveMonth', 'monthlyCents', 'ccrcManaged', 'familyCents', 'ccrcCents', 'familyDueDay', 'ccrcDueDay', 'pausedForEnrollment', 'pausedOn'].filter(key => Object.hasOwn(profile, key)).map(key => [key, profile[key]])) : null;
const nameOf = child => [child.firstName, child.lastName].filter(Boolean).join(' ') || child.name || child.id;
const childDto = child => ({ id: child.id, name: nameOf(child), active: child.active !== false });
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = (type, payload) => createHash('sha256').update(JSON.stringify([type, canonical(Object.fromEntries(Object.entries(payload).filter(([key]) => !['version', 'requestId'].includes(key))))])).digest('hex');
const reason = value => v.text(value, 'reason', 1000, { required: true });
const date = (value, field = 'date') => { try { return time.validateDate(value); } catch { throw math.invalid('Choose a real calendar date.', field); } };
const payerOf = value => { if (!math.payers.includes(value)) throw math.invalid('Choose Family or CCRC as the payer.', 'payer'); return value; };
const positive = value => { math.cents(value, 'amountCents'); if (!value) throw math.invalid('Enter a positive amount.', 'amountCents'); return value; };
async function administrator(token) {
  const actor = await auth.sessionAccount(token, { touch: true });
  auth.operationalPermission(actor, false);
  if (actor.role !== 'admin') throw auth.problem('Administrator billing access is required.', 403, 'FORBIDDEN');
  return actor;
}
async function childById(id) { v.identifier(id, 'child'); const child = await db.getChildById(id); if (!child) throw auth.problem('Child not found.', 404); return child; }
async function read(id) { return await db.getChildBillingRecord(id) || { childId: id, version: 0, data: empty() }; }
const view = (child, row, today = time.dateAt()) => {
  const charges = row.data.charges.map(charge => math.chargeView(charge, row.data.payments, today));
  const payments = row.data.payments.map(math.paymentView);
  return { child: childDto(child), version: row.version, today, timeZone: time.timeZone(), profile: row.data.profile, charges, payments, history: row.data.history, totals: math.totals(charges, payments), pendingMonthlyCharges: missingMonths(row.data, child, today.slice(0, 7)).length };
};
function history(data, type, actor, details = {}) { data.history.push({ id: randomUUID(), type, ...stamp(actor), ...details }); }
async function write(row, actor, action) {
  if (row.data.requests.length > 20000 || row.data.charges.length > 20000 || row.data.payments.length > 20000) throw auth.problem('This billing history needs archival before adding more records.', 409, 'BILLING_CAPACITY');
  const saved = await db.saveChildBillingRecord({ ...row, version: row.version + 1 }, row.version);
  await auth.audit(actor, 'billing.' + action, row.childId);
  return saved;
}
function missingMonths(data, child, throughMonth) {
  const profile = data.profile;
  if (!profile?.enabled || child.active === false || profile.billingStart > time.dateAt()) return [];
  const last = [throughMonth, time.dateAt().slice(0, 7), profile.billingEnd?.slice(0, 7)].filter(Boolean).sort()[0];
  let period = profile.billingStart.slice(0, 7); const missing = [], existing = new Set(data.charges.map(row => row.id));
  while (period <= last) {
    const rate = profile.rates.filter(row => row.effectiveMonth <= period).sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth)).at(-1);
    if (rate && !existing.has('monthly:' + period)) missing.push({ period, rate });
    period = math.nextMonth(period);
  }
  return missing;
}
function generate(data, child, throughMonth, actor) {
  const missing = missingMonths(data, child, throughMonth);
  if (missing.length > 120) throw math.invalid('Generate no more than 120 missing months at a time. Choose an earlier through month first.', 'throughMonth');
  for (const { period, rate } of missing) {
      const charge = { id: 'monthly:' + period, kind: 'monthly', month: period, title: 'Tuition · ' + period, createdAt: new Date().toISOString(),
        payers: Object.fromEntries(math.payers.map(payer => [payer, { amountCents: Object.hasOwn(rate, 'monthlyCents') ? (payer === 'family' ? rate.monthlyCents : 0) : rate[payer + 'Cents'], dueDate: math.dueDate(period, rate[payer + 'DueDay'] || rate.familyDueDay) }])), adjustments: [],
        ...(rate.ccrcManaged ? { settlementMode: 'ccrc_actual', tuitionCents: rate.monthlyCents, ccrcReview: null } : {}) };
      data.charges.push(charge); history(data, 'monthly_charge', actor, { chargeId: charge.id, month: period });
  }
  return missing.length;
}
async function mutate(token, childId, type, payload, keys, change) {
  return db.withAuthLock(async () => {
    const actor = await administrator(token), child = await childById(childId), row = await read(childId);
    v.object(payload, ['version', 'requestId', ...keys], 'billing');
    const requestId = v.requestId(payload.requestId), hash = fingerprint(type, payload);
    const prior = row.data.requests.find(request => request.id === requestId);
    if (prior) {
      if (prior.fingerprint !== hash) throw auth.problem('This request identifier was already used for different billing details.', 409, 'BILLING_REQUEST_CONFLICT');
      return view(child, row);
    }
    if (!Number.isSafeInteger(payload.version) || payload.version !== row.version) throw auth.problem('This billing record changed. Refresh before saving.', 409, 'BILLING_CONFLICT');
    await change(row.data, actor, child);
    row.data.requests.push({ id: requestId, fingerprint: hash });
    return view(child, await write(row, actor, type));
  });
}
exports.get = (token, childId) => db.withAuthLock(async () => {
  const actor = await administrator(token), child = await childById(childId), row = await read(childId);
  await auth.audit(actor, 'billing.view', childId); return view(child, row);
});
async function children() {
  const rows = [];
  for (let page = 1;; page++) { const batch = await db.listChildren({ page, pageSize: 100 }); rows.push(...batch); if (batch.length < 100) return rows; }
}
exports.summary = token => db.withAuthLock(async () => {
  const actor = await administrator(token), records = new Map((await db.listChildBillingRecords()).map(row => [row.childId, row]));
  const today = time.dateAt(), list = (await children()).map(child => {
    const detail = view(child, records.get(child.id) || { version: 0, data: empty() }, today);
    return { child: detail.child, version: detail.version, profile: detail.profile, totals: detail.totals, pendingMonthlyCharges: detail.pendingMonthlyCharges,
      overdueCount: detail.charges.reduce((sum, charge) => sum + math.payers.filter(payer => charge.payers[payer].overdue).length, 0) };
  });
  const totals = math.emptyTotals();
  for (const child of list) for (const key of Object.keys(totals)) {
    totals[key] += child.totals[key];
    if (!Number.isSafeInteger(totals[key])) throw new Error('Invalid billing aggregate arithmetic.');
  }
  await auth.audit(actor, 'billing.summary'); return { today, timeZone: time.timeZone(), children: list, totals };
});
exports.alerts = token => db.withAuthLock(async () => {
  const actor = await administrator(token), today = time.dateAt(), items = []; let pendingMonthlyCharges = 0, awaitingCcrcCount = 0, awaitingCcrcCents = 0;
  for (const row of await db.listChildBillingRecords()) {
    const child = await db.getChildById(row.childId); if (!child) continue;
    pendingMonthlyCharges += missingMonths(row.data, child, today.slice(0, 7)).length;
    for (const charge of row.data.charges.map(value => math.chargeView(value, row.data.payments, today))) {
      if (charge.pendingCcrc) { awaitingCcrcCount++; awaitingCcrcCents += charge.outstandingCents; }
      for (const payer of math.payers) {
      const amount = charge.payers[payer];
      if (amount.overdue) items.push({ id: encodeURIComponent(child.id) + ':' + encodeURIComponent(charge.id) + ':' + payer,
        childId: child.id, childName: nameOf(child), payer, chargeId: charge.id, title: charge.title, dueDate: amount.dueDate,
        daysOverdue: amount.daysOverdue, outstandingCents: amount.outstandingCents });
      }
    }
  }
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  await auth.audit(actor, 'billing.alerts');
  const totalOutstandingCents = items.reduce((sum, row) => sum + row.outstandingCents, 0);
  if (![totalOutstandingCents, awaitingCcrcCents].every(Number.isSafeInteger)) throw new Error('Invalid billing aggregate arithmetic.');
  return { today, timeZone: time.timeZone(), items, count: items.length, totalOutstandingCents, pendingMonthlyCharges, awaitingCcrcCount, awaitingCcrcCents };
});
exports.profile = (token, childId, payload) => mutate(token, childId, 'profile', payload,
  ['billingStart', 'billingEnd', 'effectiveMonth', 'monthlyCents', 'ccrcManaged', 'familyCents', 'ccrcCents', 'familyDueDay', 'ccrcDueDay', 'registrationCents', 'enabled', 'reason'], (data, actor, child) => {
    const start = date(payload.billingStart, 'billingStart'), end = payload.billingEnd == null || payload.billingEnd === '' ? null : date(payload.billingEnd, 'billingEnd');
    if (end && end < start) throw math.invalid('Billing end must be on or after billing start.', 'billingEnd');
    if (typeof payload.enabled !== 'boolean') throw math.invalid('Choose whether monthly billing is enabled.', 'enabled');
    if (payload.enabled && child.active === false) throw math.invalid('Reactivate enrollment before enabling monthly billing. Historical records remain available while billing is paused.', 'enabled');
    if (payload.enabled && data.profile?.pausedForEnrollment && start < data.profile.pausedOn) throw math.invalid('Choose the new enrollment billing start date before resuming. It cannot precede the date billing was paused.', 'billingStart');
    const effectiveMonth = math.month(payload.effectiveMonth, 'effectiveMonth');
    if (!data.profile && effectiveMonth > start.slice(0, 7)) throw math.invalid('The first rate must cover the billing start month.', 'effectiveMonth');
    const rate = { effectiveMonth, ...stamp(actor) };
    if (Object.hasOwn(payload, 'monthlyCents')) {
      if (['familyCents', 'ccrcCents', 'ccrcDueDay'].some(key => Object.hasOwn(payload, key))) throw math.invalid('Set one monthly tuition amount rather than a fixed CCRC share.', 'monthlyCents');
      rate.monthlyCents = math.cents(payload.monthlyCents, 'monthlyCents');
      if (typeof payload.ccrcManaged !== 'boolean') throw math.invalid('Choose whether this child receives CCRC payments.', 'ccrcManaged');
      rate.ccrcManaged = payload.ccrcManaged;
      if (!Number.isInteger(payload.familyDueDay) || payload.familyDueDay < 1 || payload.familyDueDay > 31) throw math.invalid('Choose a due day from 1 to 31.', 'familyDueDay');
      rate.familyDueDay = payload.familyDueDay;
    } else {
      if (Object.hasOwn(payload, 'ccrcManaged')) throw math.invalid('Set one monthly tuition amount for this child.', 'monthlyCents');
      for (const payer of math.payers) {
        rate[payer + 'Cents'] = math.cents(payload[payer + 'Cents'], payer + 'Cents');
        const dueDay = payload[payer + 'DueDay'];
        if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw math.invalid('Choose a due day from 1 to 31.', payer + 'DueDay');
        rate[payer + 'DueDay'] = dueDay;
      }
    }
    const rates = [...(data.profile?.rates || []), rate];
    if (!rates.some(value => value.effectiveMonth <= start.slice(0, 7))) throw math.invalid('A saved rate must cover the billing start month.', 'billingStart');
    const before = profileSettings(data.profile);
    data.profile = { enabled: payload.enabled, billingStart: start, billingEnd: end, registrationCents: math.cents(payload.registrationCents, 'registrationCents'), ...rate, rates,
      ...(data.profile?.pausedForEnrollment ? { pausedForEnrollment: !payload.enabled, pausedOn: data.profile.pausedOn } : {}) };
    history(data, 'profile', actor, { effectiveMonth, reason: v.text(payload.reason, 'reason', 1000), before, after: profileSettings(data.profile) });
    generate(data, child, time.dateAt().slice(0, 7), actor);
  });
exports.generate = (token, childId, payload) => mutate(token, childId, 'generate', payload, ['throughMonth'], (data, actor, child) => {
  const period = math.month(payload.throughMonth, 'throughMonth');
  if (period > time.dateAt().slice(0, 7)) throw math.invalid('Generate through the current month or an earlier month.', 'throughMonth');
  if (!data.profile) throw math.invalid('Set up monthly tuition first.', 'profile');
  generate(data, child, period, actor);
});
exports.charge = (token, childId, payload) => mutate(token, childId, 'charge', payload,
  ['kind', 'title', 'familyCents', 'ccrcCents', 'familyDueDate', 'ccrcDueDate', 'reason', 'confirmAdditionalRegistration'], (data, actor) => {
    if (!['registration', 'manual'].includes(payload.kind)) throw math.invalid('Choose a registration fee or manual charge.', 'kind');
    if (payload.kind === 'registration' && data.charges.some(charge => charge.kind === 'registration') && payload.confirmAdditionalRegistration !== true) throw auth.problem('A registration fee is already recorded. Confirm an additional registration charge explicitly.', 409, 'BILLING_REGISTRATION_EXISTS');
    const charge = { id: randomUUID(), kind: payload.kind, month: null, title: v.text(payload.title, 'title', 160, { fallback: payload.kind === 'registration' ? 'Registration fee' : '', required: true }),
      createdAt: new Date().toISOString(), payers: {}, adjustments: [] };
    for (const payer of math.payers) charge.payers[payer] = { amountCents: math.cents(payload[payer + 'Cents'], payer + 'Cents'), dueDate: date(payload[payer + 'DueDate'], payer + 'DueDate') };
    if (payload.kind === 'manual' && !charge.payers.family.amountCents && !charge.payers.ccrc.amountCents) throw math.invalid('A manual charge must have a positive amount.', 'amountCents');
    data.charges.push(charge); history(data, 'charge', actor, { chargeId: charge.id, reason: reason(payload.reason) });
  });
function reopenCcrcReview(data, charge, actor, cause) {
  if (charge.settlementMode !== 'ccrc_actual' || !charge.ccrcReview) return;
  history(data, 'ccrc_review_reopened', actor, { chargeId: charge.id, before: charge.ccrcReview, reason: cause });
  charge.ccrcReview = null;
}
exports.ccrcMode = (token, childId, chargeId, payload) => mutate(token, childId, 'ccrc_mode:' + chargeId, payload, ['reason'], (data, actor) => {
  const charge = data.charges.find(row => row.id === chargeId);
  if (!charge || charge.kind !== 'monthly' || charge.settlementMode === 'ccrc_actual') throw math.invalid('Choose a monthly tuition charge that still uses fixed payer shares.', 'chargeId');
  const before = math.chargeView(charge, data.payments, time.dateAt());
  const conversionReason = reason(payload.reason);
  charge.settlementMode = 'ccrc_actual';
  charge.tuitionCents = math.payers.reduce((sum, payer) => sum + charge.payers[payer].amountCents, 0);
  charge.ccrcReview = null;
  charge.ccrcConversion = { reason: conversionReason, ...stamp(actor) };
  const after = math.chargeView(charge, data.payments, time.dateAt());
  if (before.amountCents !== after.amountCents || before.paidCents !== after.paidCents) throw new Error('Invalid billing conversion arithmetic.');
  history(data, 'ccrc_mode', actor, { chargeId: charge.id, reason: conversionReason, before: { amountCents: before.amountCents, payers: before.payers }, after: { settlementMode: charge.settlementMode, amountCents: after.amountCents } });
});
exports.ccrcReview = (token, childId, chargeId, payload) => mutate(token, childId, 'ccrc_review:' + chargeId, payload, ['familyDueDate', 'reason', 'acknowledgeUnappliedCredit'], (data, actor) => {
  const charge = data.charges.find(row => row.id === chargeId);
  if (!charge || charge.settlementMode !== 'ccrc_actual') throw math.invalid('Choose a monthly tuition charge that uses actual CCRC payments.', 'chargeId');
  const familyDueDate = date(payload.familyDueDate, 'familyDueDate');
  if (familyDueDate < time.dateAt()) throw math.invalid('Choose today or a future parent due date after reviewing CCRC payments.', 'familyDueDate');
  const before = charge.ccrcReview || null;
  const current = math.chargeView(charge, data.payments, time.dateAt());
  if (current.ccrcUnappliedCents > 0 && payload.acknowledgeUnappliedCredit !== true) throw math.invalid('Review and acknowledge the unapplied CCRC credit before confirming this parent balance. No parent refund or transfer is performed automatically.', 'acknowledgeUnappliedCredit');
  charge.ccrcReview = { familyDueDate, reason: reason(payload.reason), ccrcPaidCents: current.payers.ccrc.paidCents, ccrcUnappliedCents: current.ccrcUnappliedCents, acknowledgeUnappliedCredit: payload.acknowledgeUnappliedCredit === true, ...stamp(actor) };
  history(data, 'ccrc_review', actor, { chargeId: charge.id, reason: charge.ccrcReview.reason, before, after: charge.ccrcReview });
});
exports.payment = (token, childId, payload) => mutate(token, childId, 'payment', payload,
  ['payer', 'amountCents', 'date', 'method', 'reference', 'chargeId'], (data, actor) => {
    const payer = payerOf(payload.payer), amountCents = positive(payload.amountCents), paidDate = date(payload.date);
    if (paidDate > time.dateAt()) throw math.invalid('A recorded payment cannot be dated in the future.', 'date');
    const payment = { id: randomUUID(), payer, amountCents, date: paidDate, method: v.text(payload.method, 'method', 80), reference: v.text(payload.reference, 'reference', 160),
      ...stamp(actor), reversed: false, allocations: [] };
    if (payload.chargeId != null && payload.chargeId !== '') {
      const charge = data.charges.find(value => value.id === payload.chargeId);
      if (!charge) throw math.invalid('Choose an existing charge for this child.', 'chargeId');
      const outstanding = math.chargeView(charge, data.payments, time.dateAt()).allocationCapacityCents[payer];
      const actualCcrc = payer === 'ccrc' && charge.settlementMode === 'ccrc_actual';
      if (outstanding <= 0 && !actualCcrc) throw math.invalid('This payer has no outstanding amount on that charge.', 'chargeId');
      if (actualCcrc) { payment.serviceChargeId = charge.id; payment.serviceMonth = charge.month; }
      if (outstanding > 0) payment.allocations.push({ chargeId: charge.id, amountCents: Math.min(amountCents, outstanding), ...stamp(actor) });
      if (payer === 'ccrc') reopenCcrcReview(data, charge, actor, 'An additional CCRC receipt changed this service month. Review the parent balance again.');
    }
    data.payments.push(payment); history(data, 'payment', actor, { paymentId: payment.id });
  });
exports.credit = (token, childId, payload) => mutate(token, childId, 'credit', payload, ['paymentId', 'chargeId', 'amountCents'], (data, actor) => {
  const payment = data.payments.find(row => row.id === payload.paymentId && !row.reversed), charge = data.charges.find(row => row.id === payload.chargeId), amount = positive(payload.amountCents);
  if (!payment || !charge) throw math.invalid('Choose an available payment credit and a charge for this child.', 'paymentId');
  if (amount > math.paymentView(payment).creditCents) throw math.invalid('The amount exceeds this payment credit.', 'amountCents');
  if (amount > math.chargeView(charge, data.payments, time.dateAt()).allocationCapacityCents[payment.payer]) throw math.invalid('The credit exceeds this payer’s outstanding amount on the charge.', 'amountCents');
  if (payment.payer === 'ccrc') {
    reopenCcrcReview(data, charge, actor, 'A CCRC credit allocation changed this service month. Review the parent balance again.');
    const source = data.charges.find(row => row.id === payment.serviceChargeId);
    if (source) reopenCcrcReview(data, source, actor, 'Unapplied CCRC credit from this service month was allocated. Review the receipt reconciliation again.');
  }
  payment.allocations.push({ chargeId: charge.id, amountCents: amount, ...stamp(actor) }); history(data, 'credit', actor, { paymentId: payment.id, chargeId: charge.id });
});
exports.reverse = (token, childId, paymentId, payload) => mutate(token, childId, 'reverse:' + paymentId, payload, ['reason'], (data, actor) => {
  const payment = data.payments.find(row => row.id === paymentId);
  if (!payment || payment.reversed) throw math.invalid('Choose an unreversed payment.', 'paymentId');
  if (payment.payer === 'ccrc') for (const affectedId of new Set([payment.serviceChargeId, ...payment.allocations.map(row => row.chargeId)].filter(Boolean))) {
    const charge = data.charges.find(row => row.id === affectedId);
    if (charge) reopenCcrcReview(data, charge, actor, 'A CCRC receipt was reversed. Review the parent balance again.');
  }
  payment.reversed = true; payment.reverseReason = reason(payload.reason); payment.reversedAt = new Date().toISOString(); payment.reversedBy = actor.id;
  history(data, 'payment_reversal', actor, { paymentId: payment.id, reason: payment.reverseReason });
});
exports.adjust = (token, childId, chargeId, payload) => mutate(token, childId, 'adjust:' + chargeId, payload, ['payer', 'amountCents', 'dueDate', 'reason'], (data, actor) => {
  const charge = data.charges.find(row => row.id === chargeId); if (!charge) throw math.invalid('Choose a charge for this child.', 'chargeId');
  const payer = payerOf(payload.payer), amount = math.cents(payload.amountCents, 'amountCents', true), current = math.chargeView(charge, data.payments, time.dateAt()).payers[payer];
  if (charge.settlementMode === 'ccrc_actual') {
    if (payer !== 'family') throw math.invalid('Adjust the total tuition amount; CCRC amounts come from actual payment receipts.', 'payer');
    if (payload.dueDate !== undefined) throw math.invalid('Set the parent due date by reviewing CCRC payments.', 'dueDate');
    const currentCharge = math.chargeView(charge, data.payments, time.dateAt());
    if (currentCharge.amountCents + amount < currentCharge.paidCents) throw math.invalid('Reverse allocated payments before reducing tuition below the total already applied.', 'amountCents');
  }
  if (current.amountCents + amount < current.paidCents) throw math.invalid('Reverse allocated payments before reducing a charge below the amount already applied.', 'amountCents');
  const dueDate = payload.dueDate === undefined ? undefined : date(payload.dueDate, 'dueDate');
  if (!amount && !dueDate) throw math.invalid('Enter an adjustment or corrected due date.', 'amountCents');
  const change = { id: randomUUID(), payer, amountCents: amount, ...(dueDate ? { dueDate } : {}), reason: reason(payload.reason), ...stamp(actor) };
  reopenCcrcReview(data, charge, actor, 'The tuition total changed. Review the parent balance again.');
  charge.adjustments.push(change); history(data, 'adjustment', actor, { chargeId: charge.id, adjustmentId: change.id, reason: change.reason });
});
// Trusted composition from the already authorized enrollment mutation. The
// caller's outer transaction covers the child change, billing pause and audits.
// Nothing financial is returned to ordinary operational child controllers.
exports.pauseForEnrollment = (childId, actor) => db.withAuthLock(async () => {
  const row = await db.getChildBillingRecord(childId);
  if (!row?.data.profile || row.data.profile.pausedForEnrollment) return;
  const responsible = actor || { id: null, username: 'enrollment-update' };
  const before = profileSettings(row.data.profile);
  row.data.profile = { ...row.data.profile, enabled: false, pausedForEnrollment: true, pausedOn: time.dateAt() };
  history(row.data, 'enrollment_billing_pause', responsible, { reason: 'Enrollment ended. Monthly billing requires an explicit reviewed restart.', before, after: profileSettings(row.data.profile) });
  await write(row, responsible, 'enrollment_pause');
});
exports.runMaintenance = async () => {
  const actor = { id: null, username: 'billing-scheduler' }, today = time.dateAt(); let generated = 0, failed = 0;
  const records = await db.withAuthLock(() => db.listChildBillingRecords());
  for (const entry of records) {
    try {
      generated += await db.withAuthLock(async () => {
        const row = await read(entry.childId), child = await db.getChildById(entry.childId); if (!child) return 0;
        const count = generate(row.data, child, today.slice(0, 7), actor);
        if (count) await write(row, actor, 'monthly_generation');
        return count;
      });
    } catch { failed++; }
  }
  return { generated, failed, today };
};
exports.startMaintenance = () => {
  let pending;
  const run = () => {
    if (pending) return pending;
    pending = exports.runMaintenance().then(result => {
      if (result.failed) console.error(JSON.stringify({ event: 'billing_maintenance_failed' }));
    }).catch(() => console.error(JSON.stringify({ event: 'billing_maintenance_failed' }))).finally(() => { pending = null; });
    return pending;
  };
  void run(); const timer = setInterval(run, 60 * 60 * 1000); timer.unref();
  return async () => { clearInterval(timer); await pending; };
};
