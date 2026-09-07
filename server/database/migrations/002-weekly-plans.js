// Additive migration: the older undated menu and shelf records remain available.
exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  await sequelize.getQueryInterface().createTable({ tableName: 'WeeklyPlans', schema }, {
    weekStart: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    snapshot: { type: DataTypes.JSONB, allowNull: false },
    savedAt: { type: DataTypes.DATE, allowNull: false },
  }, { transaction });
};
