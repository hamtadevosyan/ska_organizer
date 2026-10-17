const { randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const { amount } = require('../services/inventoryValidation');

const at = '2026-10-16T12:00:00.000Z';
const group = (name, changes = {}) => db.createInventoryGroup({ name, nameKey: name.toLowerCase(), kind: 'supplies', description: '', ...changes });
const item = (parent, index, changes = {}) => db.createInventory({ id: 'member-' + String(index).padStart(3, '0'), name: 'Synthetic paper ' + index,
  groupId: parent.id, category: parent.name, location: 'Shelf ' + index, unit: 'pack', quantity: '0.125', reorderThreshold: '1', version: 1, ...changes });
function operation(source, changes = {}) {
  const actor = request.credentials().account;
  const id = randomUUID();
  return { id, requestId: randomUUID(), request: { body: { requestId: id, reviewToken: 'synthetic-token', acknowledgeRetainedStock: false }, sourceGroupId: source.id, actorId: actor.id },
    action: 'delete', sourceGroupId: source.id, targetGroupId: null, actorId: actor.id, actorUsername: actor.username, recordedAt: at,
    result: { id, action: 'delete', sourceBefore: { id: source.id, name: source.name, version: 1 }, sourceAfter: { id: source.id, name: source.name, version: 2, deletedAt: at },
      target: null, members: [], totals: [], itemCount: 0, nonzeroCount: 0, reason: 'Synthetic empty removal', actorId: actor.id, actorUsername: actor.username, recordedAt: at },
    ...changes };
}

test('group membership reads every retained row while normal stock selectors exclude inactive records and parents', async () => {
  const active = await group('Active supplies');
  const archived = await group('Archived supplies', { archived: true, archivedAt: at });
  const removed = await group('Removed supplies', { deletedAt: at });
  const ingredient = await db.createIngredient({ name: 'Synthetic stock food', unit: 'pack' });
  for (let index = 60; index >= 0; index--) await item(active, index, { archived: index === 30, archivedAt: index === 30 ? at : null });
  // A parent-state guard must work independently of item.archived. These rows
  // deliberately simulate an inconsistent old client without changing stock.
  await item(archived, 100, { ingredientId: ingredient.id });
  await item(removed, 101, { ingredientId: ingredient.id });
  await item(active, 102, { ingredientId: ingredient.id, archived: true, archivedAt: at });
  await item(archived, 103, { archived: true, archivedAt: at });
  const membership = await db.listInventoryInGroup(active.id);
  expect(membership).toHaveLength(62);
  expect(membership.map((row) => row.id)).toEqual([...membership.map((row) => row.id)].sort());
  expect(membership.find((row) => row.id === 'member-030').archived).toBe(true);
  expect(await db.countInventory()).toBe(60);
  expect(await db.listAllInventory()).toHaveLength(60);
  expect(await db.listAllInventory({ archived: true })).toHaveLength(3);
  expect(await db.listAllInventory({ includeArchived: true })).toHaveLength(64);
  expect((await db.listInventoryGroups()).map((row) => row.id)).toEqual([active.id]);
  expect((await db.listInventoryGroups({ archived: true })).map((row) => row.id)).toEqual([archived.id]);
  expect(await db.listInventoryGroups({ includeArchived: true })).toHaveLength(2);
  expect(await db.listInventoryGroups({ includeArchived: true, includeDeleted: true })).toHaveLength(3);
  const options = await db.inventoryOptions();
  expect(options.categories).toEqual([active.name]);
  expect(options.locations).not.toEqual(expect.arrayContaining(['Shelf 30', 'Shelf 100', 'Shelf 101', 'Shelf 102', 'Shelf 103']));
  expect((await db.inventoryGroupCounts()).find((row) => row.groupId === active.id)).toMatchObject({ total: 60, lowStock: 60 });
  expect((await db.inventoryGroupCounts({ archived: true })).find((row) => row.groupId === active.id)).toMatchObject({ total: 2 });
  expect(await db.listInventoryForIngredients([ingredient.id])).toEqual([]);
  expect(await db.ingredientHasQuantities(ingredient.id)).toBe(true);
  expect((await db.getInventoryById('member-100')).groupId).toBe(archived.id);
  expect((await db.getInventoryGroupById(removed.id)).name).toBe(removed.name);
});

test('a removed group retains its identity while releasing its name and operations retain immutable result snapshots', async () => {
  const source = await group('Synthetic group', { requestId: randomUUID(), request: { name: 'Synthetic group' } });
  const input = operation(source);
  const expectedResult = structuredClone(input.result);
  const saved = await db.createInventoryGroupOperation(input);
  await db.updateInventoryGroup(source.id, { deletedAt: at, version: 2 });
  expect(await db.getInventoryGroupByName(source.nameKey)).toBeNull();
  expect(await db.getInventoryGroupByRequestId(source.requestId)).toMatchObject({ id: source.id, deletedAt: expect.anything() });
  const replacement = await group(source.name);
  expect(replacement.id).not.toBe(source.id);
  expect((await db.getInventoryGroupByName(source.nameKey)).id).toBe(replacement.id);
  input.result.sourceBefore.name = 'Changed input';
  saved.result.sourceBefore.name = 'Changed returned object';
  expect((await db.getInventoryGroupOperation(saved.id)).result).toEqual(expectedResult);
  expect((await db.getInventoryGroupOperationByRequestId(saved.requestId)).result).toEqual(expectedResult);
  await expect(db.createInventoryGroupOperation(operation(source, { requestId: saved.requestId }))).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
});

test('lifecycle writes and their operation header roll back with a failed outer audited transaction', async () => {
  const source = await group('Synthetic rollback source');
  const stock = await item(source, 1);
  const before = await db.getInventoryById(stock.id);
  const pending = operation(source);
  await expect(db.withInventoryLock(async () => {
    await db.createInventoryGroupOperation(pending);
    await db.updateInventoryGroup(source.id, { archived: true, archivedAt: at, version: 2 });
    await db.updateInventory(stock.id, { archived: true, archivedAt: at, version: 2 });
    throw new Error('Synthetic later movement or audit failure');
  })).rejects.toThrow('Synthetic later movement or audit failure');
  expect(await db.getInventoryGroupOperation(pending.id)).toBeNull();
  expect(await db.getInventoryGroupById(source.id)).toEqual(source);
  expect(await db.getInventoryById(stock.id)).toEqual(before);
  expect(amount((await db.getInventoryById(stock.id)).quantity)).toBe(amount('0.125'));
});
