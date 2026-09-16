const { randomUUID } = require('node:crypto');
const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

test('migration 010 groups existing category stock without changing quantities, versions, or historical snapshots', async () => {
  const { connection } = context();
  // Build the previously shipped schema in a separate, disposable test schema.
  const schema = 'skao_group_upgrade_' + randomUUID().replaceAll('-', '');
  await connection.createSchema(schema);
  const table = (name) => ({ schema, tableName: name });
  try {
    await connection.transaction(async (transaction) => {
      const qi = connection.getQueryInterface();
      await qi.createTable(table('Ingredients'), { id: { type: DataTypes.STRING, primaryKey: true } }, { transaction });
      await qi.createTable(table('Accounts'), { id: { type: DataTypes.STRING, primaryKey: true } }, { transaction });
      await require('../database/migrations/009-inventory-ledger').up({ sequelize: connection, schema, transaction, DataTypes });
      await qi.bulkInsert(table('Ingredients'), [{ id: 'ingredient-one' }], { transaction });
      await qi.bulkInsert(table('Accounts'), [{ id: 'actor-one' }], { transaction });
      const common = { name: 'Existing stock', location: 'Shelf 2', unit: 'lb', quantity: '2.125', reorderThreshold: '1',
        version: 1, createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z') };
      await qi.bulkInsert(table('InventoryItems'), [{ ...common, id: 'food-one', category: 'Food', ingredientId: 'ingredient-one' },
        { ...common, id: 'supply-one', category: 'Materials', ingredientId: null }, { ...common, id: 'supply-two', category: 'materials', ingredientId: null }], { transaction });
      await connection.query('INSERT INTO "' + schema + '"."InventoryMovements" ("id","itemId","type","delta","beforeQuantity","afterQuantity","reason","actorId","actorUsername","occurredAt","itemVersion","before","after","requestId","request") ' +
        'VALUES (:id,:item,\'opening\',2.125,0,2.125,\'Original count\',\'actor-one\',\'Original user\',:time,1,NULL,CAST(:after AS jsonb),\'original-request-id\',CAST(:request AS jsonb))', {
        replacements: { id: 'original-movement', item: 'food-one', time: common.createdAt, after: JSON.stringify({ id: 'food-one', category: 'Food', quantity: '2.125', version: 1 }), request: JSON.stringify({ original: true }) }, transaction,
      });
    });
    const [beforeItems] = await connection.query('SELECT * FROM "' + schema + '"."InventoryItems" ORDER BY "id"');
    const [beforeHistory] = await connection.query('SELECT * FROM "' + schema + '"."InventoryMovements"');
    await connection.transaction((transaction) => require('../database/migrations/010-inventory-groups').up({ sequelize: connection, schema, transaction, DataTypes }));
    const [afterItems] = await connection.query('SELECT * FROM "' + schema + '"."InventoryItems" ORDER BY "id"');
    const [groups] = await connection.query('SELECT * FROM "' + schema + '"."InventoryGroups"');
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.name === 'Food').kind).toBe('food');
    expect(afterItems.map(({ groupId, ...item }) => item)).toEqual(beforeItems);
    expect(afterItems.every((item) => groups.some((group) => group.id === item.groupId))).toBe(true);
    expect(afterItems.find((item) => item.id === 'supply-one').groupId).toBe(afterItems.find((item) => item.id === 'supply-two').groupId);
    expect((await connection.query('SELECT * FROM "' + schema + '"."InventoryMovements"'))[0]).toEqual(beforeHistory);
    await expect(connection.query('DELETE FROM "' + schema + '"."InventoryGroups"')).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  } finally { await connection.dropSchema(schema, { cascade: true }); }
});

test('empty groups survive a database reconnect and migrations are repeatable', async () => {
  const { connection, schema } = context();
  const response = await request(app).post('/api/inventory/groups').send({ name: 'Reusable decorations', kind: 'supplies', requestId: randomUUID() });
  expect(response.status).toBe(201);
  const before = (await request(app).get('/api/inventory/groups')).body;
  expect(before.items[0]).toMatchObject({ id: response.body.data.id, summary: { total: 0 } });
  expect(await migrate(connection, schema)).toEqual([]);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  expect((await request(app).get('/api/inventory/groups')).body).toEqual(before);
});
