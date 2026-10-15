const db = require('../services/dbAdapter');
const { amount } = require('../services/inventoryValidation');

const snapshot = (changes = {}) => ({
  weekStart: '2026-10-19', stockTakenAt: '2026-10-14T12:00:00.000Z',
  includeMeals: false, roomIds: [], lowStockTargets: [], mealPlan: null, activityPlans: [], issues: [],
  lines: [{ id: 'item:paper', itemId: 'paper', ingredientId: null, name: 'Paper', unit: 'count', location: 'Art shelf',
    needed: '20', inStorage: '5', toBuy: '15', buyQuantity: '18.125', selected: true, checked: false,
    stockItems: [{ id: 'paper', name: 'Paper', location: 'Art shelf', unit: 'count', quantity: '5', version: 1, allocated: '5' }],
    sources: [{ kind: 'activity', label: 'Monday collage', quantity: '20', unit: 'count', roomId: 'room-1', date: '2026-10-19' }], notes: [] }],
  ...changes,
});

test('purchasing choices and sampled stock persist as independent snapshots', async () => {
  expect(await db.getPurchasingList('2026-10-19')).toBeNull();
  const input = snapshot();
  const first = await db.savePurchasingList(input, 0);
  expect(first).toMatchObject({ ...input, version: 1 });
  expect(new Date(first.savedAt).toISOString()).toBe(first.savedAt);
  input.lines[0].buyQuantity = '999';
  first.lines[0].stockItems[0].quantity = '999';
  expect((await db.getPurchasingList(input.weekStart)).lines[0]).toMatchObject({ buyQuantity: '18.125', stockItems: [{ quantity: '5' }] });

  const updated = await db.getPurchasingList(input.weekStart);
  updated.lines[0].checked = true;
  updated.lines[0].selected = false;
  expect(await db.savePurchasingList(updated, 1)).toMatchObject({ version: 2, stockTakenAt: input.stockTakenAt,
    lines: [{ buyQuantity: '18.125', selected: false, checked: true, inStorage: '5' }] });
  await expect(db.savePurchasingList(snapshot(), 1)).rejects.toMatchObject({ status: 409 });
  expect((await db.getPurchasingList(input.weekStart)).version).toBe(2);
  expect(await db.listAllInventory()).toEqual([]);
  expect(await db.countPurchaseReceipts()).toBe(0);
  expect(await db.getWeeklyPlan(input.weekStart)).toBeNull();
});

test('two first saves cannot silently overwrite one another', async () => {
  const outcomes = await Promise.allSettled([
    db.savePurchasingList(snapshot(), 0),
    db.savePurchasingList(snapshot({ includeMeals: true }), 0),
  ]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect(outcomes.find(value => value.status === 'rejected').reason).toMatchObject({ status: 409 });
  expect((await db.getPurchasingList('2026-10-19')).version).toBe(1);
});

test('a failed outer transaction rolls back both a new list and subsequent choices', async () => {
  await expect(db.withPurchasingLock(async () => {
    await db.savePurchasingList(snapshot(), 0);
    throw new Error('Synthetic audited save failure');
  })).rejects.toThrow('Synthetic audited save failure');
  expect(await db.getPurchasingList('2026-10-19')).toBeNull();
  const saved = await db.savePurchasingList(snapshot(), 0);
  await expect(db.withTransaction(async () => {
    await db.savePurchasingList(snapshot({ lines: [] }), 1);
    throw new Error('Synthetic audit append failure');
  })).rejects.toThrow('Synthetic audit append failure');
  expect(await db.getPurchasingList('2026-10-19')).toEqual(saved);
});

test('purchasing stock reads all records in stable ID order without a fifty-item limit', async () => {
  const group = await db.createInventoryGroup({ name: 'Synthetic art', nameKey: 'synthetic art', kind: 'supplies', description: '' });
  for (let index = 60; index >= 0; index--) {
    await db.createInventory({ id: 'inventory-' + String(index).padStart(2, '0'), name: 'Paper ' + index,
      category: 'Supplies', location: 'Shelf ' + index, groupId: group.id,
      unit: 'count', quantity: '0.125', reorderThreshold: '1', version: 1 });
  }
  const rows = await db.listAllInventory();
  expect(rows).toHaveLength(61);
  expect(rows.map(row => row.id)).toEqual(Array.from({ length: 61 }, (_, index) => 'inventory-' + String(index).padStart(2, '0')));
  expect(rows[0]).toMatchObject({ location: 'Shelf 0', version: 1 });
  // DECIMAL(18,6) reads retain trailing zeros in PostgreSQL. Compare exact
  // quantities, then preserve the raw record for the no-alias check below.
  expect(amount(rows[0].quantity)).toBe(amount('0.125'));
  const storedBefore = structuredClone(rows[0]);
  rows[0].quantity = '999';
  const storedAfter = await db.getInventoryById(rows[0].id);
  expect(amount(storedAfter.quantity)).toBe(amount('0.125'));
  expect(storedAfter).toEqual(storedBefore);
});
