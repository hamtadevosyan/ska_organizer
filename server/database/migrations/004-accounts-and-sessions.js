exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const q = sequelize.getQueryInterface();
  const table = (tableName) => ({ tableName, schema });
  const id = { type: T.STRING, primaryKey: true, allowNull: false };
  const date = { type: T.DATE, allowNull: false };
  await q.createTable(table('Accounts'), {
    id, username: { type: T.STRING(64), allowNull: false, unique: true },
    displayName: { type: T.STRING(100), allowNull: false },
    passwordHash: { type: T.TEXT, allowNull: false },
    role: { type: T.STRING(16), allowNull: false },
    disabled: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
    mustChangePassword: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: date, updatedAt: date,
  }, { transaction });
  await sequelize.query(`ALTER TABLE "${schema}"."Accounts" ADD CONSTRAINT account_role_valid
    CHECK (role IN ('admin', 'editor', 'viewer'))`, { transaction });
  await q.createTable(table('Sessions'), {
    id, accountId: { type: T.STRING, allowNull: false,
      references: { model: table('Accounts'), key: 'id' }, onDelete: 'CASCADE' },
    createdAt: date, lastSeenAt: date, expiresAt: date,
  }, { transaction });
  await q.addIndex(table('Sessions'), ['accountId'], { transaction });
  await q.addIndex(table('Sessions'), ['expiresAt'], { transaction });
  await q.createTable(table('LoginAttempts'), {
    id, count: { type: T.INTEGER, allowNull: false }, expiresAt: date,
  }, { transaction });
  await q.createTable(table('AuditEvents'), {
    id, actorId: { type: T.STRING, allowNull: true,
      references: { model: table('Accounts'), key: 'id' }, onDelete: 'RESTRICT' },
    actorUsername: { type: T.STRING(64), allowNull: false },
    action: { type: T.STRING(80), allowNull: false },
    entityId: { type: T.STRING, allowNull: true }, occurredAt: date,
  }, { transaction });
  await q.addIndex(table('AuditEvents'), ['occurredAt', 'id'], { transaction });
};
