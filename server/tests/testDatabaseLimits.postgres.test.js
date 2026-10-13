const { QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');

test('test connections receive session wait limits from the PostgreSQL runner', async () => {
  const { connection } = context();
  for (const [name, expected] of [['lock_timeout', '10s'], ['statement_timeout', '15s'], ['idle_in_transaction_session_timeout', '20s']]) {
    const rows = await connection.query('SHOW ' + name, { type: QueryTypes.SELECT });
    expect(rows[0][name]).toBe(expected);
  }
});

test('a blocked test query is canceled, rolled back and leaves the fixture usable', async () => {
  const { connection, schema } = context();
  const holder = await connection.transaction();
  try {
    await connection.query(`LOCK TABLE "${schema}"."Accounts" IN ACCESS EXCLUSIVE MODE`, { transaction: holder });
    await expect(connection.transaction(async transaction => {
      await connection.query("SET LOCAL lock_timeout = '150ms'", { transaction });
      await connection.query(`SELECT "id" FROM "${schema}"."Accounts"`, { transaction });
    })).rejects.toMatchObject({ original: { code: '55P03' } });
  } finally {
    await holder.rollback();
  }
  const [accounts] = await connection.query(`SELECT "id" FROM "${schema}"."Accounts"`);
  expect(accounts).toHaveLength(1);
});

test('a stalled statement is canceled without leaving its transaction open', async () => {
  const { connection } = context();
  await expect(connection.transaction(async transaction => {
    await connection.query("SET LOCAL statement_timeout = '150ms'", { transaction });
    await connection.query('SELECT pg_sleep(5)', { transaction });
  })).rejects.toMatchObject({ original: { code: '57014' } });
  const [rows] = await connection.query('SELECT 1 AS available');
  expect(rows[0].available).toBe(1);
});
