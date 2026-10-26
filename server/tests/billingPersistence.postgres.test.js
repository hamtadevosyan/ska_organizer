const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { DataTypes, QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const { migrate } = require('../database/migrate');

test('child billing profiles, allocations and revision history survive a separate Node process', async () => {
  const { schema } = context(), childId = randomUUID();
  await db.createChild({ id: childId, firstName: 'Synthetic', lastName: 'Billing persistence', dateOfBirth: '2022-05-06', active: true, roomId: null });
  const value = { profile: { billingStart: '2026-10-01', familyCents: 109999, ccrcCents: 40001 },
    charges: [{ id: 'charge-a', month: '2026-10', familyDueDate: '2026-10-01', ccrcDueDate: '2026-10-15', cents: 150000 }],
    payments: [{ id: 'payment-a', payer: 'family', cents: 25699, reference: 'Synthetic payment', allocations: [{ chargeId: 'charge-a', cents: 25699 }] }],
    history: [{ action: 'payment', actorId: 'synthetic-account', at: '2026-10-01T12:00:00.000Z' }],
    requests: [{ id: 'synthetic-payment-request', result: 'payment-a' }] };
  await db.saveChildBillingRecord({ childId, data: value, version: 1 });
  await db.saveChildBillingRecord({ childId, data: { ...value, history: [...value.history, { action: 'review' }] }, version: 2 });
  const expected = JSON.parse(JSON.stringify(await db.getChildBillingRecord(childId)));
  const script = `
    const db = require('./services/dbAdapter');
    (async () => {
      try {
        await db.setup(process.env.DATABASE_URL, { schema: process.env.BILLING_TEST_SCHEMA });
        process.stdout.write(JSON.stringify(await db.getChildBillingRecord(process.env.BILLING_TEST_CHILD)));
      } finally { await db.close(); }
    })().catch(() => { process.stderr.write('Synthetic billing reconnect failed.'); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, BILLING_TEST_SCHEMA: schema, BILLING_TEST_CHILD: childId } });
  expect(JSON.parse(output)).toEqual(expected);
});

test('billing migration preserves populated child records and enforces native owner, object and positive revision constraints', async () => {
  const { connection } = context(), schema = 'skao_billing_' + randomUUID().replaceAll('-', '');
  const qi = connection.getQueryInterface(), table = tableName => ({ tableName, schema });
  const quoted = name => qi.queryGenerator.quoteTable(table(name));
  const directory = path.join(__dirname, '../database/migrations');
  const previous = fs.readdirSync(directory).filter(name => /^\d{3}-.+\.js$/.test(name) && name < '029-').sort();
  const now = new Date(); let created = false;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async transaction => {
      await qi.createTable(table('SequelizeMeta'), { name: { type: DataTypes.STRING, primaryKey: true, allowNull: false } }, { transaction });
      for (const filename of previous) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await qi.bulkInsert(table('SequelizeMeta'), [{ name: filename.slice(0, -3) }], { transaction });
      }
      await qi.bulkInsert(table('Children'), [{ id: 'existing-child', firstName: 'Existing', lastName: 'Synthetic child',
        dateOfBirth: '2022-05-06', active: false, roomId: null, createdAt: now, updatedAt: now }], { transaction });
    });
    const before = await connection.query(`SELECT * FROM ${quoted('Children')}`, { type: QueryTypes.SELECT });
    expect(await migrate(connection, schema)).toEqual(['029-child-billing']);
    expect(await connection.query(`SELECT * FROM ${quoted('Children')}`, { type: QueryTypes.SELECT })).toEqual(before);
    expect(await migrate(connection, schema)).toEqual([]);
    const insert = (childId, data, version) => connection.query(`INSERT INTO ${quoted('ChildBillingRecords')}
      ("childId", data, version, "createdAt", "updatedAt") VALUES (:childId, CAST(:data AS jsonb), :version, :now, :now)`,
    { replacements: { childId, data: JSON.stringify(data), version, now } });
    await expect(insert('missing-child', {}, 1)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    for (const [data, version] of [[{}, 0], [[], 1], [null, 1], ['not-a-ledger', 1]]) {
      await expect(insert('existing-child', data, version)).rejects.toMatchObject({ original: { code: '23514' } });
    }
    await insert('existing-child', { payments: [{ cents: 1799 }] }, 1);
    await expect(connection.query(`DELETE FROM ${quoted('Children')} WHERE id = 'existing-child'`)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    expect(await connection.query(`SELECT "childId", data, version FROM ${quoted('ChildBillingRecords')}`, { type: QueryTypes.SELECT }))
      .toEqual([{ childId: 'existing-child', data: { payments: [{ cents: 1799 }] }, version: 1 }]);
  } finally { if (created) await connection.dropSchema(schema, { cascade: true }); }
});
