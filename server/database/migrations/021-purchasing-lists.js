// Reviewed buying choices are independent of the inventory ledger and saved plans.
exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  const table = { tableName: 'PurchasingLists', schema };
  await sequelize.getQueryInterface().createTable(table, {
    weekStart: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    snapshot: { type: DataTypes.JSONB, allowNull: false },
    savedAt: { type: DataTypes.DATE, allowNull: false },
  }, { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."PurchasingLists" ADD CONSTRAINT "purchasing_list_valid" CHECK (' +
    '"version" > 0 AND extract(isodow FROM "weekStart") = 1 AND jsonb_typeof("snapshot") = \'object\' AND ' +
    '"snapshot"->>\'weekStart\' IS NOT NULL AND "snapshot"->>\'weekStart\' = "weekStart"::text)', { transaction });
};
