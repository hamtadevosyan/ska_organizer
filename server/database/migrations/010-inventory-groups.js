const { randomUUID } = require('node:crypto');

module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const groups = { tableName: 'InventoryGroups', schema };
    const items = { tableName: 'InventoryItems', schema };
    await qi.createTable(groups, {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      name: { type: T.STRING(80), allowNull: false }, nameKey: { type: T.STRING(80), allowNull: false },
      kind: { type: T.STRING(16), allowNull: false, defaultValue: 'supplies' },
      description: { type: T.STRING(240), allowNull: false, defaultValue: '' },
      requestId: { type: T.STRING(100), allowNull: true }, request: { type: T.JSONB, allowNull: true },
      createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
    }, { transaction });
    await qi.addIndex(groups, ['nameKey'], { unique: true, name: 'inventory_group_name', transaction });
    await qi.addIndex(groups, ['requestId'], { unique: true, name: 'inventory_group_request_once', transaction });
    await sequelize.query('ALTER TABLE "' + schema + '"."InventoryGroups" ADD CONSTRAINT "inventory_group_valid" CHECK (' +
      'length(btrim("name")) > 0 AND length(btrim("nameKey")) > 0 AND "kind" IN (\'food\',\'supplies\'))', { transaction });
    await qi.addColumn(items, 'groupId', { type: T.STRING, allowNull: true }, { transaction });
    // Preserve the original category and every movement snapshot. Group membership
    // is added without altering stock, item versions, or any historical entry.
    const [rows] = await sequelize.query('SELECT "category", bool_or("ingredientId" IS NOT NULL) AS "hasFood" FROM "' + schema + '"."InventoryItems" GROUP BY "category" ORDER BY "category"', { transaction });
    const byName = new Map();
    for (const row of rows) {
      const name = row.category.trim().replace(/\s+/g, ' ');
      const key = name.toLowerCase();
      let group = byName.get(key);
      if (!group) {
        group = { id: randomUUID(), name, nameKey: key, kind: 'supplies', description: '', categories: [] };
        byName.set(key, group);
      }
      if (row.hasFood || /^(food|food stock|ingredients|groceries)$/.test(key)) group.kind = 'food';
      group.categories.push(row.category);
    }
    for (const { categories, ...group } of byName.values()) {
      await qi.bulkInsert(groups, [{ ...group, createdAt: new Date(), updatedAt: new Date() }], { transaction });
      await sequelize.query('UPDATE "' + schema + '"."InventoryItems" SET "groupId" = :id WHERE "category" IN (:categories)', {
        replacements: { id: group.id, categories }, transaction,
      });
    }
    await qi.changeColumn(items, 'groupId', { type: T.STRING, allowNull: false }, { transaction });
    await qi.addConstraint(items, { fields: ['groupId'], type: 'foreign key', name: 'inventory_group_reference',
      references: { table: groups, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
    await qi.addIndex(items, ['groupId', 'location'], { name: 'inventory_group_location', transaction });
  },
};
