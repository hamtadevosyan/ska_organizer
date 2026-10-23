const db = require('./dbAdapter');
const blocked = (message, status, code) => Object.assign(new Error(message), { status, code });
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const date = value.slice(0, 10), millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date ? millis : NaN;
};

// A session never caches work attendance. Locked service authorization re-reads
// this ledger under the same lock used by manager and station clock writes.
async function resolve(account) {
  const required = account.role !== 'admin' && !!account.staffMemberId;
  if (!required) return { required: false, checkedIn: false, available: true };
  try {
    // Lazy loading avoids the vault's auth error helpers creating a cycle.
    const vault = require('./payrollVault');
    vault.check();
    const row = await db.getPayrollRecord('ledger:' + account.staffMemberId);
    if (!row) return { required: true, checkedIn: false, available: true };
    if (row.id !== 'ledger:' + account.staffMemberId || row.staffId !== account.staffMemberId || row.kind !== 'ledger' || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error('Invalid clock record.');
    const ledger = vault.open(row);
    if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.sessions)) throw new Error('Invalid clock ledger.');
    const ids = new Set(), periods = [], now = Date.now();
    let open = 0;
    for (const session of ledger.sessions) {
      if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id || ids.has(session.id) || (session.voided !== undefined && typeof session.voided !== 'boolean')) throw new Error('Invalid clock session.');
      ids.add(session.id);
      if (session.voided) continue;
      const start = instant(session.start), end = session.end === null ? Infinity : instant(session.end);
      if (!Number.isFinite(start) || start > now || (session.end !== null && (!Number.isFinite(end) || end <= start || end > now))) throw new Error('Invalid clock timestamps.');
      if (session.end === null) open++;
      periods.push([start, end]);
    }
    periods.sort((a, b) => a[0] - b[0]);
    if (open > 1 || periods.some((period, index) => index > 0 && period[0] < periods[index - 1][1])) throw new Error('Overlapping clock sessions.');
    return { required: true, checkedIn: open === 1, available: true };
  } catch {
    // Authentication metadata remains usable for sign-out/password changes,
    // while every protected service fails closed without private clock data.
    return { required: true, checkedIn: false, available: false };
  }
}
function requireCheckedIn(access) {
  if (!access.required) return;
  if (!access.available) throw blocked('Your work status could not be verified. Ask an administrator to check the staff clock, then try again.', 503, 'WORK_ACCESS_UNAVAILABLE');
  if (!access.checkedIn) throw blocked('Check in at the staff clock before opening your account.', 403, 'WORK_CHECK_IN_REQUIRED');
}
module.exports = { resolve, requireCheckedIn };
