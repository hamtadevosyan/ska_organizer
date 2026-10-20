exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const accounts = { tableName: 'Accounts', schema };
  await qi.addColumn(accounts, 'staffMemberId', {
    type: T.STRING, allowNull: true, defaultValue: null,
  }, { transaction });
  await qi.addConstraint(accounts, { fields: ['staffMemberId'], type: 'foreign key', name: 'account_staff_reference',
    references: { table: { tableName: 'StaffMembers', schema }, field: 'id' },
    onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(accounts, ['staffMemberId'], { unique: true, name: 'account_staff_unique', transaction });
  // Existing accounts are not guessed from names or job titles. NULL links
  // preserve existing access; administrators explicitly connect each employee.
};
