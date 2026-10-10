const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DataTypes } = require('sequelize');
const db = require('../services/dbAdapter');
const { context } = require('./databaseSetup');
const request = require('./helpers/authenticatedRequest');
const { saveStaffDocuments, staffDocumentSnapshot, originalBytes } = require('./helpers/staffDocumentStorage');
const { migrate } = require('../database/migrate');

test('staff document bytes, original dates, template mapping and warning settings survive reconnecting', async () => {
  const saved = await saveStaffDocuments(request.credentials().account);
  const before = await staffDocumentSnapshot(saved);
  expect(before.revisions.map(({ revision, expiresOn }) => [revision, expiresOn])).toEqual([
    [3, '2028-10-01'], [2, '2027-10-01'], [1, '2027-10-01'],
  ]);
  expect(before.files[0].bytes).toBe(before.files[1].bytes);
  expect(before.files[1].bytes).not.toBe(before.files[2].bytes);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect(await staffDocumentSnapshot(saved)).toEqual(before);
});

test('PostgreSQL prevents wrong file heads, mismatched template maps, broken bytes and invalid expiry settings', async () => {
  const saved = await saveStaffDocuments(request.credentials().account);
  const { connection, schema } = context();
  const other = await saveStaffDocuments(request.credentials().account);
  const otherDocument = await db.getStaffDocument(other.documentId, other.person.id);
  const command = (sql, bind) => connection.query(sql.replaceAll('SCHEMA', schema), { bind });
  await expect(command('UPDATE "SCHEMA"."StaffDocuments" SET "currentRevisionId" = $1 WHERE id = $2',
    [otherDocument.currentRevisionId, saved.documentId])).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(command('UPDATE "SCHEMA"."StaffDocuments" SET "reviewedRevisionId" = $1 WHERE id = $2',
    [otherDocument.currentRevisionId, saved.documentId])).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(command('UPDATE "SCHEMA"."StaffDocuments" SET "registrationFormId" = $1 WHERE id = $2',
    [randomUUID(), saved.documentId])).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(command('UPDATE "SCHEMA"."StaffDocumentRevisions" SET "byteLength" = 1 WHERE "documentId" = $1',
    [saved.documentId])).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(command('UPDATE "SCHEMA"."StaffDocuments" SET "nonExpiring" = true WHERE id = $1',
    [saved.documentId])).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(command('UPDATE "SCHEMA"."StaffDocuments" SET "issuedOn" = $1 WHERE id = $2',
    ['2029-10-01', saved.documentId])).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(db.saveStaffDocumentSettings({ warningDays: 0, version: 3 })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(command('DELETE FROM "SCHEMA"."StaffMembers" WHERE id = $1', [saved.person.id]))
    .rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  expect((await staffDocumentSnapshot(saved)).settings).toMatchObject({ warningDays: 30, version: 2 });
});

test('file creation and metadata corrections roll back together if audit or authorization fails', async () => {
  const saved = await saveStaffDocuments(request.credentials().account);
  const before = await staffDocumentSnapshot(saved);
  await expect(db.withAuthLock(async () => {
    await db.updateStaffDocument(saved.documentId, { expiresOn: '2030-10-01', version: 4 });
    await db.saveStaffDocumentSettings({ warningDays: 20, version: 3 });
    throw new Error('Synthetic authorization failure');
  })).rejects.toThrow('Synthetic authorization failure');
  expect(await staffDocumentSnapshot(saved)).toEqual(before);
});

test('metadata-only requirements are restricted to employee templates and use real staff BYTEA columns', async () => {
  const saved = await saveStaffDocuments(request.credentials().account);
  const { connection, schema } = context();
  await expect(connection.query(`UPDATE "${schema}"."RegistrationForms" SET audience = 'child' WHERE id = $1`,
    { bind: [saved.form.id] })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  const [columns] = await connection.query(`SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns
    WHERE table_schema = $1 AND table_name IN ('StaffDocuments','StaffDocumentRevisions','StaffDocumentSettings')`, { bind: [schema] });
  expect(columns.find((row) => row.table_name === 'StaffDocumentRevisions' && row.column_name === 'content'))
    .toMatchObject({ udt_name: 'bytea', is_nullable: 'NO' });
  expect(columns.find((row) => row.table_name === 'StaffDocuments' && row.column_name === 'expiresOn'))
    .toMatchObject({ udt_name: 'date', is_nullable: 'YES' });
});

test('the additive staff migration preserves pre-existing staff and blank forms and does not reset warning settings when repeated', async () => {
  const { connection, schema: source } = context();
  const schema = 'skao_staff_migrate_' + randomUUID().replaceAll('-', '');
  const directory = path.join(__dirname, '../database/migrations');
  const legacy = fs.readdirSync(directory).filter((filename) => /^\d{3}-.+\.js$/.test(filename) && filename < '020-').sort();
  const actor = request.credentials().account;
  const staffId = randomUUID(); const formId = randomUUID(); const revisionId = randomUUID();
  const content = originalBytes();
  const checksum = createHash('sha256').update(content).digest('hex');
  const now = new Date();
  let created = false;
  try {
    await connection.createSchema(schema); created = true;
    await connection.transaction(async (transaction) => {
      await connection.getQueryInterface().createTable({ tableName: 'SequelizeMeta', schema }, {
        name: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
      }, { transaction });
      for (const filename of legacy) {
        await require(path.join(directory, filename)).up({ sequelize: connection, schema, transaction, DataTypes });
        await connection.getQueryInterface().bulkInsert({ tableName: 'SequelizeMeta', schema },
          [{ name: filename.slice(0, -3) }], { transaction });
      }
      await connection.query(`INSERT INTO "${schema}"."Accounts" SELECT * FROM "${source}"."Accounts" WHERE id = $1`,
        { bind: [actor.id], transaction });
      await connection.query(`INSERT INTO "${schema}"."StaffMembers" (id, name, role, active, "roomId", version, "createdAt", "updatedAt")
        VALUES ($1, 'Synthetic existing employee', 'Teacher', true, NULL, 1, $2, $2)`, { bind: [staffId, now], transaction });
      await connection.query(`INSERT INTO "${schema}"."RegistrationForms" (id, title, category, required, active, version, "currentRevisionId", "createdAt", "updatedAt")
        VALUES ($1, 'Synthetic existing blank', 'consent', true, true, 1, $2, $3, $3)`, { bind: [formId, revisionId, now], transaction });
      await connection.query(`INSERT INTO "${schema}"."RegistrationFormRevisions"
        (id, "formId", revision, filename, "contentType", "byteLength", sha256, content, "uploadedAt", "actorId", "uploadedBy", "requestId", "requestScope", "requestHash")
        VALUES ($1, $2, 1, 'synthetic-existing.png', 'image/png', $3, $4, $5, $6, $7, $8, $9, $10, $4)`,
      { bind: [revisionId, formId, content.length, checksum, content, now, actor.id, actor.username, randomUUID(), 'Synthetic old request'], transaction });
    });
    expect(await migrate(connection, schema)).toEqual(['020-staff-documents']);
    const [staff] = await connection.query(`SELECT id, name FROM "${schema}"."StaffMembers"`);
    expect(staff).toEqual([{ id: staffId, name: 'Synthetic existing employee' }]);
    const [forms] = await connection.query(`SELECT id, audience, "currentRevisionId", "expirationRequired" FROM "${schema}"."RegistrationForms"`);
    expect(forms).toEqual([{ id: formId, audience: 'child', currentRevisionId: revisionId, expirationRequired: false }]);
    const [revisions] = await connection.query(`SELECT content FROM "${schema}"."RegistrationFormRevisions"`);
    expect(revisions[0].content).toEqual(content);
    const [settings] = await connection.query(`SELECT id, "warningDays", version FROM "${schema}"."StaffDocumentSettings"`);
    expect(settings).toEqual([{ id: 'current', warningDays: 40, version: 1 }]);
    await connection.query(`UPDATE "${schema}"."StaffDocumentSettings" SET "warningDays" = 30, version = 2`);
    expect(await migrate(connection, schema)).toEqual([]);
    const [retained] = await connection.query(`SELECT "warningDays", version FROM "${schema}"."StaffDocumentSettings"`);
    expect(retained).toEqual([{ warningDays: 30, version: 2 }]);
  } finally {
    if (created) await connection.dropSchema(schema, { cascade: true });
  }
});
