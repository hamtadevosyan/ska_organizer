const { randomUUID } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const time = require('../services/facilityTime');
const { amount, decimal } = require('../services/inventoryValidation');
const service = require('../services/batchPurchaseService');

const base = '/api/inventory/purchase-batches';
const weekStart = '2026-10-12';
let first, second;
async function stock(name, unit = 'g', openingQuantity = '3') {
  const response = await request(app).post('/api/inventory').send({ name, category: 'Supplies', location: name + ' shelf', unit,
    openingQuantity, reorderThreshold: '5', reason: 'Physical opening count', requestId: randomUUID() });
  expect(response.status).toBe(201);
  return response.body.data;
}
const quantity = async (item) => decimal(amount((await db.getInventoryById(item.id)).quantity));
const line = (item, changes = {}) => ({ itemId: item.id, version: item.version, quantity: '2.5', unit: item.unit, totalCost: null, ...changes });
const payload = (changes = {}) => ({ requestId: randomUUID(), receivedOn: time.dateAt(), supplier: 'Synthetic supplier',
  reason: 'Actual goods checked on arrival', lines: [line(first), line(second)], ...changes });
async function api(method, url, body, status = 200) {
  const response = await request(app)[method](url).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status >= 400 ? expect.anything() : undefined });
  return response.body.data;
}
const receive = (body, status = 201) => api('post', base, body, status);
async function savedPurchasing(overrides = {}) {
  const list = { weekStart, stockTakenAt: '2026-10-12T08:00:00Z', includeMeals: false, roomIds: [],
    lowStockTargets: [{ itemId: first.id, targetQuantity: '13' }], mealPlan: null, activityPlans: [], issues: [],
    lines: [{ id: 'inventory:' + first.id, itemId: first.id, name: first.name, location: first.location,
      unit: first.unit, needed: '13', inStorage: '3', toBuy: '10', buyQuantity: '10', selected: true, checked: false,
      sources: [{ kind: 'low-stock', quantity: '13', unit: first.unit }], stockItems: [], notes: [] }], ...overrides };
  return db.savePurchasingList(list, (await db.getPurchasingList(weekStart))?.version || 0);
}
const linkedPayload = (list, quantityValue = '4', item = first) => payload({ lines: [line(item, { quantity: quantityValue, purchasingLineId: list.lines[0].id })],
  purchasingRef: { weekStart, version: list.version } });

beforeEach(async () => {
  first = await stock('First synthetic item');
  second = await stock('Second synthetic item', 'pack', '0.1');
});

test('review computes exact stock and unknown costs without writing; one receipt commits every line with audit and traceable history', async () => {
  const body = payload({ lines: [line(first, { totalCost: '2' }), line(second)] });
  const review = await api('post', base + '/preview', body);
  expect(review.request.lines.find((value) => value.itemId === first.id).totalCost).toBe('2.00');
  expect(review.lines.find((value) => value.itemId === first.id)).toMatchObject({ quantity: '2.5', stockDelta: '2.5', beforeQuantity: '3', afterQuantity: '5.5', totalCost: '2.00', versionBefore: 1, versionAfter: 2 });
  expect(review.lines.find((value) => value.itemId === second.id)).toMatchObject({ totalCost: null, afterQuantity: '2.6' });
  expect(await db.countPurchaseBatches()).toBe(0);
  expect(await quantity(first)).toBe('3');
  const { batch, replayed } = await receive(body);
  expect(replayed).toBe(false);
  expect(batch).toMatchObject({ actorId: request.credentials().account.id, actorUsername: 'test-admin', receivedOn: body.receivedOn,
    currency: 'USD', supplier: 'Synthetic supplier', purchasingRef: null });
  expect(batch.lines).toHaveLength(2);
  for (const value of batch.lines) {
    expect(value.receiptId).toEqual(expect.any(String)); expect(value.movementId).toEqual(expect.any(String));
    expect(await db.getPurchaseByMovementId(value.movementId)).toMatchObject({ batchId: batch.id, itemId: value.itemId, quantity: expect.any(String) });
    expect((await db.listInventoryMovements(value.itemId)).find((row) => row.id === value.movementId)).toMatchObject({ batchId: batch.id, itemVersion: 2 });
  }
  expect(await quantity(first)).toBe('5.5'); expect(await quantity(second)).toBe('2.6');
  expect(await api('get', base + '/' + batch.id)).toEqual(batch);
  const listed = await request(app).get(base + '?page=1&pageSize=1');
  expect(listed.body).toMatchObject({ total: 1, page: 1, pageSize: 1, items: [batch], today: time.dateAt() });
  expect((await db.listAudit({ actions: ['inventory.purchase.batch'] }))[0]).toMatchObject({ entityId: batch.id, actorId: request.credentials().account.id });
  expect(batch).not.toHaveProperty('request'); expect(batch).not.toHaveProperty('requestId');
});

test('compatible received units retain the original amount and round the actual stock delta down, never guessing packages', async () => {
  const body = payload({ lines: [line(first, { quantity: '1', unit: 'lb' })] });
  const review = await api('post', base + '/preview', body);
  expect(review.lines[0]).toMatchObject({ quantity: '1', unit: 'lb', stockUnit: 'g', stockDelta: '453.59237', afterQuantity: '456.59237' });
  expect(review.lines[0].notes.join(' ')).toMatch(/rounds down/);
  const { batch } = await receive(body);
  expect(batch.lines[0]).toMatchObject({ quantity: '1', unit: 'lb', stockDelta: '453.59237' });
  expect(await db.getPurchaseByMovementId(batch.lines[0].movementId)).toMatchObject({ unit: 'g' });
  expect(amount((await db.getPurchaseByMovementId(batch.lines[0].movementId)).quantity)).toBe(amount('453.59237'));
  const pounds = await stock('Pounds location', 'lb', '0');
  const rounded = await api('post', base + '/preview', payload({ lines: [line(pounds, { quantity: '1', unit: 'g' })] }));
  expect(rounded.lines[0].stockDelta).toBe('0.002204');
  await receive(payload({ lines: [line(pounds, { quantity: '0.000001', unit: 'g' })] }), 422);
});

test('lost-response retries and canonical reordered input return the original receipt even after stock and linked list change', async () => {
  const saved = await savedPurchasing();
  const body = linkedPayload(saved);
  const original = (await receive(body)).batch;
  await db.updateInventory(first.id, { quantity: '1', unit: 'count', name: 'Renamed after receiving', version: 7 });
  await db.savePurchasingList({ ...saved, lines: [] }, 1);
  const retry = await receive({ ...body, supplier: '  Synthetic   supplier ', lines: body.lines.map((value) => ({ ...value, quantity: '4.000000' })) });
  expect(retry).toEqual({ batch: original, replayed: true });
  expect(await api('get', base + '/by-request/' + body.requestId)).toEqual(original);
  expect(await db.countPurchaseBatches()).toBe(1); expect(await db.countPurchaseReceipts()).toBe(1);
  expect(await quantity(first)).toBe('1');
});

test('reordered lines are an identical receipt but changing quantity, destination, cost or actor conflicts', async () => {
  const body = payload(); const saved = await receive(body);
  expect(await receive({ ...body, lines: body.lines.slice().reverse() })).toEqual({ ...saved, replayed: true });
  for (const changes of [{ quantity: '9' }, { totalCost: '0' }, { itemId: 'other-destination' }]) {
    await receive({ ...body, lines: [{ ...body.lines[0], ...changes }, body.lines[1]] }, 409);
  }
  await expect(service.receive(body, { id: 'another-account', username: 'another' })).rejects.toMatchObject({ status: 409, code: 'BATCH_REQUEST_CONFLICT' });
  await expect(service.byRequest(body.requestId, { id: 'another-account' })).rejects.toMatchObject({ status: 409 });
  expect(await db.countPurchaseBatches()).toBe(1);
});

test('simultaneous identical submissions apply once and competing stale receipts cannot partially commit', async () => {
  const body = payload();
  const duplicates = await Promise.all([receive(body), receive(body)]);
  expect(duplicates.map((value) => value.replayed).sort()).toEqual([false, true]);
  expect(duplicates[0].batch).toEqual(duplicates[1].batch);
  await receive({ ...body, requestId: randomUUID() }, 409);
  expect(await db.countPurchaseBatches()).toBe(1); expect(await quantity(first)).toBe('5.5');
});

test('two different simultaneous receipts cannot both reuse the same stock versions', async () => {
  const responses = await Promise.all([payload(), payload()].map((body) => request(app).post(base).send(body)));
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(await quantity(first)).toBe('5.5'); expect(await quantity(second)).toBe('2.6');
  expect(await db.countPurchaseBatches()).toBe(1); expect(await db.countPurchaseReceipts()).toBe(2);
});

test('zero cost is distinct from unknown cost and failed status lookup never invents a saved receipt', async () => {
  expect(await api('get', base + '/by-request/' + randomUUID())).toBeNull();
  const result = await receive(payload({ lines: [line(first, { totalCost: '0.0' }), line(second)] }));
  expect(result.batch.lines.find((value) => value.itemId === first.id).totalCost).toBe('0.00');
  expect(result.batch.lines.find((value) => value.itemId === second.id).totalCost).toBeNull();
});

test.each([
  ['duplicate destination', (body) => ({ ...body, lines: [body.lines[0], body.lines[0]] }), 400],
  ['empty receipt', (body) => ({ ...body, lines: [] }), 400],
  ['too many lines', (body) => ({ ...body, lines: Array.from({ length: 51 }, (_, index) => ({ ...body.lines[0], itemId: 'destination-' + index })) }), 400],
  ['unknown field', (body) => ({ ...body, actorId: 'spoofed' }), 400],
  ['unknown line field', (body) => ({ ...body, lines: [{ ...body.lines[0], stockDelta: '200' }] }), 400],
  ['negative quantity', (body) => ({ ...body, lines: [{ ...body.lines[0], quantity: '-1' }] }), 400],
  ['zero quantity', (body) => ({ ...body, lines: [{ ...body.lines[0], quantity: '0' }] }), 400],
  ['number instead of entered decimal', (body) => ({ ...body, lines: [{ ...body.lines[0], quantity: 2 }] }), 400],
  ['overprecision', (body) => ({ ...body, lines: [{ ...body.lines[0], quantity: '0.1234567' }] }), 400],
  ['cost overprecision', (body) => ({ ...body, lines: [{ ...body.lines[0], totalCost: '1.001' }] }), 400],
  ['negative cost', (body) => ({ ...body, lines: [{ ...body.lines[0], totalCost: '-1' }] }), 400],
  ['future date', (body) => ({ ...body, receivedOn: '9999-01-01' }), 400],
  ['invalid date', (body) => ({ ...body, receivedOn: '2026-02-30' }), 400],
  ['missing item', (body) => ({ ...body, lines: [{ ...body.lines[0], itemId: 'missing-item' }] }), 404],
  ['stale second item', (body) => ({ ...body, lines: [body.lines[0], { ...body.lines[1], version: 2 }] }), 409],
  ['incompatible package unit', (body) => ({ ...body, lines: [body.lines[0], { ...body.lines[1], unit: 'box' }] }), 422],
])('%s rejects all lines without any receipt or stock change', async (_name, change, status) => {
  const initial = await db.getInventoryById(first.id);
  await receive(change(payload()), status);
  expect(await db.getInventoryById(first.id)).toEqual(initial);
  expect(await quantity(second)).toBe('0.1');
  expect(await db.countInventoryMovements(first.id)).toBe(1);
  expect(await db.countPurchaseBatches()).toBe(0); expect(await db.countPurchaseReceipts()).toBe(0);
});

test('receiving rejects resulting stock overflow on a later line before any write', async () => {
  await db.updateInventory(second.id, { quantity: '999999999999.999999' });
  await receive(payload(), 422);
  expect(await quantity(first)).toBe('3'); expect(await db.countPurchaseBatches()).toBe(0);
});

test.each(['receipt-write', 'final-header-write', 'audit-write'])('%s failure rolls back every stock line, receipt, header and audit', async (stage) => {
  const initial = [await db.getInventoryById(first.id), await db.getInventoryById(second.id)];
  let failure;
  if (stage === 'receipt-write') {
    const original = db.createPurchaseReceipt;
    let calls = 0;
    failure = jest.spyOn(db, 'createPurchaseReceipt').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Synthetic receipt write failure');
      return original(...args);
    });
  } else failure = jest.spyOn(db, stage === 'final-header-write' ? 'updatePurchaseBatch' : 'appendAudit')
    .mockRejectedValue(new Error('Synthetic transactional failure'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await receive(payload(), 500); } finally { failure.mockRestore(); logging.mockRestore(); }
  expect(await db.getInventoryById(first.id)).toEqual(initial[0]); expect(await db.getInventoryById(second.id)).toEqual(initial[1]);
  expect(await db.countPurchaseBatches()).toBe(0); expect(await db.countPurchaseReceipts()).toBe(0);
  expect(await db.countInventoryMovements(first.id)).toBe(1); expect(await db.countInventoryMovements(second.id)).toBe(1);
  expect(await db.listAudit({ actions: ['inventory.purchase.batch'] })).toHaveLength(0);
});

test('partial receipts persist across manual check-off and quantity edits without rewriting plans; refreshed stock starts a new baseline', async () => {
  const initial = await savedPurchasing();
  const mealHistory = await db.saveWeeklyPlan({ weekStart, childrenCount: 1, staffCount: 0, week: [], items: [], recipes: {}, stockTakenAt: '2026-10-01T00:00:00Z' }, 0);
  const body = linkedPayload(initial, '4');
  const firstBatch = (await receive(body)).batch;
  expect(await db.getPurchasingList(weekStart)).toEqual(initial);
  expect(await db.getWeeklyPlan(weekStart)).toEqual(mealHistory);
  let fulfillment = await api('get', base + '/purchasing/' + weekStart);
  expect(fulfillment.lines[0]).toMatchObject({ buyQuantity: '10', receivedQuantity: '4', remainingQuantity: '6' });
  const choices = initial.lines.map((value) => ({ id: value.id, buyQuantity: '12', selected: true, checked: true }));
  const edited = await api('put', '/api/purchasing/' + weekStart, { version: initial.version, choices });
  fulfillment = await api('get', base + '/purchasing/' + weekStart);
  expect(fulfillment).toMatchObject({ version: 2, lines: [{ buyQuantity: '12', receivedQuantity: '4', remainingQuantity: '8' }] });
  const current = await db.getInventoryById(first.id);
  const secondBody = linkedPayload(edited, '3', current);
  const secondBatch = (await receive(secondBody)).batch;
  expect(secondBatch.lines[0]).toMatchObject({ plannedQuantity: '12', previouslyReceived: '4', remainingQuantity: '8' });
  expect((await api('get', base + '/purchasing/' + weekStart)).lines[0]).toMatchObject({ receivedQuantity: '7', remainingQuantity: '5' });
  const refreshed = await db.savePurchasingList({ ...edited, stockTakenAt: '2026-10-15T12:00:00Z', lines: edited.lines.map((value) => ({ ...value, inStorage: '10', toBuy: '3', buyQuantity: '3', checked: false })) }, edited.version);
  expect((await api('get', base + '/purchasing/' + weekStart)).lines[0]).toMatchObject({ receivedQuantity: '0', remainingQuantity: '3' });
  expect((await api('get', base + '/' + firstBatch.id)).purchasingRef.calculationKey).toBe(secondBatch.purchasingRef.calculationKey);
  expect(service.calculationKey(refreshed)).not.toBe(firstBatch.purchasingRef.calculationKey);
  expect(await db.getWeeklyPlan(weekStart)).toEqual(mealHistory);
});

test('unlinked standalone goods do not fulfill plans and an actual overdelivery is visible and allowed', async () => {
  const saved = await savedPurchasing();
  await receive(payload({ lines: [line(first)] }));
  expect((await api('get', base + '/purchasing/' + weekStart)).lines[0].receivedQuantity).toBe('0');
  const current = await db.getInventoryById(first.id);
  const body = linkedPayload(saved, '11', current);
  const review = await api('post', base + '/preview', body);
  expect(review.lines[0].notes.join(' ')).toMatch(/exceeds.*remaining 10/);
  await receive(body);
  expect((await api('get', base + '/purchasing/' + weekStart)).lines[0]).toMatchObject({ receivedQuantity: '11', remainingQuantity: '0' });
});

test('cumulative receipts above one stock-entry limit remain readable and do not block a later linked receipt', async () => {
  const saved = await savedPurchasing();
  const key = service.calculationKey(saved);
  const purchasingRef = { weekStart, version: saved.version, stockTakenAt: saved.stockTakenAt, calculationKey: key };
  // A record can be repeatedly received and consumed over time: its cumulative
  // history is not bounded by the maximum current physical stock balance.
  for (let index = 0; index < 2; index++) await db.createPurchaseBatch({ id: randomUUID(), requestId: randomUUID(), request: { synthetic: true },
    receivedOn: time.dateAt(), supplier: null, reason: 'Synthetic long-lived history', currency: 'USD',
    actorId: request.credentials().account.id, actorUsername: 'test-admin', recordedAt: new Date().toISOString(),
    purchasingRef, purchasingWeekStart: weekStart, purchasingCalculationKey: key,
    lines: [{ itemId: first.id, purchasingLineId: saved.lines[0].id, stockDelta: '999999999999.999999' }] });
  const review = await api('post', base + '/preview', linkedPayload(saved, '1'));
  expect(review.lines[0]).toMatchObject({ previouslyReceived: '1999999999999.999998', remainingQuantity: '0' });
  const progress = await api('get', base + '/purchasing/' + weekStart);
  expect(progress.lines[0]).toMatchObject({ receivedQuantity: '1999999999999.999998', remainingQuantity: '0' });
});

test.each(['stale-version', 'unselected', 'wrong-destination', 'wrong-unit', 'missing-line', 'issues'])('linked %s is rejected without changing stock', async (kind) => {
  const saved = await savedPurchasing();
  const body = linkedPayload(saved);
  if (kind === 'stale-version') body.purchasingRef.version = 7;
  if (kind === 'wrong-destination') { body.lines[0].itemId = second.id; body.lines[0].unit = second.unit; }
  if (kind === 'missing-line') body.lines[0].purchasingLineId = 'unknown-line';
  if (kind === 'unselected') saved.lines[0].selected = false;
  if (kind === 'wrong-unit') saved.lines[0].unit = 'lb';
  if (kind === 'issues') saved.issues = [{ code: 'INVALID', message: 'Unresolved source' }];
  if (['unselected', 'wrong-unit', 'issues'].includes(kind)) {
    const replacement = await db.savePurchasingList(saved, saved.version);
    body.purchasingRef.version = replacement.version;
  }
  await receive(body, 409);
  expect(await quantity(first)).toBe('3'); expect(await quantity(second)).toBe('0.1');
  expect(await db.countPurchaseBatches()).toBe(0);
});

test('administrators and editors receive; class viewers cannot inspect, preview or commit receipts', async () => {
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  const { batch } = await receive(payload());
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await request(app).get(base + '/' + batch.id)).status).toBe(403);
  expect((await request(app).get(base)).status).toBe(403);
  expect((await request(app).post(base + '/preview').send(payload())).status).toBe(403);
  expect((await request(app).post(base).send(payload())).status).toBe(403);
  expect((await anonymous(app).get(base)).status).toBe(401);
});

test('archived records and inactive parents reject an entire new delivery while a previously committed receipt still replays', async () => {
  const originalBody = payload({ lines: [line(second)] });
  const original = await receive(originalBody);
  const currentSecond = await db.getInventoryById(second.id);
  const body = payload({ lines: [line(first), line(currentSecond)] });
  await db.updateInventory(second.id, { archived: true, archivedAt: new Date().toISOString(), version: currentSecond.version + 1 });
  await receive(body, 409);
  expect(await quantity(first)).toBe('3');
  expect(await db.countPurchaseBatches()).toBe(1);
  expect(await receive(originalBody)).toEqual({ ...original, replayed: true });
  await db.updateInventory(second.id, { archived: false, archivedAt: null });
  await db.updateInventoryGroup(second.groupId, { archived: true, archivedAt: new Date().toISOString() });
  await receive(body, 409);
  expect(await quantity(first)).toBe('3'); expect(await db.countPurchaseBatches()).toBe(1);
});

test('current fulfillment warns about an archived destination without rewriting the purchasing snapshot or earlier receipt', async () => {
  const list = await savedPurchasing();
  const before = await api('get', base + '/purchasing/' + weekStart);
  expect(before.lines[0]).not.toHaveProperty('unavailable');
  const received = await receive(linkedPayload(list));
  const saved = await db.getPurchasingList(weekStart);
  const updated = await db.getInventoryById(first.id);
  await db.updateInventory(first.id, { archived: true, archivedAt: new Date().toISOString(), version: updated.version + 1 });
  const after = await api('get', base + '/purchasing/' + weekStart);
  expect(after.lines[0]).toMatchObject({ receivedQuantity: '4', remainingQuantity: '6', unavailable: true });
  expect(after.lines[0].availabilityMessage).toMatch(/archived/);
  expect(await db.getPurchasingList(weekStart)).toEqual(saved);
  expect(await api('get', base + '/' + received.batch.id)).toEqual(received.batch);
});
