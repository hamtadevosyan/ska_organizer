// Removal retains group tombstones and exact stock/history. No rows are seeded,
// balances changed or historical JSON rewritten by this migration.
exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const groups = { tableName: 'InventoryGroups', schema };
  const items = { tableName: 'InventoryItems', schema };
  const operations = { tableName: 'InventoryGroupOperations', schema };
  const movements = { tableName: 'InventoryMovements', schema };
  await qi.addColumn(groups, 'version', { type: T.INTEGER, allowNull: false, defaultValue: 1 }, { transaction });
  await qi.addColumn(groups, 'archived', { type: T.BOOLEAN, allowNull: false, defaultValue: false }, { transaction });
  await qi.addColumn(groups, 'archivedAt', { type: T.DATE, allowNull: true }, { transaction });
  await qi.addColumn(groups, 'deletedAt', { type: T.DATE, allowNull: true }, { transaction });
  await qi.addColumn(items, 'archived', { type: T.BOOLEAN, allowNull: false, defaultValue: false }, { transaction });
  await qi.addColumn(items, 'archivedAt', { type: T.DATE, allowNull: true }, { transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."InventoryGroups" ADD CONSTRAINT "inventory_group_lifecycle_valid" CHECK (
    "version" > 0 AND (("archived" AND "archivedAt" IS NOT NULL AND "deletedAt" IS NULL) OR
      (NOT "archived" AND "archivedAt" IS NULL)))`, { transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."InventoryItems" ADD CONSTRAINT "inventory_item_lifecycle_valid" CHECK (
    ("archived" AND "archivedAt" IS NOT NULL) OR (NOT "archived" AND "archivedAt" IS NULL))`, { transaction });
  // Archived names are reserved. Only an actual removed tombstone releases the
  // name, without dropping the old group/request identity or foreign keys.
  // Sequelize 6's PostgreSQL removeIndexQuery drops an explicitly named index
  // without the table's schema. Qualify it so disposable test schemas (and any
  // non-public deployment schema) cannot retain or remove the wrong index.
  const quote = (identifier) => qi.queryGenerator.quoteIdentifier(identifier);
  await sequelize.query(`DROP INDEX ${quote(schema)}.${quote('inventory_group_name')}`, { transaction });
  await qi.addIndex(groups, ['nameKey'], { unique: true, name: 'inventory_group_name', where: { deletedAt: null }, transaction });
  await qi.addIndex(groups, ['archived', 'deletedAt'], { name: 'inventory_group_lifecycle', transaction });
  await qi.addIndex(items, ['archived', 'groupId'], { name: 'inventory_item_lifecycle', transaction });
  await qi.createTable(operations, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    requestId: { type: T.STRING(100), allowNull: false },
    request: { type: T.JSONB, allowNull: false }, result: { type: T.JSONB, allowNull: false },
    action: { type: T.STRING(16), allowNull: false },
    sourceGroupId: { type: T.STRING, allowNull: false }, targetGroupId: { type: T.STRING, allowNull: true },
    actorId: { type: T.STRING, allowNull: false }, actorUsername: { type: T.STRING(64), allowNull: false },
    recordedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  for (const [field, tableName, name] of [
    ['sourceGroupId', 'InventoryGroups', 'inventory_group_operation_source'],
    ['targetGroupId', 'InventoryGroups', 'inventory_group_operation_target'],
    ['actorId', 'Accounts', 'inventory_group_operation_actor'],
  ]) await qi.addConstraint(operations, { fields: [field], type: 'foreign key', name,
    references: { table: { tableName, schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(operations, ['requestId'], { unique: true, name: 'inventory_group_operation_request_once', transaction });
  await qi.addIndex(operations, ['sourceGroupId', 'recordedAt'], { name: 'inventory_group_operation_source_history', transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."InventoryGroupOperations" ADD CONSTRAINT "inventory_group_operation_valid" CHECK (
    length(btrim("requestId")) > 0 AND length(btrim("actorUsername")) > 0 AND
    jsonb_typeof("request") = 'object' AND jsonb_typeof("result") = 'object' AND
    "action" IN ('delete','move','archive') AND
    (("action" = 'move' AND "targetGroupId" IS NOT NULL AND "targetGroupId" <> "sourceGroupId") OR
      ("action" IN ('delete','archive') AND "targetGroupId" IS NULL)) AND
    "result"->>'id' IS NOT NULL AND "result"->>'id' = "id" AND
    "result"->>'action' IS NOT NULL AND "result"->>'action' = "action" AND
    "result"#>>'{sourceBefore,id}' IS NOT NULL AND "result"#>>'{sourceBefore,id}' = "sourceGroupId" AND
    "result"#>>'{sourceAfter,id}' IS NOT NULL AND "result"#>>'{sourceAfter,id}' = "sourceGroupId")`, { transaction });
  await qi.addColumn(movements, 'groupOperationId', { type: T.STRING, allowNull: true }, { transaction });
  await qi.addConstraint(movements, { fields: ['groupOperationId'], type: 'foreign key', name: 'inventory_movement_group_operation',
    references: { table: operations, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(movements, ['groupOperationId'], { name: 'inventory_movement_group_operation_history', transaction });
};
