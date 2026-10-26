const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes, QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const { createConnection } = require('../database/connection');

test('026 preserves populated accounts and sessions and enforces a unique optional employee link after reconnect', async () => {
  const { connection } = context(); const schema = 'skao_stafflink_' + randomUUID().replaceAll('-', '');
  const qi = connection.getQueryInterface(); const table = tableName => ({ tableName, schema });
  const quoted = name => qi.queryGenerator.quoteTable(table(name));
  const directory = path.join(__dirname, '../database/migrations');
  const previous = fs.readdirSync(directory).filter(name => /^\d{3}-.+\.js$/.test(name) && name < '026-').sort();
  const now = new Date(); let created = false; let reopened;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async transaction => {
      await qi.createTable(table('SequelizeMeta'), { name: { type: DataTypes.STRING, primaryKey: true, allowNull: false } }, { transaction });
      for (const filename of previous) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await qi.bulkInsert(table('SequelizeMeta'), [{ name: filename.slice(0, -3) }], { transaction });
      }
      for (const id of ['first', 'second']) {
        await qi.bulkInsert(table('Accounts'), [{ id, username: id, displayName: id, role: 'viewer', roomId: null,
          passwordHash: 'Synthetic existing hash', documentAccess: 'none', disabled: false, mustChangePassword: false, createdAt: now, updatedAt: now }], { transaction });
        await qi.bulkInsert(table('Sessions'), [{ id, accountId: id, remembered: false, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 3600000) }], { transaction });
      }
      await qi.bulkInsert(table('StaffMembers'), [{ id: 'staff', name: 'Existing employee', role: 'Teacher', active: true, roomId: null, version: 1, createdAt: now, updatedAt: now }], { transaction });
    });
    const read = name => connection.query(`SELECT * FROM ${quoted(name)} ORDER BY id`, { type: QueryTypes.SELECT });
    const accounts = await read('Accounts'); const sessions = await read('Sessions'); const staff = await read('StaffMembers');
    expect(await migrate(connection, schema)).toEqual(['026-staff-account-links', '027-employee-payroll', '028-clock-stations', '029-child-billing', '030-ccrc-statements']);
    expect(await read('Accounts')).toEqual(accounts.map(account => ({ ...account, staffMemberId: null })));
    expect(await read('Sessions')).toEqual(sessions); expect(await read('StaffMembers')).toEqual(staff);
    await connection.query(`UPDATE ${quoted('Accounts')} SET "staffMemberId" = 'staff' WHERE id = 'first'`);
    await expect(connection.query(`UPDATE ${quoted('Accounts')} SET "staffMemberId" = 'staff' WHERE id = 'second'`)).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await expect(connection.query(`UPDATE ${quoted('Accounts')} SET "staffMemberId" = 'missing' WHERE id = 'second'`)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    await expect(connection.query(`DELETE FROM ${quoted('StaffMembers')} WHERE id = 'staff'`)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    expect(await migrate(connection, schema)).toEqual([]);
    reopened = createConnection(process.env.DATABASE_URL, { schema });
    const [rows] = await reopened.query(`SELECT id, "staffMemberId" FROM ${quoted('Accounts')} ORDER BY id`);
    expect(rows).toEqual([{ id: 'first', staffMemberId: 'staff' }, { id: 'second', staffMemberId: null }]);
  } finally { if (reopened) await reopened.close(); if (created) await connection.dropSchema(schema, { cascade: true }); }
});
