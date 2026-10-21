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
      row.unpaidMillis += session.breaks.filter(b => !b.paid).reduce((sum, b) => sum + intersection(Date.parse(b.start), b.end ? Date.parse(b.end) : finish, from, to), 0);
      row.incomplete ||= !session.end || session.breaks.some(b => !b.end);
      row.sessionIds.push(session.id); rows.set(date, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({ ...row, paidMillis: row.rawMillis - row.unpaidMillis,
    approval: ledger.approvals[row.date] || null }));
}
function preview(ledger, profile, start, end) {
  const all = daily(ledger), blockers = []; const rows = [];
  if (!profile.rules?.confirmed || !profile.rules.reference?.trim()) blockers.push('Confirm the applicable overtime, paid/unpaid break, rounding and adjustment rules before finalizing.');
  const rules = profile.rules || {};
  const paidDays = all.filter(row => row.date >= start && row.date <= end);
  for (const day of paidDays) {
    const approval = day.approval; const issues = [];
    if (day.incomplete) issues.push('Missing checkout or unfinished break.');
    if (approval?.status !== 'approved') issues.push('Daily paid time is not approved.');
    const rate = [...(profile.rates || [])].filter(r => r.effectiveOn <= day.date).sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.sequence - a.sequence)[0];
    if (!rate) issues.push('No effective hourly rate.');
    if (approval?.status === 'approved' && approval.rulesFingerprint !== hash(profile.rules)) issues.push('The paid-hours policy changed after approval. Review and approve this day again.');
    if (approval && !approval.rulesReviewed) issues.push('Overtime, breaks and adjustments have not been reviewed.');
    if (approval?.status === 'approved') {
      const total = approval.regularMillis + approval.overtimeMillis + approval.doubleMillis;
      if (total < day.paidMillis) issues.push('Approved time is below clocked paid time. Correct the original error with a reason or obtain payroll-provider review; time is never silently capped.');
      // The supported rule is the standard California non-exempt workday.
      // Never silently pay a straight rate for apparent daily/weekly overtime.
      if (rules.mode === 'ca-standard') {
        const dayOfWeek = new Date(day.date + 'T12:00:00Z').getUTCDay();
        const weekStart = time.addDays(day.date, -((dayOfWeek - rules.workweekStart + 7) % 7));
        const weekEnd = time.addDays(weekStart, 6);
        const weekDays = all.filter(d => d.date >= weekStart && d.date <= weekEnd);
        if (weekDays.some(d => d.incomplete || d.approval?.status !== 'approved' || d.approval.rulesFingerprint !== hash(profile.rules))) issues.push('The complete workweek needs approved time for overtime review.');
        const regularWeek = weekDays.reduce((sum, d) => sum + (d.approval?.status === 'approved' ? d.approval.regularMillis : 0), 0);
        if (approval.regularMillis > 8 * 3600000 || regularWeek > 40 * 3600000) issues.push('Regular hours exceed the daily/weekly limit. Review the overtime allocation.');
        if (total > 12 * 3600000 && approval.doubleMillis < total - 12 * 3600000) issues.push('Daily double-time allocation needs review.');
        if (weekDays.length === 7 && day.date === weekEnd && (approval.regularMillis > 0 || approval.doubleMillis < Math.max(0, total - 8 * 3600000))) issues.push('Seventh-day overtime allocation needs review.');
        const weekRates = new Set(weekDays.map(d => [...(profile.rates || [])].filter(r => r.effectiveOn <= d.date).sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.sequence - a.sequence)[0]).map(rate => rate ? `${rate.currency}:${rate.cents}` : 'missing'));
        if ((approval.overtimeMillis || approval.doubleMillis) && weekRates.size > 1) issues.push('Multiple rates in this workweek: regular-rate overtime requires payroll-provider review.');
      } else issues.push('Unsupported payroll rules: use your payroll provider for calculation.');
    }
    let cents = null;
    if (approval?.status === 'approved' && rate) {
      // Integer arithmetic, rounding money once per day to the nearest cent.
      const weighted = BigInt(approval.regularMillis) * 2n + BigInt(approval.overtimeMillis) * 3n + BigInt(approval.doubleMillis) * 4n;
      cents = Number((weighted * BigInt(rate.cents) + 3600000n) / 7200000n) + approval.adjustmentCents;
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
    approvedMillis: rows.reduce((sum, r) => sum + (r.approval?.status === 'approved' ? r.approval.regularMillis + r.approval.overtimeMillis + r.approval.doubleMillis : 0), 0),
    grossCents: rows.reduce((sum, row) => sum + (row.grossCents ?? 0), 0), rows, blockers: [...new Set(blockers)],
    canFinalize: !blockers.length, fingerprint: hash({ ledger, profile, start, end }), paymentExecuted: false, taxWithholdingCalculated: false };
}
module.exports = { daily, preview, hash };
