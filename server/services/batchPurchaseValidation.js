const v = require('./inventoryValidation');
const { fieldError } = require('./catalogValidation');
const { validateWeekStart } = require('./planValidation');
const time = require('./facilityTime');

function keys(value, allowed, field = 'receipt') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fieldError(field, 'Supply received-purchase details.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fieldError(field + '.' + key, 'This receipt field cannot be changed.');
}
function identifier(value, field, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) throw fieldError(field, 'Choose a valid record.');
  return value;
}
function version(value, field) {
  if (!Number.isInteger(value) || value < 1 || value >= 2147483647) throw fieldError(field, 'Reload and review the current version.');
  return value;
}
function cost(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) throw fieldError(field, 'Enter a non-negative dollar amount with up to two decimal places, or leave it empty.');
  const [whole, fraction = ''] = value.split('.');
  return whole + '.' + fraction.padEnd(2, '0');
}
function payload(input) {
  keys(input, ['requestId', 'receivedOn', 'supplier', 'reason', 'lines', 'purchasingRef']);
  const requestId = v.requestId(input);
  let receivedOn;
  try { receivedOn = time.validateDate(input.receivedOn); }
  catch { throw fieldError('receivedOn', 'Enter a real received date in YYYY-MM-DD format.'); }
  if (receivedOn > time.dateAt()) throw fieldError('receivedOn', 'A received purchase cannot have a future date.');
  let supplier = null;
  if (input.supplier !== undefined && input.supplier !== null) {
    if (typeof input.supplier !== 'string' || input.supplier.trim().length > 200) throw fieldError('supplier', 'Keep the supplier within 200 characters.');
    supplier = input.supplier.trim().replace(/\s+/g, ' ') || null;
  }
  const reason = input.reason === undefined ? 'Purchases received' : v.text(input.reason, 'reason', 500);
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 50) throw fieldError('lines', 'Include between one and fifty received inventory items.');
  const lines = input.lines.map((line, index) => {
    const field = 'lines.' + index;
    keys(line, ['itemId', 'version', 'quantity', 'unit', 'totalCost', 'purchasingLineId'], field);
    const itemId = identifier(line.itemId, field + '.itemId');
    const currentVersion = version(line.version, field + '.version');
    if (typeof line.quantity !== 'string') throw fieldError(field + '.quantity', 'Enter the actual received quantity as a decimal amount.');
    const quantity = v.amount(line.quantity, field + '.quantity');
    if (quantity <= 0n) throw fieldError(field + '.quantity', 'Enter an actual received quantity greater than zero.');
    if (!v.UNITS.includes(line.unit)) throw fieldError(field + '.unit', 'Choose a supported inventory unit.');
    return { itemId, version: currentVersion, quantity: v.decimal(quantity), unit: line.unit,
      totalCost: cost(line.totalCost, field + '.totalCost'), ...(line.purchasingLineId !== undefined ? {
        purchasingLineId: identifier(line.purchasingLineId, field + '.purchasingLineId', 300),
      } : {}) };
  }).sort((a, b) => a.itemId.localeCompare(b.itemId));
  if (new Set(lines.map((line) => line.itemId)).size !== lines.length) throw fieldError('lines', 'Each inventory record can appear only once. Combine received quantities for the same record and location.');
  let purchasingRef;
  if (input.purchasingRef !== undefined) {
    keys(input.purchasingRef, ['weekStart', 'version'], 'purchasingRef');
    purchasingRef = { weekStart: validateWeekStart(input.purchasingRef.weekStart), version: version(input.purchasingRef.version, 'purchasingRef.version') };
  }
  if (lines.some((line) => line.purchasingLineId) && !purchasingRef) throw fieldError('purchasingRef', 'Choose the saved purchasing week for linked receipt lines.');
  return { requestId, receivedOn, supplier, reason, lines, ...(purchasingRef ? { purchasingRef } : {}) };
}
module.exports = { payload, identifier };
