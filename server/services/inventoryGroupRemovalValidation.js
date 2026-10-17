const { fieldError } = require('./catalogValidation');
const v = require('./inventoryValidation');

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fieldError('group', 'Supply inventory group removal details.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw fieldError(key, 'This group removal field cannot be changed.');
}
function identifier(value, field = 'groupId') {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 255) throw fieldError(field, 'Choose a valid inventory group.');
  return value;
}
function preview(value) {
  keys(value, ['action', 'contextVersion', 'targetGroupId', 'targetVersion', 'reason']);
  if (!['delete', 'move', 'archive'].includes(value.action)) throw fieldError('action', 'Choose empty deletion, move all items or archive all records.');
  if (typeof value.contextVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.contextVersion)) throw fieldError('contextVersion', 'Reopen the inventory group before reviewing its removal.');
  let targetGroupId = null, targetVersion = null;
  if (value.action === 'move') {
    targetGroupId = identifier(value.targetGroupId, 'targetGroupId');
    if (!Number.isInteger(value.targetVersion) || value.targetVersion < 1 || value.targetVersion >= 2147483647) throw fieldError('targetVersion', 'Refresh the destination group before reviewing the move.');
    targetVersion = value.targetVersion;
  } else if (value.targetGroupId !== undefined || value.targetVersion !== undefined) throw fieldError('targetGroupId', 'A destination is used only when moving all items.');
  const reason = value.reason === undefined || value.reason === '' ? '' : v.text(value.reason, 'reason', 500);
  return { action: value.action, contextVersion: value.contextVersion, targetGroupId, targetVersion, reason };
}
function commit(value) {
  keys(value, ['requestId', 'reviewToken', 'acknowledgeRetainedStock']);
  v.requestId(value);
  if (typeof value.reviewToken !== 'string' || !value.reviewToken || value.reviewToken.length > 7000) throw fieldError('reviewToken', 'Review the inventory group removal before confirming it.');
  if (typeof value.acknowledgeRetainedStock !== 'boolean') throw fieldError('acknowledgeRetainedStock', 'Choose whether you acknowledge retained archived quantities.');
  return { requestId: value.requestId, reviewToken: value.reviewToken, acknowledgeRetainedStock: value.acknowledgeRetainedStock };
}
module.exports = { identifier, preview, commit };
