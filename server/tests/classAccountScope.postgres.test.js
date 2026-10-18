const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const { createConnection } = require('../database/connection');

test('024 preserves populated 023 records, revokes only old viewer sessions, and persists explicit scope after reconnecting', async () => {
  const { connection } = context();
  const schema = 'skao_class_scope_' + randomUUID().replaceAll('-', '');
  const table = (tableName) => ({ tableName, schema });
  const qi = connection.getQueryInterface();
  const quote = (tableName) => qi.queryGenerator.quoteTable(table(tableName));
  const directory = path.join(__dirname, '../database/migrations');
  const previous = fs.readdirSync(directory).filter((filename) => /^\d{3}-.+\.js$/.test(filename) && filename < '024-').sort();
  const now = new Date('2026-10-17T10:00:00Z');
  const accounts = ['admin', 'editor', 'viewer'].map((role) => ({ id: 'synthetic-' + role, username: 'synthetic-' + role,
    displayName: 'Matching class name', passwordHash: 'Synthetic original immutable hash: ' + role,
    role, documentAccess: 'none', disabled: false, mustChangePassword: false, createdAt: now, updatedAt: now }));
  let created = false; let reopened;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async (transaction) => {
      await qi.createTable(table('SequelizeMeta'), { name: { type: DataTypes.STRING, primaryKey: true, allowNull: false } }, { transaction });
      for (const filename of previous) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await qi.bulkInsert(table('SequelizeMeta'), [{ name: filename.slice(0, -3) }], { transaction });
      }
      await qi.bulkInsert(table('Accounts'), accounts, { transaction });
      await qi.bulkInsert(table('Rooms'), [{ id: 'original-class', name: 'Matching class name', active: true,
        ageMinMonths: 12, ageMaxMonths: 60, capacity: 20, createdAt: now, updatedAt: now }], { transaction });
      await qi.bulkInsert(table('Ingredients'), [{ id: 'original-ingredient', name: 'Original ingredient', unit: 'g',
        createdAt: now, updatedAt: now }], { transaction });
      for (const person of accounts) for (const remembered of [false, true]) {
        await qi.bulkInsert(table('Sessions'), [{ id: person.role + '-' + remembered, accountId: person.id, remembered,
          createdAt: now, lastSeenAt: now, expiresAt: new Date('2030-01-01T00:00:00Z') }], { transaction });
      }
    });
    const read = async (name) => (await connection.query(`SELECT * FROM ${quote(name)} ORDER BY id`))[0];
    const beforeAccounts = await read('Accounts'); const beforeRooms = await read('Rooms');
    const beforeIngredients = await read('Ingredients'); const beforeSessions = await read('Sessions');
    expect(await migrate(connection, schema)).toEqual(['024-classroom-account-scope']);
    expect((await read('Accounts')).map(({ roomId, ...person }) => person)).toEqual(beforeAccounts);
    expect((await read('Accounts')).every((person) => person.roomId === null)).toBe(true);
    expect(await read('Rooms')).toEqual(beforeRooms); expect(await read('Ingredients')).toEqual(beforeIngredients);
    expect(await read('Sessions')).toEqual(beforeSessions.filter((session) => session.accountId !== 'synthetic-viewer'));
    await connection.query(`UPDATE ${quote('Accounts')} SET "roomId" = 'original-class' WHERE id = 'synthetic-viewer'`);
    await expect(connection.query(`UPDATE ${quote('Accounts')} SET "roomId" = 'missing-class' WHERE id = 'synthetic-viewer'`))
      .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    await expect(connection.query(`UPDATE ${quote('Accounts')} SET "roomId" = 'original-class' WHERE id = 'synthetic-editor'`))
      .rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
    await expect(connection.query(`DELETE FROM ${quote('Rooms')} WHERE id = 'original-class'`))
      .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    await expect(connection.query(`UPDATE ${quote('Rooms')} SET id = 'changed-class' WHERE id = 'original-class'`))
      .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    await qi.bulkInsert(table('Sessions'), [{ id: 'new-assigned-viewer-session', accountId: 'synthetic-viewer', remembered: true,
      createdAt: now, lastSeenAt: now, expiresAt: new Date('2030-01-01T00:00:00Z') }]);
    const assignedAccounts = await read('Accounts'); const newSessions = await read('Sessions');
    expect(await migrate(connection, schema)).toEqual([]);
    expect(await read('Accounts')).toEqual(assignedAccounts); expect(await read('Sessions')).toEqual(newSessions);
    reopened = createConnection(process.env.DATABASE_URL, { schema });
    const [persisted] = await reopened.query(`SELECT id, "passwordHash", "roomId" FROM ${quote('Accounts')} ORDER BY id`);
    expect(persisted).toEqual(assignedAccounts.map(({ id, passwordHash, roomId }) => ({ id, passwordHash, roomId })));
    const [indexes] = await reopened.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
      { bind: [schema, 'account_classroom_lookup'] });
    expect(indexes).toEqual([{ indexname: 'account_classroom_lookup' }]);
  } finally {
    if (reopened) await reopened.close();
    if (created) await connection.dropSchema(schema, { cascade: true });
  }
});
