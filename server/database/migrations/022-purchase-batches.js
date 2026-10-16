// One immutable receiving snapshot groups legacy purchase and ledger records.
// Existing single-item receipts remain valid with a NULL batchId.
exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const batches = { tableName: 'PurchaseBatches', schema };
  await qi.createTable(batches, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    requestId: { type: T.STRING(100), allowNull: false },
    request: { type: T.JSONB, allowNull: false },
    receivedOn: { type: T.DATEONLY, allowNull: false },
    supplier: { type: T.STRING(200), allowNull: true },
    reason: { type: T.STRING(500), allowNull: false },
    currency: { type: T.STRING(3), allowNull: false, defaultValue: 'USD' },
    actorId: { type: T.STRING, allowNull: false },
    actorUsername: { type: T.STRING(64), allowNull: false },
    recordedAt: { type: T.DATE, allowNull: false },
    purchasingRef: { type: T.JSONB, allowNull: true },
    purchasingWeekStart: { type: T.DATEONLY, allowNull: true },
    purchasingCalculationKey: { type: T.STRING(64), allowNull: true },
    lines: { type: T.JSONB, allowNull: false },
  }, { transaction });
  await qi.addConstraint(batches, { fields: ['actorId'], type: 'foreign key', name: 'purchase_batch_actor_reference',
    references: { table: { tableName: 'Accounts', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(batches, ['requestId'], { unique: true, name: 'purchase_batch_request_once', transaction });
  await qi.addIndex(batches, ['recordedAt', 'id'], { name: 'purchase_batch_history', transaction });
  await qi.addIndex(batches, ['purchasingWeekStart', 'purchasingCalculationKey', 'recordedAt', 'id'], {
    name: 'purchase_batch_calculation', transaction,
  });
  // Explicit IS NOT NULL guards close SQL CHECK's unknown/NULL escape hatch for
  // linked snapshots whose JSON keys are absent or contain JSON null.
  await sequelize.query(`ALTER TABLE "${schema}"."PurchaseBatches"
    ADD CONSTRAINT "purchase_batch_valid" CHECK (
      length(btrim("requestId")) > 0 AND length(btrim("reason")) > 0 AND
      length(btrim("actorUsername")) > 0 AND "currency" = 'USD' AND
      jsonb_typeof("request") = 'object' AND
      jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 50 AND
      (("purchasingRef" IS NULL AND "purchasingWeekStart" IS NULL AND "purchasingCalculationKey" IS NULL) OR
       ("purchasingRef" IS NOT NULL AND "purchasingWeekStart" IS NOT NULL AND "purchasingCalculationKey" IS NOT NULL AND
        jsonb_typeof("purchasingRef") = 'object' AND extract(isodow FROM "purchasingWeekStart") = 1 AND
        "purchasingCalculationKey" ~ '^[0-9a-f]{64}$' AND
        "purchasingRef"->>'weekStart' IS NOT NULL AND "purchasingRef"->>'weekStart' = "purchasingWeekStart"::text AND
        "purchasingRef"->>'calculationKey' IS NOT NULL AND "purchasingRef"->>'calculationKey' = "purchasingCalculationKey" AND
        "purchasingRef"->>'version' IS NOT NULL AND "purchasingRef"->>'version' ~ '^[1-9][0-9]*$' AND
        "purchasingRef"->>'stockTakenAt' IS NOT NULL AND length("purchasingRef"->>'stockTakenAt') > 0))
    )`, { transaction });
  for (const [tableName, prefix] of [['PurchaseReceipts', 'purchase_receipt'], ['InventoryMovements', 'inventory_movement']]) {
    const table = { tableName, schema };
    await qi.addColumn(table, 'batchId', { type: T.STRING, allowNull: true }, { transaction });
    await qi.addConstraint(table, { fields: ['batchId'], type: 'foreign key', name: `${prefix}_batch_reference`,
      references: { table: batches, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
    await qi.addIndex(table, ['batchId'], { name: `${prefix}_batch`, transaction });
  }
};
