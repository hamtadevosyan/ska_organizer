exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const table = { tableName: 'CcrcStatementImports', schema };
  await qi.createTable(table, {
    id: { type: T.UUID, primaryKey: true, allowNull: false },
    fingerprint: { type: T.STRING(64), allowNull: false, unique: true },
    filename: { type: T.STRING(200), allowNull: false },
    contentType: { type: T.STRING(32), allowNull: false },
    byteLength: { type: T.INTEGER, allowNull: false },
    content: { type: T.BLOB, allowNull: false },
    data: { type: T.JSONB, allowNull: false },
    version: { type: T.INTEGER, allowNull: false },
    createdAt: { type: T.DATE, allowNull: false },
    updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  const quoted = qi.queryGenerator.quoteTable(table);
  await sequelize.query(`ALTER TABLE ${quoted}
    ADD CONSTRAINT ccrc_statement_version_positive CHECK (version > 0),
    ADD CONSTRAINT ccrc_statement_data_object CHECK (jsonb_typeof(data) = 'object'),
    ADD CONSTRAINT ccrc_statement_fingerprint_shape CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT ccrc_statement_original_size CHECK ("byteLength" > 0 AND "byteLength" <= 5242880 AND "byteLength" = octet_length(content)),
    ADD CONSTRAINT ccrc_statement_content_type CHECK ("contentType" IN ('application/pdf', 'image/jpeg', 'image/png')),
    ADD CONSTRAINT ccrc_statement_filename_present CHECK (length(btrim(filename)) > 0)`, { transaction });
};
