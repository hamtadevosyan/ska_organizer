module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const receipts = { tableName: 'PurchaseReceipts', schema };
    await qi.createTable(receipts, {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      itemId: { type: T.STRING, allowNull: false }, movementId: { type: T.STRING, allowNull: false },
      quantity: { type: T.DECIMAL(18, 6), allowNull: false }, unit: { type: T.STRING(16), allowNull: false },
      receivedOn: { type: T.DATEONLY, allowNull: false }, supplier: { type: T.STRING(200), allowNull: true },
      totalCost: { type: T.DECIMAL(14, 2), allowNull: true },
      currency: { type: T.STRING(3), allowNull: false, defaultValue: 'USD' },
      itemSnapshot: { type: T.JSONB, allowNull: false },
      actorId: { type: T.STRING, allowNull: false }, actorUsername: { type: T.STRING(64), allowNull: false },
      recordedAt: { type: T.DATE, allowNull: false },
    }, { transaction });
    for (const [field, table, name] of [['itemId', 'InventoryItems', 'purchase_item_reference'],
      ['movementId', 'InventoryMovements', 'purchase_movement_reference'], ['actorId', 'Accounts', 'purchase_actor_reference']]) {
      await qi.addConstraint(receipts, { fields: [field], type: 'foreign key', name,
        references: { table: { tableName: table, schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
    }
    await qi.addIndex(receipts, ['movementId'], { unique: true, name: 'purchase_movement_once', transaction });
    await qi.addIndex(receipts, ['itemId', 'receivedOn'], { name: 'purchase_item_date', transaction });
    await sequelize.query('ALTER TABLE "' + schema + '"."PurchaseReceipts" ADD CONSTRAINT "purchase_receipt_valid" CHECK (' +
      '"quantity" > 0 AND ("totalCost" IS NULL OR "totalCost" >= 0) AND "currency" = \'USD\' AND ' +
      '"unit" IN (\'count\',\'g\',\'ml\',\'oz\',\'lb\',\'gal\',\'box\',\'pack\'))', { transaction });
  },
};
