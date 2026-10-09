// Access to the ordinary child roster never implicitly grants access to private
// paperwork. Administrators have effective edit access in the auth service;
// all other existing accounts begin with no document access.
exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  await sequelize.getQueryInterface().addColumn({ tableName: 'Accounts', schema }, 'documentAccess', {
    type: DataTypes.STRING(16), allowNull: false, defaultValue: 'none',
  }, { transaction });
  const table = sequelize.getQueryInterface().queryGenerator.quoteTable({ tableName: 'Accounts', schema });
  await sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT "account_document_access_valid"
    CHECK ("documentAccess" IN ('none', 'view', 'edit'))`, { transaction });
};
