const { problem } = require('./planValidation');
const TYPES = ['breakfast', 'snack', 'lunch', 'afternoonSnack'];
const UNITS = ['count', 'g', 'ml', 'oz', 'lb', 'gal'];
function fieldError(field, message, status = 400) {
  return Object.assign(problem(message, status), { fields: { [field]: message } });
}
function validate(payload, kind, partial = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw problem('Supply catalog fields.');
  const result = {};
  const fields = {};
  if (!partial || 'name' in payload) {
    if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 255) {
      fields.name = 'Enter a name between 1 and 255 characters.';
    } else result.name = payload.name.trim();
  }
  const choice = kind === 'meal' ? 'type' : 'unit';
  if (!partial || choice in payload) {
    if (!(kind === 'meal' ? TYPES : UNITS).includes(payload[choice])) fields[choice] = `Choose a supported ${choice}.`;
    else result[choice] = payload[choice];
  }
  if (kind === 'meal' && 'description' in payload) {
    if (typeof payload.description !== 'string') fields.description = 'Description must be text.';
    else result.description = payload.description.trim();
  }
  if (kind === 'ingredient' && 'shelfLifeDays' in payload) {
    const value = payload.shelfLifeDays;
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 2147483647)) {
      fields.shelfLifeDays = 'Shelf life must be a non-negative whole number or null.';
    } else result.shelfLifeDays = value;
  }
  if ('archived' in payload) {
    if (typeof payload.archived !== 'boolean') fields.archived = 'Archived must be true or false.';
    else result.archived = payload.archived;
  }
  if (Object.keys(fields).length) throw Object.assign(problem('Correct the highlighted fields.'), { fields });
  return result;
}
function quantity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1e12 || Number(value.toFixed(6)) !== value) {
    throw fieldError('quantity', 'Enter a positive quantity below one trillion with at most six decimal places.');
  }
  return value;
}
module.exports = { validate, quantity, fieldError };
