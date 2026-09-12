// Keep existing child IDs, unknown profile fields and historical attendance intact.
module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const children = { tableName: 'Children', schema };
    await qi.addColumn(children, 'active', { type: T.BOOLEAN, allowNull: false, defaultValue: true }, { transaction });
    await qi.addIndex(children, ['active', 'roomId'], { name: 'children_enrollment_room_lookup', transaction });
    // Legacy attendance may reference IDs that predate persistent child records.
    // NOT VALID preserves those rows while protecting all future writes/deletes.
    const attendance = qi.queryGenerator.quoteTable({ tableName: 'Attendances', schema });
    const childTable = qi.queryGenerator.quoteTable(children);
    await sequelize.query('ALTER TABLE ' + attendance + ' ADD CONSTRAINT "attendance_child_reference" ' +
      'FOREIGN KEY ("childId") REFERENCES ' + childTable + ' ("id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID', { transaction });
  },
};
