const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const time = require('../services/facilityTime');
const { amount } = require('../services/inventoryValidation');

async function stock(name, location) {
  const response = await request(app).post('/api/inventory').send({ name, category: 'Synthetic supplies',
    location, unit: 'pack', ingredientId: null, openingQuantity: '0.125', reorderThreshold: '0',
    reason: 'Synthetic physical count', requestId: randomUUID() });
  expect(response.status).toBe(201);
  return response.body.data;
}

test('batch receipt snapshots, ledger links and exact quantities survive PostgreSQL reconnection', async () => {
  const { connection, schema } = context();
  const items = await Promise.all([stock('Synthetic paper', 'Art shelf'), stock('Synthetic wipes', 'Closet')]);
  // Single-item receiving still works after migration 022 and does not acquire a
  // batch link merely because a later multi-item delivery includes the item.
  const legacy = await request(app).post('/api/inventory/' + items[0].id + '/purchases').send({
    quantity: '0.125', unit: 'pack', version: 1, receivedOn: time.dateAt(), supplier: null,
    totalCost: null, requestId: randomUUID(),
  });
  expect(legacy.status).toBe(201);
  expect((await db.listPurchaseReceipts())[0].batchId).toBeNull();
  items[0] = legacy.body.data.item;
  const body = { requestId: randomUUID(), receivedOn: time.dateAt(), supplier: 'Synthetic supplier',
    reason: 'Synthetic multi-item delivery', lines: items.map((item) => ({ itemId: item.id, version: item.version,
      quantity: '0.2', unit: 'pack', totalCost: null })) };
  const response = await request(app).post('/api/inventory/purchase-batches').send(body);
  expect(response.status).toBe(201);
  const saved = response.body.data.batch;
  expect(saved.lines).toHaveLength(2);
  const stored = await db.getPurchaseBatchByRequestId(body.requestId);
  expect(stored.id).toBe(saved.id);
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  const reopened = await request(app).get('/api/inventory/purchase-batches/' + saved.id);
  expect(reopened.status).toBe(200);
  expect(reopened.body.data).toEqual(saved);
  const replay = await request(app).post('/api/inventory/purchase-batches').send(body);
  expect(replay.status).toBe(201);
  expect(replay.body.data).toMatchObject({ batch: saved, replayed: true });
  expect(amount((await db.getInventoryById(items[0].id)).quantity)).toBe(amount('0.45'));
  expect(amount((await db.getInventoryById(items[1].id)).quantity)).toBe(amount('0.325'));
  expect(await db.countPurchaseBatches()).toBe(1);
  expect(await db.countPurchaseReceipts()).toBe(3);
  const receipts = await db.listPurchaseReceipts();
  for (const line of saved.lines) {
    const receipt = receipts.find((row) => row.id === line.receiptId);
    expect(receipt).toMatchObject({ batchId: saved.id, movementId: line.movementId, itemId: line.itemId });
    const movements = await db.listInventoryMovements(line.itemId);
    expect(movements.find((row) => row.id === line.movementId)).toMatchObject({ batchId: saved.id });
  }
  await expect(connection.query(`DELETE FROM "${schema}"."PurchaseBatches" WHERE "id" = :id`, {
    replacements: { id: saved.id },
  })).rejects.toMatchObject({ original: { code: '23503' } });
  await expect(connection.query(`UPDATE "${schema}"."PurchaseReceipts" SET "batchId" = 'missing-batch' WHERE "id" = :id`, {
    replacements: { id: legacy.body.data.receipt.id },
  })).rejects.toMatchObject({ original: { code: '23503' } });
  const meta = await connection.query(`SELECT "name" FROM "${schema}"."SequelizeMeta" WHERE "name" = '022-purchase-batches'`, { type: QueryTypes.SELECT });
  expect(meta).toEqual([{ name: '022-purchase-batches' }]);
});

test('PostgreSQL rejects malformed batch snapshots and missing linked-reference keys without NULL escapes', async () => {
  const { connection, schema } = context();
  const actor = request.credentials().account;
  const calculationKey = 'a'.repeat(64);
  const ref = { weekStart: '2026-10-19', version: 1, stockTakenAt: '2026-10-15T10:00:00.000Z', calculationKey };
  const saved = await db.createPurchaseBatch({ id: randomUUID(), requestId: randomUUID(), request: { lines: [{ itemId: 'synthetic-item' }] },
    receivedOn: time.dateAt(), supplier: null, reason: 'Synthetic constraint check', currency: 'USD',
    actorId: actor.id, actorUsername: actor.username, recordedAt: new Date(), purchasingRef: ref,
    purchasingWeekStart: ref.weekStart, purchasingCalculationKey: calculationKey,
    lines: [{ itemId: 'synthetic-item', stockDelta: '1' }] });
  const update = (field, value) => connection.query(`UPDATE "${schema}"."PurchaseBatches" SET "${field}" = CAST(:value AS jsonb) WHERE "id" = :id`, {
    replacements: { value: JSON.stringify(value), id: saved.id },
  });
  for (const missing of ['weekStart', 'version', 'stockTakenAt', 'calculationKey']) {
    const removed = { ...ref }; delete removed[missing];
    await expect(update('purchasingRef', removed)).rejects.toMatchObject({ original: { code: '23514' } });
    await expect(update('purchasingRef', { ...ref, [missing]: null })).rejects.toMatchObject({ original: { code: '23514' } });
  }
  await expect(update('purchasingRef', null)).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(update('request', null)).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(update('request', [])).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(update('lines', [])).rejects.toMatchObject({ original: { code: '23514' } });
  await expect(update('lines', Array.from({ length: 51 }, () => ({ itemId: 'synthetic-item' })))).rejects.toMatchObject({ original: { code: '23514' } });
  const duplicate = { ...saved, id: randomUUID() };
  await expect(db.createPurchaseBatch(duplicate)).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  expect(await db.getPurchaseBatchById(saved.id)).toEqual(saved);
});
