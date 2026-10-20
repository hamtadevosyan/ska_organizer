exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const table = name => ({ tableName: name, schema });
  const accounts = qi.queryGenerator.quoteTable(table('Accounts'));
  await qi.removeConstraint(table('Accounts'), 'account_role_valid', { transaction });
  await qi.removeConstraint(table('Accounts'), 'account_classroom_role_valid', { transaction });
  await sequelize.query(`ALTER TABLE ${accounts} ADD CONSTRAINT account_role_valid
    CHECK ("role" IN ('admin', 'editor', 'viewer', 'teacher'))`, { transaction });
  await sequelize.query(`ALTER TABLE ${accounts} ADD CONSTRAINT account_classroom_role_valid
    CHECK ("role" IN ('viewer', 'teacher') OR "roomId" IS NULL)`, { transaction });
  await qi.createTable(table('ChildSafetyProfiles'), {
    childId: { type: T.STRING, primaryKey: true, allowNull: false,
      references: { model: table('Children'), key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    details: { type: T.JSONB, allowNull: false },
    version: { type: T.INTEGER, allowNull: false },
    reviewedAt: { type: T.DATE, allowNull: false },
    reviewedBy: { type: T.STRING, allowNull: false,
      references: { model: table('Accounts'), key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
  }, { transaction });
  const safety = qi.queryGenerator.quoteTable(table('ChildSafetyProfiles'));
  await sequelize.query(`ALTER TABLE ${safety} ADD CONSTRAINT child_safety_version_valid CHECK ("version" > 0)`, { transaction });
  // Existing viewers are not silently promoted, and unknown medical information
  // is not inferred from old free text or documents. No session is revoked here.
};
