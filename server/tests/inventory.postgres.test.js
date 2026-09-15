const { randomUUID } = require('node:crypto');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

test('inventory migration is repeatable and decimal quantities, references and request history survive reconnection', async () => {
  const { connection, schema } = context();
  const ingredient = await request(app).post('/api/ingredients').send({ name: 'Persistent synthetic oats', unit: 'lb' });
  expect(ingredient.status).toBe(201);
  const created = await request(app).post('/api/inventory').send({ name: 'Persistent oats', category: 'Food',
    location: 'Kitchen / Pantry / Shelf 2', ingredientId: ingredient.body.data.id, unit: 'lb', openingQuantity: '0.1',
    reorderThreshold: '0.2', reason: 'Initial physical count', requestId: randomUUID() });
  expect(created.status).toBe(201);
  const stock = created.body.data;
  const payload = { type: 'addition', quantity: '0.2', unit: 'lb', version: stock.version, reason: 'Small delivery', requestId: randomUUID() };
  expect((await request(app).post('/api/inventory/' + stock.id + '/movements').send(payload)).status).toBe(200);
  const previous = (await request(app).get('/api/inventory/' + stock.id + '/movements')).body;
  const accounts = await db.listAccounts();
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  const loaded = await request(app).get('/api/inventory/' + stock.id + '/movements');
  expect(loaded.status).toBe(200);
  expect(loaded.body).toEqual(previous);
  expect(loaded.body.item).toMatchObject({ quantity: '0.3', status: 'available', location: 'Kitchen / Pantry / Shelf 2',
    ingredientId: ingredient.body.data.id, version: 2, createdAt: stock.createdAt });
  expect((await request(app).post('/api/inventory/' + stock.id + '/movements').send(payload)).body.data).toMatchObject({ quantity: '0.3', replayed: true, version: 2 });
  expect((await request(app).get('/api/inventory/' + stock.id + '/movements')).body.total).toBe(2);
  expect(await db.listAccounts()).toEqual(accounts);
  await expect(connection.query('UPDATE "' + schema + '"."InventoryItems" SET "quantity" = -1 WHERE "id" = :id', { replacements: { id: stock.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  await expect(connection.query('UPDATE "' + schema + '"."InventoryMovements" SET "delta" = 999 WHERE "itemId" = :id', { replacements: { id: stock.id } }))
    .rejects.toMatchObject({ original: { code: '23514' } });
  await expect(connection.query('DELETE FROM "' + schema + '"."Ingredients" WHERE "id" = :id', { replacements: { id: ingredient.body.data.id } }))
    .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query('DELETE FROM "' + schema + '"."InventoryItems" WHERE "id" = :id', { replacements: { id: stock.id } }))
    .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  expect((await request(app).get('/api/inventory/' + stock.id + '/movements')).body).toEqual(previous);
});
