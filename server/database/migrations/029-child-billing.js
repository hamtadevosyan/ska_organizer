exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const table = { tableName: 'ChildBillingRecords', schema };
  await qi.createTable(table, {
    childId: { type: T.STRING, primaryKey: true, allowNull: false,
      references: { model: { tableName: 'Children', schema }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    data: { type: T.JSONB, allowNull: false },
    version: { type: T.INTEGER, allowNull: false },
    createdAt: { type: T.DATE, allowNull: false },
    updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  const quoted = qi.queryGenerator.quoteTable(table);
  await sequelize.query(`ALTER TABLE ${quoted}
    ADD CONSTRAINT child_billing_version_positive CHECK (version > 0),
    ADD CONSTRAINT child_billing_data_object CHECK (jsonb_typeof(data) = 'object')`, { transaction });
};
