exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const table = { tableName: 'RegistrationForms', schema };
  await sequelize.getQueryInterface().addColumn(table, 'audience', {
    type: T.STRING(16), allowNull: false, defaultValue: 'child',
  }, { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."RegistrationForms" ADD CONSTRAINT "registration_form_audience_valid" CHECK ("audience" IN (\'child\',\'employee\',\'facility\'))', { transaction });
};
