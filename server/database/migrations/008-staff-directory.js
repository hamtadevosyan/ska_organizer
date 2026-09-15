// Staff are operational records. They deliberately have no Account relationship.
module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const table = { tableName: 'StaffMembers', schema };
    await qi.createTable(table, {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      name: { type: T.STRING(100), allowNull: false },
      role: { type: T.STRING(100), allowNull: false },
      active: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
      roomId: { type: T.STRING, allowNull: true },
      version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
      createdAt: { type: T.DATE, allowNull: false },
      updatedAt: { type: T.DATE, allowNull: false },
    }, { transaction });
    await qi.addConstraint(table, {
      fields: ['roomId'], type: 'foreign key', name: 'staff_room_reference',
      references: { table: { tableName: 'Rooms', schema }, field: 'id' },
      onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction,
    });
    await sequelize.query('ALTER TABLE "' + schema + '"."StaffMembers" ADD CONSTRAINT "staff_details_valid" CHECK (' +
      'length(btrim("name")) BETWEEN 1 AND 100 AND length(btrim("role")) BETWEEN 1 AND 100 AND "version" > 0)', { transaction });
    await qi.addIndex(table, ['active', 'name', 'id'], { name: 'staff_directory_lookup', transaction });
    await qi.addIndex(table, ['roomId'], { name: 'staff_room_lookup', transaction });
  },
};
