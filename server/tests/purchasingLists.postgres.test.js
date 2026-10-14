const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const db = require('../services/dbAdapter');

test('a reviewed purchasing snapshot survives a new Node process and repeat migration', async () => {
  const { connection, schema } = context();
  const snapshot = { weekStart: '2026-10-19', stockTakenAt: '2026-10-14T12:00:00.000Z',
    includeMeals: true, roomIds: ['room-1'], lowStockTargets: [{ itemId: 'paper', targetQuantity: '30' }],
    mealPlan: { version: 2, savedAt: '2026-10-12T08:00:00.000Z' },
    activityPlans: [{ roomId: 'room-1', roomName: 'Sunflower', version: 3, savedAt: '2026-10-13T08:00:00.000Z' }], issues: [],
    lines: [{ id: 'item:paper', itemId: 'paper', ingredientId: null, name: 'Paper', location: 'Art shelf', unit: 'count',
      needed: '30', inStorage: '5', toBuy: '25', buyQuantity: '28.125', selected: true, checked: true,
      stockItems: [{ id: 'paper', name: 'Paper', location: 'Art shelf', unit: 'count', quantity: '5', version: 1, allocated: '5' }],
      sources: [{ kind: 'low-stock', label: 'Art shelf target', quantity: '30', unit: 'count' }], notes: [] }] };
  const saved = await db.savePurchasingList(snapshot, 0);
  expect(await migrate(connection, schema)).toEqual([]);
  const script = `const db = require('./services/dbAdapter.sequelize');
    (async () => {
      try {
        await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA });
        process.stdout.write(JSON.stringify(await db.getPurchasingList('2026-10-19')));
      } finally { await db.close(); }
    })().catch(() => { process.stderr.write('Purchasing persistence process failed.'); process.exitCode = 1; });`;
  const child = await promisify(execFile)(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), timeout: 20000,
    env: { ...process.env, NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DB_SCHEMA: schema },
  });
  expect(JSON.parse(child.stdout)).toEqual(saved);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  expect(await db.getPurchasingList(snapshot.weekStart)).toEqual(saved);
});

test('native constraints reject invalid list versions and mismatched or non-Monday snapshot keys', async () => {
  const { connection, schema } = context();
  await db.savePurchasingList({ weekStart: '2026-10-19', lines: [] }, 0);
  const table = '"' + schema + '"."PurchasingLists"';
  for (const expression of ['"version" = 0', '"snapshot" = \'{}\'::jsonb',
    '"snapshot" = \'{"weekStart":null}\'::jsonb',
    '"snapshot" = \'{"weekStart":"2026-10-26"}\'::jsonb',
    '"weekStart" = \'2026-10-20\', "snapshot" = \'{"weekStart":"2026-10-20"}\'::jsonb']) {
    await expect(connection.query('UPDATE ' + table + ' SET ' + expression))
      .rejects.toMatchObject({ original: { code: '23514' } });
  }
  expect(await db.getPurchasingList('2026-10-19')).toMatchObject({ weekStart: '2026-10-19', version: 1 });
});
