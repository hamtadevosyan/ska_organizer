const { problem } = require('./planValidation');
const { roomId } = require('./roomValidation');
const editable = ['name', 'role', 'active', 'roomId'];

function validateStaff(payload, previous) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !editable.some((key) => Object.hasOwn(payload, key))) {
    throw problem('Supply staff details.');
  }
  const fields = {};
  const result = previous ? { ...previous } : { active: true, roomId: null };
  for (const key of Object.keys(payload)) {
    if (![...editable, ...(previous ? ['version'] : [])].includes(key)) fields[key] = 'This field cannot be changed.';
    else if (editable.includes(key)) result[key] = payload[key];
  }
  for (const key of ['name', 'role']) {
    if (typeof result[key] !== 'string' || !result[key].trim() || result[key].trim().length > 100) {
      fields[key] = 'Enter ' + (key === 'name' ? 'a name' : 'a job role') + ' between 1 and 100 characters.';
    } else result[key] = result[key].trim().replace(/\s+/g, ' ');
  }
  if (typeof result.active !== 'boolean') fields.active = 'Use true or false.';
  try { roomId(result.roomId, true); } catch { fields.roomId = 'Choose a room or leave it unassigned.'; }
  if (previous && (!Number.isInteger(payload.version) || payload.version < 1 || payload.version >= 2147483647)) {
    fields.version = 'Reload the staff record before saving.';
  }
  if (Object.keys(fields).length) throw Object.assign(problem('Correct the highlighted staff details.'), { fields });
  if (previous && payload.version !== previous.version) {
    throw Object.assign(problem('This staff record changed elsewhere. Reload it and review the latest details before saving.', 409), { code: 'STAFF_CONFLICT' });
  }
  return { ...Object.fromEntries(editable.map((key) => [key, result[key]])), version: previous ? previous.version + 1 : 1 };
}

function staffId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 255) throw problem('Choose a valid staff record.');
  return id;
}

function staffQuery(query) {
  for (const key of Object.keys(query)) if (!['q', 'active', 'roomId', 'page', 'pageSize'].includes(key)) throw problem('Unknown staff filter: ' + key + '.');
  const filters = {};
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > 100) throw problem('Search must be text up to 100 characters.');
    filters.q = query.q.trim().replace(/\s+/g, ' ');
  }
  if (query.active !== undefined && !['true', 'false', 'all'].includes(query.active)) throw problem('Active must be true, false or all.');
  if (query.active !== 'all') filters.active = query.active !== 'false';
  if (query.roomId !== undefined) filters.roomId = query.roomId === 'unassigned' ? null : roomId(query.roomId);
  for (const [key, fallback, max] of [['page', 1, 1000000], ['pageSize', 50, 100]]) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || !/^[1-9]\d*$/.test(query[key]) || Number(query[key]) > max)) {
      throw problem(key + ' must be a whole number from 1 to ' + max + '.');
    }
    filters[key] = query[key] === undefined ? fallback : Number(query[key]);
  }
  return filters;
}
module.exports = { validateStaff, staffId, staffQuery };
