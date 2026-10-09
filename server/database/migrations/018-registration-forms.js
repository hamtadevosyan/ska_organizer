exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const forms = { tableName: 'RegistrationForms', schema };
  const revisions = { tableName: 'RegistrationFormRevisions', schema };
  const documents = { tableName: 'ChildDocuments', schema };
  await qi.createTable(forms, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    title: { type: T.STRING(160), allowNull: false },
    instructions: { type: T.STRING(2000), allowNull: false, defaultValue: '' },
    category: { type: T.STRING(16), allowNull: false },
    required: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: T.BOOLEAN, allowNull: false, defaultValue: true },
    version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
    currentRevisionId: { type: T.STRING, allowNull: false },
    createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  await qi.addIndex(forms, ['updatedAt', 'id'], { name: 'registration_form_list', transaction });
  await qi.createTable(revisions, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    formId: { type: T.STRING, allowNull: false }, revision: { type: T.INTEGER, allowNull: false },
    filename: { type: T.STRING(200), allowNull: false }, contentType: { type: T.STRING(32), allowNull: false },
    byteLength: { type: T.INTEGER, allowNull: false }, sha256: { type: T.STRING(64), allowNull: false },
    content: { type: T.BLOB, allowNull: false }, uploadedAt: { type: T.DATE, allowNull: false },
    actorId: { type: T.STRING, allowNull: false }, uploadedBy: { type: T.STRING(64), allowNull: false },
    changeNote: { type: T.STRING(500), allowNull: false, defaultValue: '' },
    requestId: { type: T.STRING(36), allowNull: false }, requestScope: { type: T.STRING(64), allowNull: false },
    requestHash: { type: T.STRING(64), allowNull: false },
  }, { transaction });
  for (const [field, table, name] of [['formId', 'RegistrationForms', 'registration_form_revision_reference'],
    ['actorId', 'Accounts', 'registration_form_actor_reference']]) {
    await qi.addConstraint(revisions, { fields: [field], type: 'foreign key', name,
      references: { table: { tableName: table, schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  }
  await qi.addIndex(revisions, ['formId', 'revision'], { unique: true, name: 'registration_form_revision_order', transaction });
  await qi.addIndex(revisions, ['requestScope', 'requestId'], { unique: true, name: 'registration_form_request_once', transaction });
  await qi.addIndex(revisions, ['id', 'formId'], { unique: true, name: 'registration_form_revision_scope', transaction });
  // A deferred head reference permits the first form and its revision to be
  // inserted together, while ensuring that the revision belongs to that form.
  await sequelize.query('ALTER TABLE "' + schema + '"."RegistrationForms" ADD CONSTRAINT "registration_form_current_reference" ' +
    'FOREIGN KEY ("currentRevisionId", "id") REFERENCES "' + schema + '"."RegistrationFormRevisions" ("id", "formId") ' +
    'ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."RegistrationForms" ADD CONSTRAINT "registration_form_valid" CHECK (' +
    '"version" > 0 AND length(btrim("title")) > 0 AND "category" IN (\'medical\',\'contract\',\'consent\',\'other\'))', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."RegistrationFormRevisions" ADD CONSTRAINT "registration_form_revision_valid" CHECK (' +
    '"revision" > 0 AND "byteLength" > 0 AND "byteLength" <= 5242880 AND octet_length("content") = "byteLength" AND ' +
    '"contentType" IN (\'application/pdf\',\'image/jpeg\',\'image/png\'))', { transaction });

  for (const field of ['registrationFormId', 'registrationFormRevisionId', 'reviewedRevisionId', 'reviewedBy']) {
    await qi.addColumn(documents, field, { type: T.STRING, allowNull: true }, { transaction });
  }
  await qi.addColumn(documents, 'reviewedAt', { type: T.DATE, allowNull: true }, { transaction });
  await qi.addIndex(documents, ['childId', 'registrationFormId', 'id'], { name: 'child_document_registration_form_list', transaction });
  await qi.addConstraint(documents, { fields: ['reviewedBy'], type: 'foreign key', name: 'child_document_reviewer_reference',
    references: { table: { tableName: 'Accounts', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocuments" ADD CONSTRAINT "child_document_registration_form_reference" ' +
    'FOREIGN KEY ("registrationFormRevisionId", "registrationFormId") REFERENCES "' + schema + '"."RegistrationFormRevisions" ("id", "formId") ' +
    'ON DELETE RESTRICT ON UPDATE RESTRICT', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocuments" ADD CONSTRAINT "child_document_registration_form_paired" CHECK (' +
    '("registrationFormId" IS NULL) = ("registrationFormRevisionId" IS NULL))', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocuments" ADD CONSTRAINT "child_document_reviewed_revision_reference" ' +
    'FOREIGN KEY ("reviewedRevisionId", "id") REFERENCES "' + schema + '"."ChildDocumentRevisions" ("id", "documentId") ' +
    'ON DELETE RESTRICT ON UPDATE RESTRICT', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."ChildDocuments" ADD CONSTRAINT "child_document_review_paired" CHECK (' +
    '("reviewedRevisionId" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL) OR ' +
    '("reviewedRevisionId" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL))', { transaction });
};
