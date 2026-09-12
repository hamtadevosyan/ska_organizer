const { problem } = require('./planValidation');
const { dateOnly, roomId } = require('./roomValidation');

const fields = ['firstName', 'lastName', 'dateOfBirth', 'preferredName', 'notes', 'photoConsent', 'roomId', 'active'];
const confirmations = ['confirmDuplicate', 'confirmOverCapacity'];
const normalizedName = (value) => value.trim().replace(/\s+/g, ' ');

function validateChild(payload, previous) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.keys(payload).length) throw problem('Supply child details.');
  const errors = {};
  const result = previous ? { ...previous } : { preferredName: '', notes: '', photoConsent: false, roomId: null, active: true };
  for (const key of Object.keys(payload)) {
    if (![...fields, ...confirmations].includes(key)) errors[key] = 'This field cannot be changed.';
    else if (fields.includes(key)) result[key] = payload[key];
  }
  for (const key of ['firstName', 'lastName', 'preferredName', 'notes']) {
    // Legacy missing fields remain unknown until explicitly edited.
    if (previous && !Object.hasOwn(payload, key)) continue;
    const required = key === 'firstName' || key === 'lastName';
    const max = key === 'notes' ? 2000 : 100;
    if (typeof result[key] !== 'string' || (required && !result[key].trim()) || result[key].trim().length > max) {
      errors[key] = required ? 'Enter a name between 1 and 100 characters.' : 'Enter text up to ' + max + ' characters.';
    } else result[key] = key === 'notes' ? result[key].trim() : normalizedName(result[key]);
  }
  if (!previous || Object.hasOwn(payload, 'dateOfBirth')) {
    try {
      dateOnly(result.dateOfBirth);
      if (result.dateOfBirth < '1900-01-01' || result.dateOfBirth > new Date().toISOString().slice(0, 10)) throw new Error();
    } catch { errors.dateOfBirth = 'Enter a real date of birth from 1900 through today (YYYY-MM-DD).'; }
  }
  for (const key of ['active', 'photoConsent', ...confirmations]) {
    if ((Object.hasOwn(payload, key) || ['active', 'photoConsent'].includes(key) && !previous) && typeof (confirmations.includes(key) ? payload[key] : result[key]) !== 'boolean') {
      errors[key] = 'Use true or false.';
    }
  }
  if (Object.hasOwn(payload, 'roomId')) {
    try { roomId(result.roomId, true); } catch { errors.roomId = 'Choose a valid room or leave it unassigned.'; }
  }
  if (Object.keys(errors).length) throw Object.assign(problem('Correct the highlighted child details.'), { fields: errors });
  return Object.fromEntries(fields.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
}

module.exports = { validateChild, normalizedName };
