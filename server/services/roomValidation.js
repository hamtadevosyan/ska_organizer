const { problem } = require('./planValidation');

function validateRoom(payload, previous) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw problem('Supply room settings.');
  const fields = {};
  const result = previous ? { ...previous } : { active: true };
  const allowed = ['name', 'ageMinMonths', 'ageMaxMonths', 'capacity', 'active'];
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) fields[key] = 'This field cannot be changed.';
  for (const key of allowed) if (Object.hasOwn(payload, key)) result[key] = payload[key];
  if (typeof result.name !== 'string' || !result.name.trim() || result.name.trim().length > 100) {
    fields.name = 'Enter a name between 1 and 100 characters.';
  } else result.name = result.name.trim();
  for (const key of ['ageMinMonths', 'ageMaxMonths']) {
    if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > 216) {
      fields[key] = 'Enter a whole number of months from 0 to 216.';
    }
  }
  if (Number.isInteger(result.ageMinMonths) && Number.isInteger(result.ageMaxMonths) && result.ageMaxMonths < result.ageMinMonths) {
    fields.ageMaxMonths = 'Maximum age must be at least the minimum age.';
  }
  if (!Number.isInteger(result.capacity) || result.capacity <= 0 || result.capacity > 2147483647) {
    fields.capacity = 'Enter a positive whole-number capacity.';
  }
  if (typeof result.active !== 'boolean') fields.active = 'Active must be true or false.';
  if (Object.keys(fields).length) throw Object.assign(problem('Correct the highlighted room settings.'), { fields });
  return Object.fromEntries(allowed.map((key) => [key, result[key]]));
}

function roomId(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw problem('Choose a valid room.');
  return value;
}
function dateOnly(value) {
  const parsed = typeof value === 'string' ? new Date(value + 'T00:00:00Z') : new Date(NaN);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw problem('Date must be a valid date in YYYY-MM-DD format.');
  }
  return value;
}
module.exports = { validateRoom, roomId, dateOnly };
