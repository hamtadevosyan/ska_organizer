const problem = (message, status = 400) => Object.assign(new Error(message), { status });
function validateWeekStart(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getUTCDay() !== 1) {
    throw problem('Week start must be a Monday in YYYY-MM-DD format.');
  }
  return value;
}
function validateCounts(childrenCount, staffCount) {
  if (![childrenCount, staffCount].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isSafeInteger(childrenCount + staffCount) || childrenCount + staffCount <= 0) {
    throw problem('Child and staff counts must be non-negative whole numbers with a positive total.');
  }
}
function validateVersion(version) {
  if (!Number.isSafeInteger(version) || version < 0) throw problem('A valid saved plan version is required.');
}
module.exports = { problem, validateWeekStart, validateCounts, validateVersion };
