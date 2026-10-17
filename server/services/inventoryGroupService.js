const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const db = require('./dbAdapter');
const v = require('./inventoryValidation');
const validation = require('./inventoryGroupRemovalValidation');
const { problem } = require('./planValidation');

const reviewKey = randomBytes(32);
const locked = (operation) => db.withCatalogLock(() => db.withInventoryLock(operation));
const conflict = (message, code = 'GROUP_REMOVAL_CONFLICT') => Object.assign(problem(message, 409), { code });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const json = (value) => JSON.stringify(canonical(value));
const hash = (value) => createHash('sha256').update(json(value)).digest('hex');
const date = (value) => value == null ? null : new Date(value).toISOString();
const groupSnapshot = (group) => ({ ...Object.fromEntries(['id', 'name', 'kind', 'description'].map((key) => [key, group[key]])),
  version: group.version || 1, archived: !!group.archived, archivedAt: date(group.archivedAt), deletedAt: date(group.deletedAt),
  createdAt: date(group.createdAt), updatedAt: date(group.updatedAt) });
const itemSnapshot = (item) => ({ ...Object.fromEntries(['id', 'name', 'category', 'groupId', 'location', 'unit', 'ingredientId', 'version'].map((key) => [key, item[key]])),
  quantity: v.decimal(v.amount(item.quantity)), reorderThreshold: v.decimal(v.amount(item.reorderThreshold || '0')),
  ...(item.archived ? { archived: true, archivedAt: date(item.archivedAt) } : {}) });
function requireActive(group) {
  if (!group) throw problem('Inventory group not found.', 404);
  if (group.deletedAt) throw conflict('This inventory group has already been removed. Refresh Inventory before choosing another group.');
  if (group.archived) throw conflict('This inventory group is archived and read-only. Its records and history remain available in Archived inventory.');
  return group;
}
async function state(id) {
  const source = requireActive(await db.getInventoryGroupById(id));
  const members = (await db.listInventoryInGroup(id)).map(itemSnapshot).sort((a, b) => a.id.localeCompare(b.id));
  const sourceSnapshot = groupSnapshot(source);
  return { source: sourceSnapshot, members, contextVersion: hash({ source: sourceSnapshot, members }) };
}
function statistics(members) {
  const sums = new Map();
  let nonzeroCount = 0;
  for (const member of members) {
    const quantity = v.amount(member.quantity);
    if (quantity > 0n) nonzeroCount++;
    sums.set(member.unit, (sums.get(member.unit) || 0n) + quantity);
  }
  return { itemCount: members.length, nonzeroCount, totals: [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([unit, quantity]) => ({ unit, quantity: v.decimal(quantity) })) };
}
const fingerprint = (context, target) => hash({ source: context.source, members: context.members, target });
function encode(payload) {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return value + '.' + createHmac('sha256', reviewKey).update(value).digest('base64url');
}
function decode(token) {
  const [value, signature, extra] = token.split('.');
  if (!value || !signature || extra || !/^[a-zA-Z0-9_-]+$/.test(value) || !/^[a-zA-Z0-9_-]+$/.test(signature)) throw conflict('This removal review is no longer valid. Refresh the review before confirming.');
  const expected = Buffer.from(createHmac('sha256', reviewKey).update(value).digest('base64url'));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw conflict('This removal review is no longer valid. Refresh the review before confirming.');
  let payload;
  try { payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw conflict('This removal review is no longer valid. Refresh the review before confirming.'); }
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) throw conflict('This removal review expired. Refresh it and review the affected items again.');
  return payload;
}
async function targetFor(action, targetGroupId, source, expectedVersion) {
  if (action !== 'move') return null;
  const target = requireActive(await db.getInventoryGroupById(targetGroupId));
  if (target.id === source.id || target.kind !== source.kind) throw conflict('Move all items to a different active group of the same kind. Food stock and supplies groups cannot be combined.');
  if (expectedVersion !== undefined && target.version !== expectedVersion) throw conflict('The destination group changed. Refresh the removal review before moving any items.');
  return groupSnapshot(target);
}
const movementRequestId = (requestId, itemId) => 'b59_' + hash([requestId, itemId]);

exports.context = (id) => {
  validation.identifier(id);
  return locked(async () => {
    const context = await state(id);
    const groups = await db.listInventoryGroups();
    return { ...context, ...statistics(context.members), destinations: groups.filter((group) =>
      !group.archived && !group.deletedAt && group.id !== id && group.kind === context.source.kind).map(groupSnapshot) };
  });
};
exports.preview = (id, input, actor) => {
  validation.identifier(id);
  const values = validation.preview(input);
  return locked(async () => {
    const context = await state(id);
    if (context.contextVersion !== values.contextVersion) throw conflict('This group or its items changed after the removal panel opened. Refresh the review before including the current records.');
    const target = await targetFor(values.action, values.targetGroupId, context.source, values.targetVersion);
    const totals = statistics(context.members);
    if (values.action === 'delete' && totals.itemCount) throw conflict('This group contains inventory records. Move all items or archive the group and its records instead.');
    if (values.action === 'archive' && totals.nonzeroCount && !values.reason) throw problem('Enter a reason before archiving records that still have recorded quantities.');
    const reason = values.reason || ({ delete: 'Empty inventory group removed', move: 'All inventory items moved to ' + target?.name, archive: 'Inventory group and all items archived' })[values.action];
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const reviewToken = encode({ actorId: actor.id, sourceGroupId: id, action: values.action, targetGroupId: target?.id || null,
      reason, fingerprint: fingerprint(context, target), expiresAt });
    return { reviewToken, action: values.action, source: context.source, target, members: context.members, ...totals, reason,
      expiresAt: new Date(expiresAt).toISOString() };
  });
};
exports.commit = (id, input, actor) => {
  validation.identifier(id);
  const body = validation.commit(input);
  return locked(async () => {
    const request = { body, sourceGroupId: id, actorId: actor.id };
    const repeated = await db.getInventoryGroupOperationByRequestId(body.requestId);
    if (repeated) {
      if (json(repeated.request) !== json(request)) throw conflict('This removal request was already used for different details, another group or another account.', 'GROUP_REMOVAL_REQUEST_CONFLICT');
      return { ...repeated.result, replayed: true };
    }
    const reviewed = decode(body.reviewToken);
    if (reviewed.actorId !== actor.id || reviewed.sourceGroupId !== id) throw conflict('This removal review belongs to another group or account. Open a new review.');
    const context = await state(id);
    const target = await targetFor(reviewed.action, reviewed.targetGroupId, context.source);
    if (reviewed.fingerprint !== fingerprint(context, target)) throw conflict('This group, its destination or any affected inventory record changed. Refresh the review before confirming.');
    const totals = statistics(context.members);
    if (reviewed.action === 'delete' && totals.itemCount) throw conflict('Only an empty group can be deleted. Refresh this removal review.');
    if (reviewed.action === 'archive' && totals.nonzeroCount && !body.acknowledgeRetainedStock) throw problem('Acknowledge that archived records will keep their recorded quantities before confirming.');
    for (const member of context.members) {
      if (member.version >= 2147483646) throw conflict('An inventory record reached its supported revision limit. Resolve it before removing this group.');
      if (await db.getInventoryMovementByRequestId(movementRequestId(body.requestId, member.id))) throw conflict('This removal request conflicts with an existing inventory operation. Review and use a new request identifier.');
    }
    if (context.source.version >= 2147483646) throw conflict('This group reached its supported revision limit. Resolve it before removal.');
    const recordedAt = new Date().toISOString();
    const groupChanges = { version: context.source.version + 1, updatedAt: recordedAt,
      ...(reviewed.action === 'archive' ? { archived: true, archivedAt: recordedAt } : { deletedAt: recordedAt }) };
    const sourceAfter = { ...context.source, ...groupChanges };
    const members = context.members.map((before) => ({ before, after: { ...before, version: before.version + 1,
      ...(reviewed.action === 'move' ? { groupId: target.id, category: target.name } : { archived: true, archivedAt: recordedAt }) },
    movementId: randomUUID() }));
    const result = { id: randomUUID(), action: reviewed.action, sourceBefore: context.source, sourceAfter, target,
      reason: reviewed.reason, ...totals, members, actorId: actor.id, actorUsername: actor.username, recordedAt };
    const operation = await db.createInventoryGroupOperation({ id: result.id, requestId: body.requestId, request, result,
      action: reviewed.action, sourceGroupId: id, targetGroupId: target?.id || null, actorId: actor.id, actorUsername: actor.username, recordedAt });
    await db.updateInventoryGroup(id, groupChanges);
    for (const member of members) {
      const changes = reviewed.action === 'move' ? { groupId: target.id, category: target.name, version: member.after.version } :
        { archived: true, archivedAt: recordedAt, version: member.after.version };
      await db.updateInventory(member.before.id, changes);
      await db.appendInventoryMovement({ id: member.movementId, itemId: member.before.id, groupOperationId: operation.id, type: 'details',
        delta: '0', beforeQuantity: member.before.quantity, afterQuantity: member.after.quantity,
        before: member.before, after: member.after, itemVersion: member.after.version, reason: reviewed.reason,
        actorId: actor.id, actorUsername: actor.username, occurredAt: recordedAt,
        requestId: movementRequestId(body.requestId, member.before.id), request: { operation: 'group-' + reviewed.action, groupOperationId: operation.id, actorId: actor.id } });
    }
    return { ...result, replayed: false };
  });
};
exports.get = (id) => db.withInventoryLock(async () => {
  validation.identifier(id, 'operationId');
  const row = await db.getInventoryGroupOperation(id);
  if (!row) throw problem('Inventory group operation not found.', 404);
  return row.result;
});
exports.byRequest = (requestId, actor) => db.withInventoryLock(async () => {
  v.requestId({ requestId });
  const row = await db.getInventoryGroupOperationByRequestId(requestId);
  if (row && row.actorId !== actor.id) throw conflict('This removal request belongs to another account.', 'GROUP_REMOVAL_REQUEST_CONFLICT');
  return row ? row.result : null;
});
