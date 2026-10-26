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

test('actual CCRC receipts retain their service month, variable amounts and reviewed parent remainder after PostgreSQL reconnect', async () => {
  const { schema } = context(), childId = randomUUID(), actorId = 'synthetic-billing-administrator';
  await db.createChild({ id: childId, firstName: 'Synthetic', lastName: 'Actual CCRC persistence', dateOfBirth: '2022-05-06', active: true, roomId: null });
  const stamp = { actorId, at: '2026-11-20T18:00:00.000Z' };
  const charge = month => ({ id: 'monthly:' + month, kind: 'monthly', month, title: 'Tuition · ' + month,
    createdAt: month + '-01T12:00:00.000Z', settlementMode: 'ccrc_actual', tuitionCents: 120000, ccrcReview: null, adjustments: [],
    payers: { family: { amountCents: 120000, dueDate: month + '-01' }, ccrc: { amountCents: 0, dueDate: month + '-01' } } });
  const receipt = (id, date, chargeId, amountCents) => ({ id, payer: 'ccrc', amountCents, date, method: 'CCRC statement',
    reference: 'Synthetic statement ' + id, ...stamp, reversed: false, allocations: [{ chargeId, amountCents, ...stamp }] });
  const firstRequestId = randomUUID(), reviewRequestId = randomUUID();
  const rate = { effectiveMonth: '2026-09', monthlyCents: 120000, ccrcManaged: true, familyDueDay: 1, ...stamp };
  const value = { profile: { ...rate, enabled: true, billingStart: '2026-09-01', billingEnd: null, registrationCents: 0, rates: [rate] },
    charges: [charge('2026-09'), charge('2026-10'), charge('2026-11')],
    payments: [receipt('september-receipt', '2026-10-20', 'monthly:2026-09', 95025),
      receipt('october-first-receipt', '2026-11-10', 'monthly:2026-10', 60000),
      receipt('october-second-receipt', '2026-11-20', 'monthly:2026-10', 40000)],
    history: [{ id: randomUUID(), type: 'payment', paymentId: 'october-second-receipt', ...stamp }],
    requests: [{ id: firstRequestId, fingerprint: '1'.repeat(64) }] };
  await db.saveChildBillingRecord({ childId, data: value, version: 1 });
  const review = { familyDueDate: '2026-11-25', reason: 'Synthetic October statement checked in full.', ccrcPaidCents: 100000, ...stamp };
  const reviewed = JSON.parse(JSON.stringify(value));
  reviewed.charges[1].ccrcReview = review;
  reviewed.history.push({ id: randomUUID(), type: 'ccrc_review', chargeId: 'monthly:2026-10', before: null, after: review, reason: review.reason, ...stamp });
  reviewed.requests.push({ id: reviewRequestId, fingerprint: '2'.repeat(64) });
  await db.saveChildBillingRecord({ childId, data: reviewed, version: 2 }, 1);
  const expected = JSON.parse(JSON.stringify(await db.getChildBillingRecord(childId)));
  const script = `
    const db = require('./services/dbAdapter');
    const math = require('./services/billingMath');
    (async () => {
      try {
        await db.setup(process.env.DATABASE_URL, { schema: process.env.BILLING_TEST_SCHEMA });
        const record = await db.getChildBillingRecord(process.env.BILLING_TEST_CHILD);
        const charges = record.data.charges.map(charge => math.chargeView(charge, record.data.payments, '2026-11-30'));
        process.stdout.write(JSON.stringify({ record, charges }));
      } finally { await db.close(); }
    })().catch(() => { process.stderr.write('Synthetic actual CCRC reconnect failed.'); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, BILLING_TEST_SCHEMA: schema, BILLING_TEST_CHILD: childId } });
  const reopened = JSON.parse(output);
  expect(reopened.record).toEqual(expected);
  expect(reopened.record.version).toBe(2);
  expect(reopened.record.data.requests.map(row => row.id)).toEqual([firstRequestId, reviewRequestId]);
  expect(reopened.record.data.charges[1].ccrcReview).toEqual(review);
  expect(reopened.record.data.payments.slice(1).map(row => [row.date, row.allocations[0].chargeId, row.amountCents]))
    .toEqual([['2026-11-10', 'monthly:2026-10', 60000], ['2026-11-20', 'monthly:2026-10', 40000]]);
  expect(reopened.charges[0]).toMatchObject({ pendingCcrc: true, amountCents: 120000, paidCents: 95025, outstandingCents: 24975,
    payers: { family: { dueDate: null, overdue: false }, ccrc: { paidCents: 95025 } } });
  expect(reopened.charges[1]).toMatchObject({ pendingCcrc: false, amountCents: 120000, paidCents: 100000, outstandingCents: 20000,
    payers: { family: { outstandingCents: 20000, dueDate: '2026-11-25', daysOverdue: 5, overdue: true }, ccrc: { paidCents: 100000, outstandingCents: 0 } } });
  expect(reopened.charges[2]).toMatchObject({ status: 'awaiting_ccrc', amountCents: 120000, paidCents: 0, outstandingCents: 120000,
    payers: { family: { dueDate: null, overdue: false } } });
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
