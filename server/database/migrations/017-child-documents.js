exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const documents = { tableName: 'ChildDocuments', schema };
  const revisions = { tableName: 'ChildDocumentRevisions', schema };
  await qi.createTable(documents, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    childId: { type: T.STRING, allowNull: false },
    title: { type: T.STRING(160), allowNull: false },
    category: { type: T.STRING(16), allowNull: false },
    documentDate: { type: T.DATEONLY, allowNull: true },
    notes: { type: T.STRING(2000), allowNull: false, defaultValue: '' },
    version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
    currentRevisionId: { type: T.STRING, allowNull: false },
    createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  await qi.addConstraint(documents, { fields: ['childId'], type: 'foreign key', name: 'child_document_child_reference',
    references: { table: { tableName: 'Children', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(documents, ['childId', 'updatedAt', 'id'], { name: 'child_document_list', transaction });
  await qi.createTable(revisions, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    documentId: { type: T.STRING, allowNull: false }, revision: { type: T.INTEGER, allowNull: false },
    filename: { type: T.STRING(200), allowNull: false }, contentType: { type: T.STRING(32), allowNull: false },
    byteLength: { type: T.INTEGER, allowNull: false }, sha256: { type: T.STRING(64), allowNull: false },
    content: { type: T.BLOB, allowNull: false }, uploadedAt: { type: T.DATE, allowNull: false },
    actorId: { type: T.STRING, allowNull: false }, uploadedBy: { type: T.STRING(64), allowNull: false },
    changeNote: { type: T.STRING(500), allowNull: false, defaultValue: '' },
    requestId: { type: T.STRING(36), allowNull: false }, requestScope: { type: T.STRING(64), allowNull: false },
    requestHash: { type: T.STRING(64), allowNull: false },
  }, { transaction });
  for (const [field, table, name] of [['documentId', 'ChildDocuments', 'child_document_revision_reference'],
    ['actorId', 'Accounts', 'child_document_actor_reference']]) {
    await qi.addConstraint(revisions, { fields: [field], type: 'foreign key', name,
      references: { table: { tableName: table, schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  }
  await qi.addIndex(revisions, ['documentId', 'revision'], { unique: true, name: 'child_document_revision_order', transaction });
  await qi.addIndex(revisions, ['requestScope', 'requestId'], { unique: true, name: 'child_document_request_once', transaction });
  await qi.addIndex(revisions, ['id', 'documentId'], { unique: true, name: 'child_document_revision_scope', transaction });
  // The deferred composite reference allows the initial head/revision to be
  // inserted atomically and forbids a head pointing at another child's file.
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocuments" ADD CONSTRAINT "child_document_current_reference" ' +
    'FOREIGN KEY ("currentRevisionId", "id") REFERENCES "' + schema + '"."ChildDocumentRevisions" ("id", "documentId") ' +
    'ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocuments" ADD CONSTRAINT "child_document_valid" CHECK (' +
    '"version" > 0 AND length(btrim("title")) > 0 AND "category" IN (\'medical\',\'contract\',\'consent\',\'other\'))', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocumentRevisions" ADD CONSTRAINT "child_document_revision_valid" CHECK (' +
    '"revision" > 0 AND "byteLength" > 0 AND "byteLength" <= 5242880 AND octet_length("content") = "byteLength" AND ' +
    '"contentType" IN (\'application/pdf\',\'image/jpeg\',\'image/png\'))', { transaction });
};
