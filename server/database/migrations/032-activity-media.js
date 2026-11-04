exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const activities = { tableName: 'Activities', schema }, media = { tableName: 'ActivityMedia', schema };
  await qi.addColumn(activities, 'illustrations', { type: T.JSONB, allowNull: false, defaultValue: [] }, { transaction });
  await qi.createTable(media, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    ownerAccountId: { type: T.STRING, allowNull: false }, fingerprint: { type: T.STRING(64), allowNull: false },
    step: { type: T.INTEGER, allowNull: false }, caption: { type: T.STRING(500), allowNull: false },
    width: { type: T.INTEGER, allowNull: false }, height: { type: T.INTEGER, allowNull: false },
    contentType: { type: T.STRING(32), allowNull: false }, byteLength: { type: T.INTEGER, allowNull: false },
    sha256: { type: T.STRING(64), allowNull: false }, content: { type: T.BLOB, allowNull: false },
    claimed: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: T.DATE, allowNull: false }, expiresAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  await qi.addConstraint(media, { fields: ['ownerAccountId'], type: 'foreign key', name: 'activity_media_owner_reference',
    references: { table: { tableName: 'Accounts', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(media, ['ownerAccountId', 'claimed', 'expiresAt'], { name: 'activity_media_preview_owner', transaction });
  const quoted = qi.queryGenerator.quoteTable(media), activityTable = qi.queryGenerator.quoteTable(activities);
  await sequelize.query(`ALTER TABLE ${quoted} ADD CONSTRAINT activity_media_valid CHECK (
    "step" BETWEEN 1 AND 6 AND length(btrim("caption")) BETWEEN 1 AND 500 AND
    "width" BETWEEN 1 AND 1024 AND "height" BETWEEN 1 AND 1024 AND "contentType" = 'image/png' AND
    "byteLength" BETWEEN 1 AND 8388608 AND octet_length("content") = "byteLength" AND
    "sha256" ~ '^[a-f0-9]{64}$' AND "fingerprint" ~ '^[a-f0-9]{64}$')`, { transaction });
  await sequelize.query(`ALTER TABLE ${activityTable} ADD CONSTRAINT activity_illustrations_array CHECK (
    CASE WHEN jsonb_typeof("illustrations") = 'array' THEN jsonb_array_length("illustrations") <= 6 ELSE false END)`, { transaction });
};
