const { randomUUID } = require('node:crypto');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const time = require('../services/facilityTime');

test('purchase records, stock and duplicate-request protection survive reconnect without reseeding', async () => {
  const { connection, schema } = context();
  const created = await request(app).post('/api/inventory').send({ name: 'Persistent purchase test', category: 'Supplies',
    location: 'Shelf 1', unit: 'pack', openingQuantity: '0', reorderThreshold: '1', reason: 'Opening count', requestId: randomUUID() });
  expect(created.status).toBe(201); const item = created.body.data;
  const payload = { version: item.version, unit: item.unit, quantity: '2.125', receivedOn: time.dateAt(),
    supplier: 'Synthetic shop', totalCost: '19.95', requestId: randomUUID() };
  const received = await request(app).post('/api/inventory/' + item.id + '/purchases').send(payload);
  expect(received.status).toBe(201);
  const before = (await request(app).get('/api/inventory/purchases')).body;
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close(); await db.setup(process.env.DATABASE_URL, { schema });
  expect((await request(app).get('/api/inventory/purchases')).body).toEqual(before);
  const repeated = await request(app).post('/api/inventory/' + item.id + '/purchases').send(payload);
  expect(repeated.status).toBe(201);
  expect(repeated.body.data).toMatchObject({ replayed: true, receipt: received.body.data.receipt, item: { quantity: '2.125', version: 2 } });
  expect(await db.countPurchaseReceipts()).toBe(1);
  expect(await db.countInventoryMovements(item.id)).toBe(2);
  const receipt = received.body.data.receipt;
  for (const field of ['quantity', 'totalCost']) {
    await expect(connection.query('UPDATE "' + schema + '"."PurchaseReceipts" SET "' + field + '" = -1 WHERE id = :id', { replacements: { id: receipt.id } }))
      .rejects.toMatchObject({ original: { code: '23514' } });
  }
  await expect(connection.query('DELETE FROM "' + schema + '"."InventoryMovements" WHERE id = :id', { replacements: { id: receipt.movementId } }))
    .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
});
