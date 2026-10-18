// An assignment is explicit. Existing viewers start unassigned, and must sign
// in again so an already open app cannot retain the previous global view.
exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const accounts = { tableName: 'Accounts', schema };
  const rooms = { tableName: 'Rooms', schema };
  const quote = (tableName) => qi.queryGenerator.quoteTable({ tableName, schema });
  await qi.addColumn(accounts, 'roomId', { type: T.STRING, allowNull: true, defaultValue: null }, { transaction });
  await qi.addConstraint(accounts, { fields: ['roomId'], type: 'foreign key', name: 'account_classroom_reference',
    references: { table: rooms, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(accounts, ['roomId'], { name: 'account_classroom_lookup', transaction });
  await sequelize.query(`ALTER TABLE ${quote('Accounts')} ADD CONSTRAINT "account_classroom_role_valid"
    CHECK ("role" = 'viewer' OR "roomId" IS NULL)`, { transaction });
  // This runs only when 024 is first recorded in SequelizeMeta. Ordinary and
  // remembered viewer sessions are both revoked; other roles are preserved.
  await sequelize.query(`DELETE FROM ${quote('Sessions')} AS s USING ${quote('Accounts')} AS a
    WHERE s."accountId" = a."id" AND a."role" = 'viewer'`, { transaction });
};
