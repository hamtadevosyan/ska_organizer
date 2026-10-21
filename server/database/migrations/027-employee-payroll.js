exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface(); const table = { tableName: 'PayrollRecords', schema };
  await qi.createTable(table, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    staffId: { type: T.STRING, allowNull: false, references: { model: { tableName: 'StaffMembers', schema }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    kind: { type: T.STRING(16), allowNull: false }, ciphertext: { type: T.TEXT, allowNull: false },
    version: { type: T.INTEGER, allowNull: false }, createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  await qi.addIndex(table, ['staffId', 'kind'], { name: 'payroll_staff_kind', transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."PayrollRecords" ADD CONSTRAINT payroll_version_positive CHECK (version > 0), ADD CONSTRAINT payroll_kind_valid CHECK (kind IN ('profile', 'ledger', 'document', 'snapshot'))`, { transaction });
};
