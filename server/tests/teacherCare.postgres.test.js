const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes, QueryTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const { createConnection } = require('../database/connection');

test('025 upgrades populated024 without promoting viewers, losing sessions or changing child records; safety persists after reconnect', async () => {
  const { connection } = context(); const schema = 'skao_teacher_' + randomUUID().replaceAll('-', '');
  const qi = connection.getQueryInterface(); const table = tableName => ({ tableName, schema });
  const quoted = name => qi.queryGenerator.quoteTable(table(name));
  const directory = path.join(__dirname, '../database/migrations');
  const before = fs.readdirSync(directory).filter(name => /^\d{3}-.+\.js$/.test(name) && name < '025-').sort();
  const now = new Date(); let created = false; let reopened;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async transaction => {
      await qi.createTable(table('SequelizeMeta'), { name: { type: DataTypes.STRING, primaryKey: true, allowNull: false } }, { transaction });
      for (const filename of before) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await qi.bulkInsert(table('SequelizeMeta'), [{ name: filename.slice(0, -3) }], { transaction });
      }
      await qi.bulkInsert(table('Rooms'), [{ id: 'class', name: 'Existing class', active: true, ageMinMonths: 12, ageMaxMonths: 60, capacity: 20, createdAt: now, updatedAt: now }], { transaction });
      for (const role of ['admin', 'editor', 'viewer']) {
        await qi.bulkInsert(table('Accounts'), [{ id: role, username: role, displayName: 'Original ' + role, role, roomId: role === 'viewer' ? 'class' : null,
          passwordHash: 'Original synthetic hash ' + role, documentAccess: 'none', disabled: false, mustChangePassword: false, createdAt: now, updatedAt: now }], { transaction });
        for (const remembered of [true, false]) await qi.bulkInsert(table('Sessions'), [{ id: role + remembered, accountId: role, remembered, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 3600000) }], { transaction });
      }
      await qi.bulkInsert(table('Children'), [{ id: 'child', firstName: 'Existing', lastName: 'Child', roomId: 'class', active: true,
        notes: 'Existing private registration notes', createdAt: now, updatedAt: now }], { transaction });
    });
    const read = name => connection.query(`SELECT * FROM ${quoted(name)} ORDER BY id`, { type: QueryTypes.SELECT });
    const accounts = await read('Accounts'); const sessions = await read('Sessions'); const children = await read('Children');
    expect(await migrate(connection, schema)).toEqual(['025-teacher-care-access', '026-staff-account-links', '027-employee-payroll', '028-clock-stations', '029-child-billing']);
    expect(await read('Accounts')).toEqual(accounts.map(account => ({ ...account, staffMemberId: null }))); expect(await read('Sessions')).toEqual(sessions); expect(await read('Children')).toEqual(children);
    expect(await connection.query(`SELECT * FROM ${quoted('ChildSafetyProfiles')}`, { type: QueryTypes.SELECT })).toEqual([]);
    await connection.query(`UPDATE ${quoted('Accounts')} SET role = 'teacher' WHERE id = 'viewer'`);
    await expect(connection.query(`UPDATE ${quoted('Accounts')} SET "roomId" = 'class' WHERE id = 'editor'`)).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
    await qi.bulkInsert(table('ChildSafetyProfiles'), [{ childId: 'child', version: 1, reviewedAt: now, reviewedBy: 'admin',
      details: JSON.stringify({ allergyStatus: 'recorded', allergies: 'Synthetic allergy', emergencyContacts: [{ name: 'Synthetic parent', phone: '555-0100', relationship: 'Parent' }] }) }]);
    await expect(connection.query(`DELETE FROM ${quoted('Children')} WHERE id = 'child'`)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    await expect(connection.query(`UPDATE ${quoted('ChildSafetyProfiles')} SET version = 0 WHERE "childId" = 'child'`)).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
    await expect(connection.query(`UPDATE ${quoted('ChildSafetyProfiles')} SET "reviewedBy" = 'missing' WHERE "childId" = 'child'`)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
    expect(await migrate(connection, schema)).toEqual([]);
    reopened = createConnection(process.env.DATABASE_URL, { schema });
    const [rows] = await reopened.query(`SELECT * FROM ${quoted('ChildSafetyProfiles')}`);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ childId: 'child', version: 1, reviewedBy: 'admin', details: { allergies: 'Synthetic allergy' } });
    const [roles] = await reopened.query(`SELECT role, "roomId" FROM ${quoted('Accounts')} WHERE id = 'viewer'`);
    expect(roles).toEqual([{ role: 'teacher', roomId: 'class' }]);
  } finally { if (reopened) await reopened.close(); if (created) await connection.dropSchema(schema, { cascade: true }); }
});
