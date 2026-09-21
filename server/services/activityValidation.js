const { problem } = require('./planValidation');
const { fieldError } = require('./catalogValidation');
const { amount, decimal } = require('./inventoryValidation');

const fields = ['name', 'description', 'durationMinutes', 'ageMinMonths', 'ageMaxMonths', 'materials', 'roomId'];
const legacy = ['startTime', 'endTime', 'category', 'repeatWindowWeeks', 'type', 'location', 'ageMin', 'ageMax',
  'energyLevel', 'estimatedCost', 'materialsLinks', 'materialsNotes'];
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('Supply activity details.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fieldError(key, 'This field cannot be changed.');
}
function identifier(value, field = 'activityId') {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw fieldError(field, 'Choose a valid item.');
  return value;
}
function version(value, previous, label = 'activity') {
  if (!Number.isInteger(value) || value < 0 || value >= 2147483647) throw fieldError('version', 'Reload before saving.');
  if (value !== previous) throw Object.assign(problem('This ' + label + ' changed elsewhere. Reload it before saving again.', 409), { code: 'ACTIVITY_CONFLICT' });
}
function activity(payload, previous) {
  object(payload, [...fields, ...legacy, ...(previous ? ['version'] : [])]);
  if (previous) version(payload.version, previous.version);
  const value = { description: '', roomId: null, ageMinMonths: null, ageMaxMonths: null, materials: [], ...previous, ...payload };
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100) throw fieldError('name', 'Enter an activity name of up to 100 characters.');
  value.name = value.name.trim();
  if (typeof value.description !== 'string' || value.description.length > 4000) throw fieldError('description', 'Keep the description within 4,000 characters.');
  value.description = value.description.trim();
  // Accept the earlier API's year ranges while new screens use months, like Rooms.
  if ('ageMin' in payload || 'ageMax' in payload) {
    if ('ageMinMonths' in payload || 'ageMaxMonths' in payload) throw fieldError('ageMinMonths', 'Use one age format.');
    if (![value.ageMin, value.ageMax].every((n) => Number.isInteger(n) && n >= 0 && n <= 18) || value.ageMax <= value.ageMin) throw fieldError('ageMax', 'Maximum age must be greater than minimum age.');
    value.ageMinMonths = value.ageMin * 12; value.ageMaxMonths = value.ageMax * 12;
  }
  if (value.ageMinMonths !== null || value.ageMaxMonths !== null) {
    if (![value.ageMinMonths, value.ageMaxMonths].every((n) => Number.isInteger(n) && n >= 0 && n <= 216) || value.ageMaxMonths <= value.ageMinMonths) {
      throw fieldError('ageMaxMonths', 'Enter both ages in months, with maximum greater than minimum, or leave both empty for all ages.');
    }
  }
  if (!previous && 'ageMin' in payload && !('durationMinutes' in payload)) value.durationMinutes = null;
  if (!(value.durationMinutes === null && (previous?.durationMinutes === null || 'ageMin' in payload)) &&
      (!Number.isInteger(value.durationMinutes) || value.durationMinutes < 1 || value.durationMinutes > 1440)) throw fieldError('durationMinutes', 'Enter a duration from 1 to 1440 minutes.');
  if (value.roomId !== null) identifier(value.roomId, 'roomId');
  for (const [field, choices] of Object.entries({ category: ['foundational', 'thematic'], location: ['indoor', 'outdoor'], energyLevel: ['low', 'medium', 'high'] })) {
    if (field in payload && !choices.includes(payload[field])) throw fieldError(field, 'Choose a supported ' + field + '.');
  }
  for (const field of ['type', 'materialsNotes']) if (field in payload && (typeof payload[field] !== 'string' || payload[field].length > 4000)) throw fieldError(field, 'Supply text of up to 4,000 characters.');
  if ('repeatWindowWeeks' in payload && (!Number.isInteger(payload.repeatWindowWeeks) || payload.repeatWindowWeeks < 1 || payload.repeatWindowWeeks > 520)) throw fieldError('repeatWindowWeeks', 'Enter 1 to 520 weeks.');
  if ('estimatedCost' in payload && (typeof payload.estimatedCost !== 'number' || !Number.isFinite(payload.estimatedCost) || payload.estimatedCost < 0)) throw fieldError('estimatedCost', 'Enter a non-negative cost.');
  if ('materialsLinks' in payload && (!Array.isArray(payload.materialsLinks) || payload.materialsLinks.length > 30 || payload.materialsLinks.some((link) => typeof link !== 'string' || !/^https?:\/\//.test(link) || link.length > 2000))) throw fieldError('materialsLinks', 'Supply up to 30 web links.');
  for (const field of ['startTime', 'endTime']) if (field in payload && payload[field] !== null && (typeof payload[field] !== 'string' || !Number.isFinite(Date.parse(payload[field])))) throw fieldError(field, 'Supply a valid timestamp.');
  if (!Array.isArray(value.materials) || value.materials.length > 30) throw fieldError('materials', 'Add up to 30 materials.');
  const seen = new Set();
  value.materials = value.materials.map((item) => {
    // Stored names/units are server snapshots, never values trusted from a client.
    if (Object.hasOwn(payload, 'materials')) object(item, ['itemId', 'quantity', 'reusable', 'unit']);
    identifier(item.itemId, 'materials');
    if (seen.has(item.itemId)) throw fieldError('materials', 'Add each inventory item only once.');
    seen.add(item.itemId);
    const quantity = amount(item.quantity, 'materials');
    if (quantity <= 0n) throw fieldError('materials', 'Enter a material quantity greater than zero.');
    if (typeof item.reusable !== 'boolean' || typeof item.unit !== 'string') throw fieldError('materials', 'Choose an inventory item, unit and whether it can be reused.');
    return { itemId: item.itemId, quantity: decimal(quantity), reusable: item.reusable, unit: item.unit };
  });
  return { ...Object.fromEntries([...fields, ...legacy].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])), version: (previous?.version || 0) + 1 };
}
const snapshot = (activity) => activity && Object.fromEntries(['id', ...fields, 'version'].map((key) => [key, activity[key] ?? null]));
function suitable(activity, room) {
  return (!activity.roomId || activity.roomId === room.id) && (activity.ageMinMonths === null || activity.ageMinMonths === undefined ||
    (room.ageMinMonths !== null && room.ageMaxMonths !== null && room.ageMinMonths >= activity.ageMinMonths && room.ageMaxMonths <= activity.ageMaxMonths));
}
module.exports = { activity, snapshot, suitable, object, identifier, version };
