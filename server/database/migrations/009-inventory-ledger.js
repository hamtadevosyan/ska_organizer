module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const items = { tableName: 'InventoryItems', schema };
    const movements = { tableName: 'InventoryMovements', schema };
    await qi.createTable(items, {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      name: { type: T.STRING(100), allowNull: false }, category: { type: T.STRING(80), allowNull: false },
      location: { type: T.STRING(200), allowNull: false }, unit: { type: T.STRING(16), allowNull: false },
      ingredientId: { type: T.STRING, allowNull: true },
      quantity: { type: T.DECIMAL(18, 6), allowNull: false, defaultValue: 0 },
      reorderThreshold: { type: T.DECIMAL(18, 6), allowNull: false, defaultValue: 0 },
      version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
      createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
    }, { transaction });
    await qi.addConstraint(items, { fields: ['ingredientId'], type: 'foreign key', name: 'inventory_ingredient_reference',
      references: { table: { tableName: 'Ingredients', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
    await sequelize.query('ALTER TABLE "' + schema + '"."InventoryItems" ADD CONSTRAINT "inventory_item_valid" CHECK (' +
      '"quantity" >= 0 AND "reorderThreshold" >= 0 AND "version" > 0 AND length(btrim("name")) > 0 AND length(btrim("category")) > 0 AND length(btrim("location")) > 0 AND ' +
      '"unit" IN (\'count\',\'g\',\'ml\',\'oz\',\'lb\',\'gal\',\'box\',\'pack\'))', { transaction });
    await qi.addIndex(items, ['category', 'location'], { name: 'inventory_filter_lookup', transaction });
    await qi.addIndex(items, ['ingredientId'], { name: 'inventory_ingredient_lookup', transaction });
    await qi.createTable(movements, {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      itemId: { type: T.STRING, allowNull: false }, type: { type: T.STRING(16), allowNull: false },
      delta: { type: T.DECIMAL(18, 6), allowNull: false },
      beforeQuantity: { type: T.DECIMAL(18, 6), allowNull: false }, afterQuantity: { type: T.DECIMAL(18, 6), allowNull: false },
      reason: { type: T.STRING(500), allowNull: false },
      actorId: { type: T.STRING, allowNull: false }, actorUsername: { type: T.STRING(64), allowNull: false },
      occurredAt: { type: T.DATE, allowNull: false }, itemVersion: { type: T.INTEGER, allowNull: false },
      before: { type: T.JSONB, allowNull: true }, after: { type: T.JSONB, allowNull: false },
      requestId: { type: T.STRING(100), allowNull: false }, request: { type: T.JSONB, allowNull: false },
    }, { transaction });
    for (const [field, table, name] of [['itemId', 'InventoryItems', 'inventory_movement_item'], ['actorId', 'Accounts', 'inventory_movement_actor']]) {
      await qi.addConstraint(movements, { fields: [field], type: 'foreign key', name,
        references: { table: { tableName: table, schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
    }
    await qi.addIndex(movements, ['requestId'], { unique: true, name: 'inventory_request_once', transaction });
    await qi.addIndex(movements, ['itemId', 'itemVersion'], { unique: true, name: 'inventory_movement_order', transaction });
    await sequelize.query('ALTER TABLE "' + schema + '"."InventoryMovements" ADD CONSTRAINT "inventory_movement_valid" CHECK (' +
      '"beforeQuantity" >= 0 AND "afterQuantity" >= 0 AND "afterQuantity" - "beforeQuantity" = "delta" AND "itemVersion" > 0 AND length(btrim("reason")) > 0 AND ' +
      '"type" IN (\'opening\',\'addition\',\'usage\',\'correction\',\'details\'))', { transaction });
  },
};
