const { problem } = require('./planValidation');
const { fieldError } = require('./catalogValidation');
const SCALE = 1000000n;
const MAX = 999999999999999999n;
const UNITS = ['count', 'g', 'ml', 'oz', 'lb', 'gal', 'box', 'pack'];
const editable = ['name', 'category', 'groupId', 'location', 'unit', 'ingredientId', 'reorderThreshold'];

// Decimal strings and scaled integers keep repeated fractional stock changes exact.
function amount(value, field = 'quantity') {
  if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(String(value))) {
    throw fieldError(field, 'Enter a non-negative quantity below one trillion, with up to six decimal places.');
  }
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
function decimal(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % SCALE).padStart(6, '0').replace(/0+$/, '');
  return sign + String(absolute / SCALE) + (fraction ? '.' + fraction : '');
}
function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fieldError(field, 'Enter ' + field + ' between 1 and ' + max + ' characters.');
  return value.trim().replace(/\s+/g, ' ');
}
function object(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw problem('Supply inventory details.');
}
function keys(payload, allowed) {
  object(payload);
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw fieldError(key, 'This field cannot be changed.');
}
function requestId(payload) {
  object(payload);
  if (typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(payload.requestId)) throw fieldError('requestId', 'A valid request identifier is required.');
  return payload.requestId;
}
function version(value, previous) {
  if (!Number.isInteger(value) || value < 1 || value >= 2147483647) throw fieldError('version', 'Reload the inventory item before saving.');
  if (value !== previous.version) throw Object.assign(problem('This inventory item changed elsewhere. Reload it and review the latest stock before saving.', 409), { code: 'INVENTORY_CONFLICT' });
}
function item(payload, previous) {
  keys(payload, [...editable, 'reason', 'requestId', ...(previous ? ['version'] : ['openingQuantity'])]);
  if (previous) version(payload.version, previous);
  const result = { ingredientId: null, groupId: null, reorderThreshold: '0', ...previous };
  for (const key of editable) if (Object.hasOwn(payload, key)) result[key] = payload[key];
  if (Object.hasOwn(payload, 'category') && !Object.hasOwn(payload, 'groupId')) result.groupId = null;
  for (const [key, max] of [['name', 100], ['location', 200]]) result[key] = text(result[key], key, max);
  if (result.groupId !== null) identifier(result.groupId, 'groupId');
  if (!result.groupId || Object.hasOwn(payload, 'category')) result.category = text(result.category, 'category', 80);
  if (!UNITS.includes(result.unit)) throw fieldError('unit', 'Choose a supported inventory unit.');
  if (result.ingredientId !== null && (typeof result.ingredientId !== 'string' || !result.ingredientId.trim() || result.ingredientId.length > 255)) {
    throw fieldError('ingredientId', 'Choose an ingredient or leave it unlinked.');
  }
  result.reorderThreshold = decimal(amount(result.reorderThreshold, 'reorderThreshold'));
  if (previous && amount(previous.quantity) > 0n && (result.unit !== previous.unit || result.ingredientId !== previous.ingredientId)) {
    throw fieldError('unit', 'Unit and ingredient link can change only when stock is zero. Record a count correction or usage first.', 409);
  }
  return Object.fromEntries(editable.map((key) => [key, result[key]]));
}
function movement(payload, previous) {
  keys(payload, ['type', 'quantity', 'unit', 'reason', 'version', 'requestId']);
  version(payload.version, previous);
  if (!['addition', 'usage', 'correction'].includes(payload.type)) throw fieldError('type', 'Choose addition, usage or count correction.');
  if (payload.unit !== previous.unit) throw fieldError('unit', 'Enter the quantity in this item’s recorded unit: ' + previous.unit + '.');
  const value = amount(payload.quantity);
  if (payload.type !== 'correction' && value === 0n) throw fieldError('quantity', 'Enter a quantity greater than zero.');
  const before = amount(previous.quantity);
  const after = payload.type === 'correction' ? value : before + (payload.type === 'usage' ? -value : value);
  if (after < 0n) throw fieldError('quantity', 'Usage cannot exceed the stock currently available.', 409);
  if (after > MAX) throw fieldError('quantity', 'The resulting stock would exceed the supported quantity.');
  return decimal(after);
}
function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw fieldError(field, 'Choose a valid inventory group.');
  return value;
}
function group(payload) {
  keys(payload, ['name', 'kind', 'description', 'requestId']);
  requestId(payload);
  const name = text(payload.name, 'name', 80);
  const kind = payload.kind ?? 'supplies';
  if (!['food', 'supplies'].includes(kind)) throw fieldError('kind', 'Choose food stock or supplies and equipment.');
  const description = payload.description ?? '';
  if (typeof description !== 'string' || description.trim().length > 240) throw fieldError('description', 'Keep the group description within 240 characters.');
  return { name, nameKey: name.toLowerCase(), kind, description: description.trim() };
}
function pagination(query, allowed = ['q', 'category', 'groupId', 'location', 'status', 'page', 'pageSize']) {
  keys(query, allowed);
  const result = {};
  if (query.groupId !== undefined) result.groupId = identifier(query.groupId, 'groupId');
  for (const [key, max] of [['q', 100], ['category', 80], ['location', 200]]) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'string' || query[key].length > max) throw problem('Invalid inventory ' + key + ' filter.');
    result[key] = query[key].trim().replace(/\s+/g, ' ');
  }
  if (query.status !== undefined && !['all', 'available', 'low', 'out'].includes(query.status)) throw problem('Choose all, available, low or out stock status.');
  if (query.status && query.status !== 'all') result.status = query.status;
  for (const [key, fallback, max] of [['page', 1, 1000000], ['pageSize', 50, 100]]) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || !/^[1-9]\d*$/.test(query[key]) || Number(query[key]) > max)) throw problem('Invalid ' + key + '.');
    result[key] = query[key] === undefined ? fallback : Number(query[key]);
  }
  return result;
}
module.exports = { amount, decimal, text, item, movement, pagination, requestId, identifier, group, UNITS };
