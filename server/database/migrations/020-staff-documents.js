exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const documents = { tableName: 'StaffDocuments', schema };
  const revisions = { tableName: 'StaffDocumentRevisions', schema };
  const settings = { tableName: 'StaffDocumentSettings', schema };
  const metadata = () => ({
    title: { type: T.STRING(160), allowNull: false },
    category: { type: T.STRING(16), allowNull: false },
    documentDate: { type: T.DATEONLY, allowNull: true },
    notes: { type: T.STRING(2000), allowNull: false, defaultValue: '' },
    issuer: { type: T.STRING(200), allowNull: false, defaultValue: '' },
    reference: { type: T.STRING(100), allowNull: false, defaultValue: '' },
    issuedOn: { type: T.DATEONLY, allowNull: true }, expiresOn: { type: T.DATEONLY, allowNull: true },
    nonExpiring: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
    warningDays: { type: T.INTEGER, allowNull: true },
    registrationFormId: { type: T.STRING, allowNull: true },
    registrationFormRevisionId: { type: T.STRING, allowNull: true },
  });
  await qi.addColumn({ tableName: 'RegistrationForms', schema }, 'expirationRequired', {
    type: T.BOOLEAN, allowNull: false, defaultValue: false,
  }, { transaction });
  await qi.changeColumn({ tableName: 'RegistrationForms', schema }, 'currentRevisionId', {
    type: T.STRING, allowNull: true,
  }, { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."RegistrationForms" ADD CONSTRAINT "registration_form_optional_employee_file" ' +
    'CHECK ("currentRevisionId" IS NOT NULL OR "audience" = \'employee\')', { transaction });
  await qi.createTable(documents, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    staffId: { type: T.STRING, allowNull: false }, ...metadata(),
    version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
    currentRevisionId: { type: T.STRING, allowNull: false },
    reviewedRevisionId: { type: T.STRING, allowNull: true },
    reviewedBy: { type: T.STRING, allowNull: true }, reviewedAt: { type: T.DATE, allowNull: true },
    createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  await qi.addConstraint(documents, { fields: ['staffId'], type: 'foreign key', name: 'staff_document_staff_reference',
    references: { table: { tableName: 'StaffMembers', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addConstraint(documents, { fields: ['reviewedBy'], type: 'foreign key', name: 'staff_document_reviewer_reference',
    references: { table: { tableName: 'Accounts', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  await qi.addIndex(documents, ['staffId', 'updatedAt', 'id'], { name: 'staff_document_list', transaction });
  await qi.addIndex(documents, ['staffId', 'registrationFormId', 'id'], { name: 'staff_document_template_list', transaction });
  await qi.createTable(revisions, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    documentId: { type: T.STRING, allowNull: false }, revision: { type: T.INTEGER, allowNull: false }, ...metadata(),
    filename: { type: T.STRING(200), allowNull: false }, contentType: { type: T.STRING(32), allowNull: false },
    byteLength: { type: T.INTEGER, allowNull: false }, sha256: { type: T.STRING(64), allowNull: false },
    content: { type: T.BLOB, allowNull: false }, uploadedAt: { type: T.DATE, allowNull: false },
    actorId: { type: T.STRING, allowNull: false }, uploadedBy: { type: T.STRING(64), allowNull: false },
    changeNote: { type: T.STRING(500), allowNull: false, defaultValue: '' },
    requestId: { type: T.STRING(36), allowNull: false }, requestScope: { type: T.STRING(64), allowNull: false },
    requestHash: { type: T.STRING(64), allowNull: false },
  }, { transaction });
  for (const [field, table, name] of [['documentId', 'StaffDocuments', 'staff_document_revision_reference'],
    ['actorId', 'Accounts', 'staff_document_actor_reference']]) {
    await qi.addConstraint(revisions, { fields: [field], type: 'foreign key', name,
      references: { table: { tableName: table, schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
  }
  await qi.addIndex(revisions, ['documentId', 'revision'], { unique: true, name: 'staff_document_revision_order', transaction });
  await qi.addIndex(revisions, ['requestScope', 'requestId'], { unique: true, name: 'staff_document_request_once', transaction });
  await qi.addIndex(revisions, ['id', 'documentId'], { unique: true, name: 'staff_document_revision_scope', transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."StaffDocuments" ADD CONSTRAINT "staff_document_current_reference" ' +
    'FOREIGN KEY ("currentRevisionId", "id") REFERENCES "' + schema + '"."StaffDocumentRevisions" ("id", "documentId") ' +
    'ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."StaffDocuments" ADD CONSTRAINT "staff_document_reviewed_revision_reference" ' +
    'FOREIGN KEY ("reviewedRevisionId", "id") REFERENCES "' + schema + '"."StaffDocumentRevisions" ("id", "documentId") ' +
    'ON DELETE RESTRICT ON UPDATE RESTRICT', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."StaffDocuments" ADD CONSTRAINT "staff_document_review_paired" CHECK (' +
    '("reviewedRevisionId" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL) OR ' +
    '("reviewedRevisionId" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL))', { transaction });
  for (const [table, prefix] of [['StaffDocuments', 'staff_document'], ['StaffDocumentRevisions', 'staff_document_revision']]) {
    await qi.addConstraint({ tableName: table, schema }, { fields: ['registrationFormId'], type: 'foreign key', name: prefix + '_form_reference',
      references: { table: { tableName: 'RegistrationForms', schema }, field: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT', transaction });
    await sequelize.query('ALTER TABLE "' + schema + '"."' + table + '" ADD CONSTRAINT "' + prefix + '_template_reference" ' +
      'FOREIGN KEY ("registrationFormRevisionId", "registrationFormId") REFERENCES "' + schema + '"."RegistrationFormRevisions" ("id", "formId") ' +
      'ON DELETE RESTRICT ON UPDATE RESTRICT', { transaction });
    await sequelize.query('ALTER TABLE "' + schema + '"."' + table + '" ADD CONSTRAINT "' + prefix + '_metadata_valid" CHECK (' +
      'length(btrim("title")) > 0 AND "category" IN (\'medical\',\'contract\',\'consent\',\'other\') AND ' +
      '("registrationFormId" IS NOT NULL OR "registrationFormRevisionId" IS NULL) AND ' +
      '(NOT "nonExpiring" OR "expiresOn" IS NULL) AND ' +
      '("issuedOn" IS NULL OR "expiresOn" IS NULL OR "issuedOn" <= "expiresOn") AND ' +
      '("warningDays" IS NULL OR "warningDays" BETWEEN 1 AND 365))', { transaction });
  }
  await sequelize.query('ALTER TABLE "' + schema + '"."StaffDocuments" ADD CONSTRAINT "staff_document_version_valid" CHECK ("version" > 0)', { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."StaffDocumentRevisions" ADD CONSTRAINT "staff_document_revision_valid" CHECK (' +
    '"revision" > 0 AND "byteLength" > 0 AND "byteLength" <= 5242880 AND octet_length("content") = "byteLength" AND ' +
    '"contentType" IN (\'application/pdf\',\'image/jpeg\',\'image/png\'))', { transaction });
  await qi.createTable(settings, {
    id: { type: T.STRING, primaryKey: true, allowNull: false },
    warningDays: { type: T.INTEGER, allowNull: false, defaultValue: 40 },
    version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
    createdAt: { type: T.DATE, allowNull: false }, updatedAt: { type: T.DATE, allowNull: false },
  }, { transaction });
  await sequelize.query('ALTER TABLE "' + schema + '"."StaffDocumentSettings" ADD CONSTRAINT "staff_document_settings_valid" ' +
    'CHECK ("id" = \'current\' AND "version" > 0 AND "warningDays" BETWEEN 1 AND 365)', { transaction });
  const now = new Date();
  await qi.bulkInsert(settings, [{ id: 'current', warningDays: 40, version: 1, createdAt: now, updatedAt: now }], { transaction });
};
