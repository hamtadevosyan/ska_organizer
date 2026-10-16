const { randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const { amount } = require('../services/inventoryValidation');

const calculationKey = 'a'.repeat(64);
function batch(changes = {}) {
  const actor = request.credentials().account;
  const purchasingRef = { weekStart: '2026-10-19', version: 1, stockTakenAt: '2026-10-15T10:00:00.000Z', calculationKey };
  return {
    id: randomUUID(), requestId: randomUUID(), request: { actorId: actor.id, lines: [{ itemId: 'synthetic-paper', quantity: '2.125' }] },
    receivedOn: '2026-10-15', supplier: null, reason: 'Synthetic delivery', currency: 'USD',
    actorId: actor.id, actorUsername: actor.username, recordedAt: '2026-10-15T12:00:00.000Z',
    purchasingRef, purchasingWeekStart: purchasingRef.weekStart, purchasingCalculationKey: calculationKey,
    lines: [{ itemId: 'synthetic-paper', name: 'Paper', location: 'Art shelf', quantity: '2.125', unit: 'pack',
      stockUnit: 'pack', stockDelta: '2.125', beforeQuantity: '1', afterQuantity: '3.125',
      totalCost: null, versionBefore: 1, versionAfter: 2, purchasingLineId: 'item:synthetic-paper',
      plannedQuantity: '4', previouslyReceived: '0', remainingQuantity: '1.875', notes: [] }],
    ...changes,
  };
}

test('batch receipts retain original source snapshots and independent JSON values', async () => {
  expect(await db.getPurchaseBatchByRequestId('not-recorded')).toBeNull();
  const input = batch();
  const original = structuredClone(input);
  const saved = await db.createPurchaseBatch(input);
  expect(saved).toMatchObject({ id: original.id, requestId: original.requestId, request: original.request,
    purchasingRef: original.purchasingRef, lines: original.lines });
  expect(new Date(saved.recordedAt).toISOString()).toBe(original.recordedAt);
  input.request.lines[0].quantity = '999';
  saved.lines[0].afterQuantity = '999';
  expect(await db.getPurchaseBatchById(original.id)).toMatchObject({ request: original.request, lines: original.lines });
  const completed = original.lines.map((line) => ({ ...line, receiptId: 'receipt-1', movementId: 'movement-1' }));
  await db.updatePurchaseBatch(original.id, { lines: completed });
  completed[0].afterQuantity = '999';
  const loaded = await db.getPurchaseBatchByRequestId(original.requestId);
  expect(loaded.lines[0]).toMatchObject({ afterQuantity: '3.125', receiptId: 'receipt-1', movementId: 'movement-1' });
  await expect(db.createPurchaseBatch(batch({ requestId: original.requestId }))).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  expect(await db.countPurchaseBatches()).toBe(1);
});

test('history pagination is stable while fulfillment includes only its saved stock calculation', async () => {
  const records = [
    batch({ id: 'batch-a', recordedAt: '2026-10-15T12:00:00.000Z' }),
    batch({ id: 'batch-b', recordedAt: '2026-10-15T12:00:00.000Z' }),
    batch({ id: 'batch-c', recordedAt: '2026-10-15T13:00:00.000Z', purchasingRef: null, purchasingWeekStart: null, purchasingCalculationKey: null }),
    batch({ id: 'batch-d', recordedAt: '2026-10-15T14:00:00.000Z', purchasingCalculationKey: 'b'.repeat(64),
      purchasingRef: { weekStart: '2026-10-19', version: 2, stockTakenAt: '2026-10-15T13:30:00.000Z', calculationKey: 'b'.repeat(64) } }),
  ];
  for (const record of records) await db.createPurchaseBatch(record);
  expect((await db.listPurchaseBatches({ page: 1, pageSize: 2 })).map((row) => row.id)).toEqual(['batch-d', 'batch-c']);
  expect((await db.listPurchaseBatches({ page: 2, pageSize: 2 })).map((row) => row.id)).toEqual(['batch-b', 'batch-a']);
  expect(await db.listPurchaseBatches({ page: 3, pageSize: 2 })).toEqual([]);
  const linked = await db.listPurchaseBatchesForCalculation('2026-10-19', calculationKey);
  expect(linked.map((row) => row.id)).toEqual(['batch-a', 'batch-b']);
  linked[0].lines[0].stockDelta = '999';
  expect((await db.getPurchaseBatchById('batch-a')).lines[0].stockDelta).toBe('2.125');
  expect(await db.listPurchaseBatchesForCalculation('2026-10-26', calculationKey)).toEqual([]);
  expect(await db.countPurchaseBatches()).toBe(4);
});

test('an outer transaction rolls back new batch headers, snapshot updates and stock together', async () => {
  const group = await db.createInventoryGroup({ name: 'Synthetic supplies', nameKey: 'synthetic supplies', kind: 'supplies', description: '' });
  const item = await db.createInventory({ name: 'Paper', groupId: group.id, category: 'Art', location: 'Art shelf',
    unit: 'pack', quantity: '1.125', reorderThreshold: '0', version: 1 });
  const existing = await db.createPurchaseBatch(batch());
  const fresh = batch();
  await expect(db.withInventoryLock(async () => {
    await db.createPurchaseBatch(fresh);
    await db.updatePurchaseBatch(existing.id, { lines: existing.lines.map((line) => ({ ...line, receiptId: 'not-committed' })) });
    await db.updateInventory(item.id, { quantity: '99.125', version: 2 });
    throw new Error('Synthetic later receipt or audit failure');
  })).rejects.toThrow('Synthetic later receipt or audit failure');
  expect(await db.getPurchaseBatchById(fresh.id)).toBeNull();
  expect(await db.getPurchaseBatchById(existing.id)).toEqual(existing);
  expect(amount((await db.getInventoryById(item.id)).quantity)).toBe(amount('1.125'));
  expect((await db.getInventoryById(item.id)).version).toBe(1);
  expect(await db.countPurchaseBatches()).toBe(1);
});
