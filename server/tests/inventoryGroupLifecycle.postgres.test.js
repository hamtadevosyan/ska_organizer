const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const { amount } = require('../services/inventoryValidation');

test('migration 023 preserves populated 022 stock, group metadata and original history and purchasing JSON', async () => {
  const { connection } = context();
  const schema = 'skao_group_023_upgrade_' + randomUUID().replaceAll('-', '');
  const directory = path.join(__dirname, '../database/migrations');
  const previous = fs.readdirSync(directory).filter((filename) => /^\d{3}-.+\.js$/.test(filename) && filename < '023-').sort();
  const table = (tableName) => ({ tableName, schema });
  const recordedAt = new Date('2026-10-12T09:30:00.000Z');
  const actor = { id: 'synthetic-legacy-actor', username: 'synthetic-legacy-user' };
  const groupRequestId = randomUUID();
  const groupRequest = { payload: { name: 'Legacy food', requestId: groupRequestId }, actorId: actor.id };
  const beforeSnapshot = { id: 'legacy-food', name: 'Original oats', groupId: 'legacy-food-group', category: 'Legacy food',
    location: 'Kitchen / Pantry / Shelf 2', unit: 'lb', ingredientId: 'legacy-oats', quantity: '2', reorderThreshold: '1', version: 6 };
  const afterSnapshot = { ...beforeSnapshot, quantity: '2.125', version: 7 };
  const movementRequest = { operation: 'purchase', itemId: 'legacy-food', actorId: actor.id,
    payload: { quantity: '0.125', unit: 'lb', supplier: 'Original supplier', requestId: 'legacy-received-request' } };
  const purchasingSnapshot = { weekStart: '2026-10-12', stockTakenAt: '2026-10-12T08:00:00.000Z',
    includeMeals: true, roomIds: [], lowStockTargets: [], mealPlan: { version: 3, savedAt: '2026-10-11T18:00:00.000Z' }, activityPlans: [], issues: [],
    lines: [{ id: 'inventory:legacy-food', itemId: 'legacy-food', name: 'Original oats', ingredientId: 'legacy-oats',
      location: afterSnapshot.location, unit: 'lb', needed: '4', inStorage: '2', toBuy: '2', buyQuantity: '2.25', selected: true, checked: true,
      stockItems: [{ id: 'legacy-food', name: 'Original oats', location: afterSnapshot.location, unit: 'lb', quantity: '2', version: 6, allocated: '2' }],
      sources: [{ kind: 'meal', label: 'Original saved breakfast', quantity: '4', unit: 'lb' }], notes: ['Original review note'] }] };
  let created = false;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async (transaction) => {
      const qi = connection.getQueryInterface();
      await qi.createTable(table('SequelizeMeta'), { name: { type: DataTypes.STRING, primaryKey: true, allowNull: false } }, { transaction });
      for (const filename of previous) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await qi.bulkInsert(table('SequelizeMeta'), [{ name: filename.slice(0, -3) }], { transaction });
      }
      await qi.bulkInsert(table('Accounts'), [{ id: actor.id, username: actor.username, displayName: 'Synthetic legacy actor',
        passwordHash: 'Synthetic unused fixture hash', role: 'admin', disabled: false, mustChangePassword: false,
        createdAt: recordedAt, updatedAt: recordedAt }], { transaction });
      await qi.bulkInsert(table('Ingredients'), [{ id: 'legacy-oats', name: 'Original oats', unit: 'lb', shelfLifeDays: 180,
        createdAt: recordedAt, updatedAt: recordedAt }], { transaction });
      await connection.query(`INSERT INTO "${schema}"."InventoryGroups"
        (id, name, "nameKey", kind, description, "requestId", request, "createdAt", "updatedAt") VALUES
        ('legacy-food-group', 'Legacy food', 'legacy food', 'food', 'Original kitchen stock', $1, CAST($2 AS jsonb), $3, $3),
        ('legacy-supplies-group', 'Legacy materials', 'legacy materials', 'supplies', 'Original art stock', NULL, NULL, $3, $3)`,
      { bind: [groupRequestId, JSON.stringify(groupRequest), recordedAt], transaction });
      await qi.bulkInsert(table('InventoryItems'), [
        { id: 'legacy-food', name: 'Original oats', category: 'Legacy food', groupId: 'legacy-food-group', location: afterSnapshot.location,
          ingredientId: 'legacy-oats', unit: 'lb', quantity: '2.125000', reorderThreshold: '1.000000', version: 7, createdAt: recordedAt, updatedAt: recordedAt },
        { id: 'legacy-material', name: 'Original art supply', category: 'Legacy materials', groupId: 'legacy-supplies-group', location: 'Studio / Drawer 1',
          ingredientId: null, unit: 'count', quantity: '0.000001', reorderThreshold: '0.000100', version: 3, createdAt: recordedAt, updatedAt: recordedAt },
      ], { transaction });
      await connection.query(`INSERT INTO "${schema}"."InventoryMovements"
        (id, "itemId", type, delta, "beforeQuantity", "afterQuantity", reason, "actorId", "actorUsername", "occurredAt", "itemVersion", "before", "after", "requestId", request)
        VALUES ('legacy-movement', 'legacy-food', 'addition', 0.125000, 2.000000, 2.125000, 'Original received stock', $1, $2, $3, 7, CAST($4 AS jsonb), CAST($5 AS jsonb), 'legacy-received-request', CAST($6 AS jsonb))`,
      { bind: [actor.id, actor.username, recordedAt, JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), JSON.stringify(movementRequest)], transaction });
      await connection.query(`INSERT INTO "${schema}"."PurchaseReceipts"
        (id, "itemId", "movementId", quantity, unit, "receivedOn", supplier, "totalCost", currency, "itemSnapshot", "actorId", "actorUsername", "recordedAt")
        VALUES ('legacy-receipt', 'legacy-food', 'legacy-movement', 0.125000, 'lb', '2026-10-12', 'Original supplier', NULL, 'USD', CAST($1 AS jsonb), $2, $3, $4)`,
      { bind: [JSON.stringify(afterSnapshot), actor.id, actor.username, recordedAt], transaction });
      await connection.query(`INSERT INTO "${schema}"."PurchasingLists" ("weekStart", version, snapshot, "savedAt")
        VALUES ('2026-10-12', 4, CAST($1 AS jsonb), $2)`, { bind: [JSON.stringify(purchasingSnapshot), recordedAt], transaction });
    });
    const read = async (name) => (await connection.query(`SELECT * FROM "${schema}"."${name}" ORDER BY ${name === 'PurchasingLists' ? '"weekStart"' : 'id'}`))[0];
    const before = { groups: await read('InventoryGroups'), items: await read('InventoryItems'), movements: await read('InventoryMovements'),
      receipts: await read('PurchaseReceipts'), purchasing: await read('PurchasingLists') };
    expect(before.groups.every((row) => !Object.hasOwn(row, 'archived') && !Object.hasOwn(row, 'version'))).toBe(true);
    expect(before.items.every((row) => !Object.hasOwn(row, 'archived'))).toBe(true);
    expect(before.purchasing[0].snapshot).toEqual(purchasingSnapshot);
    const [originalJson] = await connection.query(`SELECT "before"::text AS before_json, "after"::text AS after_json, request::text AS request_json FROM "${schema}"."InventoryMovements"`);
    const [originalPurchasingJson] = await connection.query(`SELECT snapshot::text AS snapshot_json FROM "${schema}"."PurchasingLists"`);
    expect(await migrate(connection, schema)).toEqual(['023-inventory-group-lifecycle', '024-classroom-account-scope', '025-teacher-care-access', '026-staff-account-links']);
    const groups = await read('InventoryGroups'); const items = await read('InventoryItems'); const movements = await read('InventoryMovements');
    expect(groups.map(({ version, archived, archivedAt, deletedAt, ...row }) => row)).toEqual(before.groups);
    expect(groups.every((row) => row.version === 1 && row.archived === false && row.archivedAt === null && row.deletedAt === null)).toBe(true);
    expect(items.map(({ archived, archivedAt, ...row }) => row)).toEqual(before.items);
    expect(items.every((row) => row.archived === false && row.archivedAt === null)).toBe(true);
    expect(items.find((row) => row.id === 'legacy-food')).toMatchObject({ version: 7, quantity: before.items.find((row) => row.id === 'legacy-food').quantity });
    expect(items.find((row) => row.id === 'legacy-material')).toMatchObject({ version: 3, quantity: before.items.find((row) => row.id === 'legacy-material').quantity });
    expect(movements.map(({ groupOperationId, ...row }) => row)).toEqual(before.movements);
    expect(movements.every((row) => row.groupOperationId === null)).toBe(true);
    expect(await read('PurchaseReceipts')).toEqual(before.receipts);
    expect(await read('PurchasingLists')).toEqual(before.purchasing);
    expect((await connection.query(`SELECT "before"::text AS before_json, "after"::text AS after_json, request::text AS request_json FROM "${schema}"."InventoryMovements"`))[0]).toEqual(originalJson);
    expect((await connection.query(`SELECT snapshot::text AS snapshot_json FROM "${schema}"."PurchasingLists"`))[0]).toEqual(originalPurchasingJson);
    expect(await read('InventoryGroupOperations')).toEqual([]);
    expect(await migrate(connection, schema)).toEqual([]);
    expect(await read('InventoryGroups')).toEqual(groups);
    expect(await read('InventoryItems')).toEqual(items);
    expect(await read('InventoryMovements')).toEqual(movements);
    expect(await read('PurchasingLists')).toEqual(before.purchasing);
  } finally { if (created) await connection.dropSchema(schema, { cascade: true }); }
});

async function group(name) {
  const response = await request(app).post('/api/inventory/groups').send({ name, kind: 'supplies', description: '', requestId: randomUUID() });
  expect(response.status).toBe(201); return response.body.data;
}
async function stock(parent, name) {
  const response = await request(app).post('/api/inventory').send({ name, groupId: parent.id, location: 'Synthetic art shelf',
    unit: 'pack', openingQuantity: '1.125', reorderThreshold: '0.25', ingredientId: null,
    reason: 'Synthetic physical count', requestId: randomUUID() });
  expect(response.status).toBe(201); return response.body.data;
}
async function remove(source, action, changes = {}) {
  const contextResponse = await request(app).get('/api/inventory/groups/' + source.id + '/removal-context');
  expect(contextResponse.status).toBe(200);
  const preview = await request(app).post('/api/inventory/groups/' + source.id + '/removal-preview').send({
    action, contextVersion: contextResponse.body.data.contextVersion, ...changes,
  });
  expect(preview.status).toBe(200);
  const body = { requestId: randomUUID(), reviewToken: preview.body.data.reviewToken, acknowledgeRetainedStock: action === 'archive' };
  const response = await request(app).post('/api/inventory/groups/' + source.id + '/removal').send(body);
  expect(response.status).toBe(201);
  return { receipt: response.body.data, body };
}

test('group moves, immutable operation receipts and ledger references survive PostgreSQL reconnection', async () => {
  const { connection, schema } = context();
  const source = await group('Synthetic source'); const target = await group('Synthetic destination');
  const items = [await stock(source, 'Synthetic paper'), await stock(source, 'Synthetic glue')];
  const before = await Promise.all(items.map((row) => db.getInventoryById(row.id)));
  const histories = await Promise.all(items.map((row) => db.listInventoryMovements(row.id)));
  const { receipt, body } = await remove(source, 'move', { targetGroupId: target.id, targetVersion: target.version, reason: 'Synthetic storage organization' });
  expect(receipt).toMatchObject({ action: 'move', itemCount: 2, replayed: false, sourceBefore: { name: source.name }, target: { id: target.id } });
  const stored = await db.getInventoryGroupOperation(receipt.id);
  expect(stored.result.members).toHaveLength(2);
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema });
  expect((await request(app).get('/api/inventory/group-operations/' + receipt.id)).body.data).toEqual(stored.result);
  const replay = await request(app).post('/api/inventory/groups/' + source.id + '/removal').send(body);
  expect(replay.status).toBe(201); expect(replay.body.data).toEqual({ ...stored.result, replayed: true });
  expect(await db.listInventoryInGroup(source.id)).toEqual([]);
  expect((await db.getInventoryGroupById(source.id)).deletedAt).not.toBeNull();
  for (let index = 0; index < items.length; index++) {
    const after = await db.getInventoryById(items[index].id);
    expect(after).toMatchObject({ groupId: target.id, category: target.name, version: 2 });
    for (const field of ['id', 'name', 'location', 'unit', 'ingredientId', 'quantity', 'reorderThreshold']) expect(after[field]).toEqual(before[index][field]);
    const moves = await db.listInventoryMovements(after.id);
    expect(moves).toHaveLength(2);
    expect(moves.find((row) => row.id === histories[index][0].id)).toEqual(histories[index][0]);
    expect(moves[0]).toMatchObject({ groupOperationId: receipt.id, type: 'details', itemVersion: 2 });
    expect(amount(moves[0].delta)).toBe(0n);
    expect(amount(moves[0].beforeQuantity)).toBe(amount(moves[0].afterQuantity));
  }
  await expect(connection.query(`DELETE FROM "${schema}"."InventoryGroupOperations" WHERE "id" = :id`, { replacements: { id: receipt.id } }))
    .rejects.toMatchObject({ original: { code: '23503' } });
  await expect(connection.query(`DELETE FROM "${schema}"."InventoryGroups" WHERE "id" = :id`, { replacements: { id: source.id } }))
    .rejects.toMatchObject({ original: { code: '23503' } });
});

test('removed tombstones release names while archives reserve them and preserve nonzero exact balances', async () => {
  const source = await group('Synthetic reusable name');
  const { receipt } = await remove(source, 'delete');
  expect(receipt.members).toEqual([]);
  const replacement = await group(source.name);
  expect(replacement.id).not.toBe(source.id);
  expect((await db.getInventoryGroupById(source.id)).name).toBe(source.name);
  const archived = await group('Synthetic archived name');
  const item = await stock(archived, 'Synthetic retained supplies');
  const before = await db.getInventoryById(item.id);
  const archivedReceipt = await remove(archived, 'archive', { reason: 'Keep a read-only historical stock record' });
  expect(archivedReceipt.receipt).toMatchObject({ action: 'archive', nonzeroCount: 1 });
  const after = await db.getInventoryById(item.id);
  expect(after.archived).toBe(true);
  expect(after.quantity).toEqual(before.quantity);
  expect(amount(after.quantity)).toBe(amount('1.125'));
  expect((await db.listInventoryGroups()).map((row) => row.id)).not.toContain(archived.id);
  expect((await db.listInventoryGroups({ archived: true })).map((row) => row.id)).toContain(archived.id);
  expect(await db.listInventory({ groupId: archived.id })).toEqual([]);
  expect((await db.listInventory({ groupId: archived.id, archived: true })).map((row) => row.id)).toEqual([item.id]);
  const duplicate = await request(app).post('/api/inventory/groups').send({ name: archived.name, kind: 'supplies', description: '', requestId: randomUUID() });
  expect(duplicate.status).toBe(409);
  await expect(db.createInventoryGroup({ name: archived.name, nameKey: archived.name.toLowerCase(), kind: 'supplies', description: '' }))
    .rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
});

test('PostgreSQL constrains lifecycle states and final operation identities without JSON null escapes', async () => {
  const { connection, schema } = context();
  const source = await group('Synthetic SQL constraints');
  const item = await stock(source, 'Synthetic item');
  const active = await db.getInventoryGroupById(source.id);
  await expect(connection.query(`UPDATE "${schema}"."InventoryGroups" SET "archived" = true WHERE "id" = :id`, { replacements: { id: source.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  await expect(connection.query(`UPDATE "${schema}"."InventoryGroups" SET "version" = 0 WHERE "id" = :id`, { replacements: { id: source.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  await expect(connection.query(`UPDATE "${schema}"."InventoryItems" SET "archived" = true WHERE "id" = :id`, { replacements: { id: item.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  expect(await db.getInventoryGroupById(source.id)).toEqual(active);
  const { receipt } = await remove(source, 'archive', { reason: 'Synthetic archival constraint test' });
  const stored = await db.getInventoryGroupOperation(receipt.id);
  const updateResult = (result) => connection.query(`UPDATE "${schema}"."InventoryGroupOperations" SET "result" = CAST(:result AS jsonb) WHERE "id" = :id`, {
    replacements: { result: JSON.stringify(result), id: receipt.id },
  });
  for (const key of ['id', 'action', 'sourceBefore', 'sourceAfter']) {
    const missing = structuredClone(stored.result); delete missing[key];
    await expect(updateResult(missing)).rejects.toMatchObject({ original: { code: '23514' } });
    await expect(updateResult({ ...stored.result, [key]: null })).rejects.toMatchObject({ original: { code: '23514' } });
  }
  await expect(connection.query(`UPDATE "${schema}"."InventoryGroupOperations" SET "request" = 'null'::jsonb WHERE "id" = :id`, { replacements: { id: receipt.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  await expect(connection.query(`UPDATE "${schema}"."InventoryGroupOperations" SET "targetGroupId" = :source WHERE "id" = :id`, { replacements: { source: source.id, id: receipt.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  await expect(db.createInventoryGroupOperation({ ...stored, id: randomUUID() })).rejects.toThrow();
  expect(await db.getInventoryGroupOperation(receipt.id)).toEqual(stored);
});
