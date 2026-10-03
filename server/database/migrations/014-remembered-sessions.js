// Existing sessions retain ordinary expiry; no account or operational data changes.
exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  await sequelize.getQueryInterface().addColumn({ tableName: 'Sessions', schema }, 'remembered', {
    type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
  }, { transaction });
};
