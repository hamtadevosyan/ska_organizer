const time = require('./facilityTime');
const hash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intersection = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
function daily(ledger) {
  const rows = new Map();
  for (const session of ledger.sessions) {
    if (session.voided) continue;
    const start = Date.parse(session.start); const finish = session.end ? Date.parse(session.end) : Date.now();
    for (let date = time.dateAt(start, ledger.timeZone), n = 0; n < 370 && date <= time.dateAt(finish, ledger.timeZone); date = time.addDays(date, 1), n++) {
      const bounds = time.dayBounds(date, ledger.timeZone); const from = Date.parse(bounds.from), to = Date.parse(bounds.to);
      const rawMillis = intersection(start, finish, from, to);
      if (!rawMillis && date !== time.dateAt(start, ledger.timeZone)) continue;
      const row = rows.get(date) || { date, rawMillis: 0, unpaidMillis: 0, paidMillis: 0, incomplete: false, sessionIds: [] };
      row.rawMillis += rawMillis;
      // Keep historical completed deductions. An unfinished legacy entry has
      // no known duration: preserve it, without inventing an end or deduction.
      row.unpaidMillis += session.breaks.filter(b => !b.paid && b.end).reduce((sum, b) => sum + intersection(Date.parse(b.start), Date.parse(b.end), from, to), 0);
      row.incomplete ||= !session.end;
      row.sessionIds.push(session.id); rows.set(date, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({ ...row, paidMillis: row.rawMillis - row.unpaidMillis,
    approval: ledger.approvals[row.date] || null }));
}
function sessionsForDay(ledger, date) {
  const bounds = time.dayBounds(date, ledger.timeZone), from = Date.parse(bounds.from), to = Date.parse(bounds.to), now = Date.now();
  return ledger.sessions.filter(session => !session.voided && Date.parse(session.start) < to && ((session.end ? Date.parse(session.end) : now) > from || !session.end && Date.parse(session.start) >= from))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id)).map(session => ({
      id: session.id, start: session.start, end: session.end || null,
      dayStart: new Date(Math.max(from, Date.parse(session.start))).toISOString(),
      dayEnd: session.end ? new Date(Math.min(to, Date.parse(session.end))).toISOString() : now >= to ? new Date(to).toISOString() : null,
      dayMillis: intersection(Date.parse(session.start), session.end ? Date.parse(session.end) : now, from, to),
      originalStart: session.original?.start || session.start, originalEnd: session.original ? session.original.end || null : session.end || null,
    }));
}
const HOUR = 3600000;
function scheduledPayCredit(day, work) {
  // A paid-hours proposal is separate from actual work. Never round down or
  // round a still-open day whose departure has not been recorded.
  const suggestedPaidMillis = !day.incomplete && day.paidMillis > 0 ? Math.ceil(day.paidMillis / HOUR) * HOUR : day.paidMillis;
  const roundingCreditMillis = suggestedPaidMillis - day.paidMillis;
  const eligible = roundingCreditMillis > 0 && work?.plannedMinutes * 60000 === suggestedPaidMillis &&
    !!work.plannedStart && !!work.plannedEnd && work.outsideMillis === 0 && !work.scheduleIssue;
  return { eligible, suggestedPaidMillis, roundingCreditMillis, scheduledCreditMillis: eligible ? roundingCreditMillis : 0 };
}
function overtimeContext(day, allDays, rules = {}) {
  const firstDay = Number.isInteger(rules.workweekStart) && rules.workweekStart >= 0 && rules.workweekStart <= 6 ? rules.workweekStart : 1;
  const weekStart = time.addDays(day.date, -((new Date(day.date + 'T12:00:00Z').getUTCDay() - firstDay + 7) % 7));
  const weekEnd = time.addDays(weekStart, 6);
  const weekDays = allDays.filter(row => row.date >= weekStart && row.date <= day.date);
  // Review flags use real recorded work, never additional scheduled paid credit.
  const weekMillis = weekDays.reduce((sum, row) => sum + row.paidMillis, 0);
  const daily = day.paidMillis > 8 * HOUR, weekly = weekMillis > 40 * HOUR;
  const seventhDay = weekDays.filter(row => row.paidMillis > 0).length === 7 && day.date === weekEnd;
  return { daily, weekly, seventhDay, requiresReview: daily || weekly || seventhDay, weekStart, weekEnd, weekMillis, dates: weekDays.map(row => row.date) };
}
const effectiveRate = (date, rates = []) => [...rates].filter(rate => rate.effectiveOn <= date)
  .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.sequence - a.sequence)[0];
function overtimeFingerprint(day, allDays, rules = {}, rates = []) {
  const context = overtimeContext(day, allDays, rules), wholeWeek = context.weekly || context.seventhDay;
  const actual = allDays.filter(row => wholeWeek ? row.date >= context.weekStart && row.date <= day.date : row.date === day.date)
    .map(row => {
      const savedRate = effectiveRate(row.date, rates);
      const rate = savedRate ? Object.fromEntries(['id', 'effectiveOn', 'cents', 'currency', 'sequence'].map(key => [key, savedRate[key]])) : null;
      return { date: row.date, paidMillis: row.paidMillis, incomplete: row.incomplete, sessionIds: row.sessionIds, rate };
    });
  return hash({ date: day.date, scope: wholeWeek ? 'week' : 'day', workweekStart: rules.workweekStart ?? 1, actual });
}
const approvedMillis = approval => approval?.mode === 'manual-reviewed' ? approval.paidMillis :
  (approval?.regularMillis || 0) + (approval?.overtimeMillis || 0) + (approval?.doubleMillis || 0);
function hoursOverrideFingerprint(day, allDays, ledger, profile, paidMillis, clockErrorConfirmed, reason) {
  const context = overtimeContext(day, allDays, profile.rules);
  const relevantDays = allDays.filter(row => row.date >= context.weekStart && row.date <= day.date);
  const ids = new Set(relevantDays.flatMap(row => row.sessionIds));
  return hash({ policy: 'administrator-paid-hours-v1', date: day.date, paidMillis, clockErrorConfirmed, reason,
    rules: profile.rules, rate: effectiveRate(day.date, profile.rates) || null,
    workWindow: ledger.workWindows?.[day.date] || null, workLimit: ledger.workLimits?.[day.date] ?? null,
    actual: relevantDays.map(row => ({ date: row.date, rawMillis: row.rawMillis, paidMillis: row.paidMillis, incomplete: row.incomplete, sessionIds: row.sessionIds })),
    sessions: ledger.sessions.filter(session => ids.has(session.id)).map(({ id, start, end, breaks, version, voided }) => ({ id, start, end, breaks, version, voided })),
  });
}
function validHoursOverride(day, allDays, ledger, profile) {
  const approval = day.approval, total = approvedMillis(approval);
  return approval?.status === 'approved' && approval.mode === 'manual-reviewed' && approval.hoursOverride === true &&
    approval.rulesReviewed === true && !day.incomplete && Number.isSafeInteger(total) && total >= 0 && total <= 48 * HOUR &&
    typeof approval.reason === 'string' && !!approval.reason.trim() &&
    (total >= day.paidMillis || approval.clockErrorConfirmed === true) &&
    approval.hoursOverrideFingerprint === hoursOverrideFingerprint(day, allDays, ledger, profile, total, approval.clockErrorConfirmed === true, approval.reason);
}
function rateAllocationFingerprint(day, allDays, ledger, profile, paidMillis, rateMillis, multiplierHundredths, reason) {
  return hash({ policy: 'administrator-rate-allocation-v1', timeZone: ledger.timeZone, rateMillis, multiplierHundredths,
    review: hoursOverrideFingerprint(day, allDays, ledger, profile, paidMillis, false, reason) });
}
const hasRateAllocation = approval => approval?.rateMillis !== undefined || approval?.multiplierHundredths !== undefined;
function validRateAllocation(approval, total) {
  return approval.mode === 'manual-reviewed' && typeof approval.reason === 'string' && !!approval.reason.trim() && approval.premiumCents === undefined &&
    Number.isSafeInteger(approval.rateMillis) && approval.rateMillis >= 0 && approval.rateMillis <= total &&
    Number.isSafeInteger(approval.multiplierHundredths) && approval.multiplierHundredths >= 100 && approval.multiplierHundredths <= 1000;
}
function preview(ledger, profile, start, end) {
  const all = daily(ledger), blockers = []; const rows = [];
  if (!profile.rules?.confirmed || !profile.rules.reference?.trim()) blockers.push('Confirm the applicable payroll policy, overtime and adjustments before finalizing.');
  const rules = profile.rules || {};
  const paidDays = all.filter(row => row.date >= start && row.date <= end);
  for (const day of paidDays) {
    const approval = day.approval; const issues = [];
    if (day.incomplete) issues.push('Missing checkout.');
    if (approval?.status !== 'approved') issues.push('Daily paid time is not approved.');
    const rate = effectiveRate(day.date, profile.rates);
    if (!rate) issues.push('No effective hourly rate.');
    if (approval?.status === 'approved' && approval.rulesFingerprint !== hash(profile.rules)) issues.push('The paid-hours policy changed after approval. Review and approve this day again.');
    if (approval && !approval.rulesReviewed) issues.push('Hours, overtime and adjustments have not been reviewed.');
    const manual = approval?.mode === 'manual-reviewed', allocatedRate = hasRateAllocation(approval);
    const legacyMultiplier = !manual && !!(approval?.overtimeMillis || approval?.doubleMillis);
    const total = approvedMillis(approval);
    const overrideCurrent = validHoursOverride(day, all, ledger, profile);
    const context = overtimeContext(day, all, rules);
    let validAmount = true;
    if (approval?.status === 'approved') {
      if (!Number.isSafeInteger(total) || total < 0 || total > 48 * HOUR) { issues.push('The saved paid-hours amount is invalid. Review and approve this day again.'); validAmount = false; }
      if (approval.hoursOverride && !overrideCurrent) { issues.push('The approved-hours change needs a new review because its clock records, schedule, rate or payroll rules changed.'); validAmount = false; }
      if (total < day.paidMillis && !overrideCurrent) issues.push('Approved time is below clocked paid time. Correct the original error or explicitly verify the clock error and approved hours with a reason.');
      if (!day.incomplete && total < scheduledPayCredit(day).suggestedPaidMillis && !overrideCurrent) issues.push('Paid time needs rounding review. Approve the proposed whole-hour paid time or enter reviewed different hours before calculating again.');
      if (allocatedRate && !validRateAllocation(approval, total)) { issues.push('Enter valid reviewed hours and a rate between 1x and 10x for the selected portion. Do not combine a rate with a legacy fixed amount.'); validAmount = false; }
      if (allocatedRate && approval.rateFingerprint !== rateAllocationFingerprint(day, all, ledger, profile, total, approval.rateMillis, approval.multiplierHundredths, approval.reason)) { issues.push('Clock records, approved schedule, hourly rate or payroll rules changed after the rate decision. Review and approve this day again.'); validAmount = false; }
      if (manual && !allocatedRate && (!Number.isSafeInteger(approval.premiumCents) || approval.premiumCents < 0 || approval.premiumCents > 100000000)) { issues.push('Enter a valid reviewed additional-pay amount.'); validAmount = false; }
      if (legacyMultiplier) issues.push('An earlier overtime allocation uses automatic multipliers. Enter reviewed paid hours and choose their rate before calculating again.');
      // Thresholds only flag a decision for explicit administrator review. They
      // never select an overtime rate or multiply any recorded hour.
      if (rules.mode === 'ca-standard') {
        const weekDays = all.filter(d => d.date >= context.weekStart && d.date <= day.date);
        if (context.requiresReview && weekDays.some(d => d.incomplete)) issues.push('Earlier workweek clock records have a missing checkout. Record the actual departure before reviewing overtime.');
        if ((context.requiresReview || approval.requiresOvertimeReview) && (!manual || approval.overtimeReviewed !== true)) issues.push('Overtime needs explicit administrator review and a manually chosen rate decision. No multiplier is applied automatically.');
      } else issues.push('Unsupported payroll rules: use your payroll provider for calculation.');
      if (allocatedRate && approval.rateMillis > 0 && approval.overtimeReviewed !== true) issues.push('The selected rate hours need explicit administrator review.');
      if (approval.requiresOvertimeReview && (!manual || approval.overtimeReviewed !== true) && !issues.some(issue => issue.startsWith('Overtime needs'))) issues.push('Overtime needs explicit administrator review and a manually chosen rate decision. No multiplier is applied automatically.');
      if ((context.requiresReview || approval.requiresOvertimeReview) && manual && approval.overtimeReviewed === true && approval.overtimeFingerprint !== overtimeFingerprint(day, all, rules, profile.rates)) {
        issues.push('Recorded work or hourly rate changed after overtime review. Review the current day or workweek and approve it again.');
        validAmount = false;
      }
    }
    let cents = null;
    if (approval?.status === 'approved' && rate && validAmount && !legacyMultiplier) {
      // Integer arithmetic, rounding money once per day to the nearest cent.
      const weightedMillis = BigInt(total) * 100n + (allocatedRate ? BigInt(approval.rateMillis) * BigInt(approval.multiplierHundredths - 100) : 0n);
      cents = Number((weightedMillis * BigInt(rate.cents) + 180000000n) / 360000000n) +
        (manual && !allocatedRate ? approval.premiumCents : 0) + approval.adjustmentCents;
    }
    if (cents !== null && cents < 0) issues.push('The adjustment makes gross pay negative. Review it with your payroll provider.');
    rows.push({ ...day, rate: rate || null, grossCents: cents, issues });
    blockers.push(...issues.map(message => day.date + ': ' + message));
  }
  if (!paidDays.length) blockers.push('No clocked days exist in this period.');
  if (rows.some(r => r.rate && r.rate.currency !== 'USD')) blockers.push('California standard previews support USD only. Use your payroll provider for other currencies.');
  if (new Set(rows.filter(r => r.rate).map(r => r.rate.currency)).size > 1) blockers.push('Multiple currencies cannot be combined.');
  return { start, end, timeZone: ledger.timeZone, currency: rows.find(r => r.rate)?.rate.currency || null,
    workedDays: paidDays.length, rawMillis: paidDays.reduce((sum, day) => sum + day.rawMillis, 0),
    approvedMillis: rows.reduce((sum, r) => sum + (r.approval?.status === 'approved' && Number.isSafeInteger(approvedMillis(r.approval)) ? approvedMillis(r.approval) : 0), 0),
    grossCents: rows.reduce((sum, row) => sum + (row.grossCents ?? 0), 0), rows, blockers: [...new Set(blockers)],
    canFinalize: !blockers.length, fingerprint: hash({ ledger, profile, start, end, calculatorVersion: 'manual-reviewed-pay-v5-selected-rate' }), paymentExecuted: false, taxWithholdingCalculated: false };
}
module.exports = { daily, sessionsForDay, rateAllocationFingerprint, preview, hash, scheduledPayCredit, overtimeContext, overtimeFingerprint, hoursOverrideFingerprint, validHoursOverride };
