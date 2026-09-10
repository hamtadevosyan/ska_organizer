// Published migrations are immutable. Preserve existing operational references.
module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const table = (tableName) => ({ tableName, schema });
    const qualified = (name) => '"' + schema + '"."' + name + '"';
    const dates = () => ({
      createdAt: { type: T.DATE, allowNull: false },
      updatedAt: { type: T.DATE, allowNull: false },
    });
    await qi.createTable(table('Rooms'), {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      name: { type: T.STRING(100), allowNull: false },
      ageMinMonths: T.INTEGER, ageMaxMonths: T.INTEGER, capacity: T.INTEGER,
      active: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
      ...dates(),
    }, { transaction });
    // This model existed before the numbered migration runner; CREATE IF NOT EXISTS
    // also preserves a table made with the earlier manual migration.
    await qi.createTable(table('ScheduleEntries'), {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      roomId: { type: T.STRING, allowNull: false },
      date: { type: T.DATEONLY, allowNull: false },
      timeBlock: { type: T.STRING, allowNull: false },
      activityId: { type: T.STRING, allowNull: false },
      ...dates(),
    }, { transaction });
    await qi.addColumn(table('Children'), 'roomId', { type: T.STRING, allowNull: true }, { transaction });
    const sources = ['Attendances', 'Activities', 'ScheduleEntries'];
    const union = sources.map((name) => 'SELECT "roomId" FROM ' + qualified(name) + ' WHERE "roomId" IS NOT NULL').join(' UNION ');
    await sequelize.query('INSERT INTO ' + qualified('Rooms') +
      ' ("id", "name", "active", "createdAt", "updatedAt") ' +
      'SELECT "roomId", LEFT(\'Imported room \' || "roomId", 100), false, NOW(), NOW() FROM (' + union + ') AS legacy', { transaction });
    // Imported room settings are deliberately unknown. Never invent capacities or ages.
    await sequelize.query('ALTER TABLE ' + qualified('Rooms') +
      ' ADD CONSTRAINT "room_settings_valid" CHECK (' +
      'length(btrim("name")) BETWEEN 1 AND 100 AND (' +
      '("ageMinMonths" IS NOT NULL AND "ageMaxMonths" IS NOT NULL AND "capacity" IS NOT NULL ' +
      'AND "ageMinMonths" BETWEEN 0 AND 216 AND "ageMaxMonths" BETWEEN "ageMinMonths" AND 216 AND "capacity" > 0) OR ' +
      '(NOT "active" AND "ageMinMonths" IS NULL AND "ageMaxMonths" IS NULL AND "capacity" IS NULL)))', { transaction });
    for (const name of ['Children', ...sources]) {
      await qi.addConstraint(table(name), {
        fields: ['roomId'], type: 'foreign key', name: name.toLowerCase() + '_room_reference',
        references: { table: table('Rooms'), field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction,
      });
      await qi.addIndex(table(name), ['roomId'], { name: name.toLowerCase() + '_room_lookup', transaction });
    }
    await qi.addIndex(table('ScheduleEntries'), ['roomId', 'date'], { name: 'schedule_room_date_lookup', transaction });
  },
};
