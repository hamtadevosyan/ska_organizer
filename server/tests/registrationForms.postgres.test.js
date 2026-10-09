const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { context } = require('./databaseSetup');
const request = require('./helpers/authenticatedRequest');
const db = require('../services/dbAdapter');
const app = require('../index');

const fixtures = Object.fromEntries(['pdf', 'png'].map(extension => [extension,
  readFileSync(path.join(__dirname, 'fixtures/child-documents', 'synthetic.' + extension))]));
const file = (extension = 'pdf') => ({ name: 'synthetic.' + extension,
  contentType: extension === 'pdf' ? 'application/pdf' : 'image/png', dataBase64: fixtures[extension].toString('base64') });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const formUrl = formId => '/api/registration-forms' + (formId ? '/' + formId : '');
const documentUrl = (childId, documentId) => '/api/children/' + childId + '/documents' + (documentId ? '/' + documentId : '');
const formEdit = (form, changes = {}) => ({ version: form.version, title: form.title, instructions: form.instructions,
  category: form.category, required: form.required, active: form.active, ...changes });

async function createForm(title = 'Synthetic persistent registration form') {
  const response = await request(app).post(formUrl()).send({ requestId: randomUUID(), title,
    instructions: 'Fictional paperwork for database verification only.', category: 'consent', required: true, file: file() });
  expect(response.status).toBe(201);
  return response.body;
}
async function createChild() {
  const response = await request(app).post('/api/children').send({ firstName: 'Synthetic', lastName: randomUUID(), dateOfBirth: '2022-06-15' });
  expect(response.status).toBe(201);
  return response.body;
}
async function createReturn(childId, form) {
  const response = await request(app).post(documentUrl(childId)).send({ requestId: randomUUID(), title: 'Synthetic returned consent',
    category: 'consent', documentDate: '2026-10-01', notes: 'Fictional returned paperwork.',
    registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId, file: file() });
  expect(response.status).toBe(201);
  return response.body;
}
async function seed() {
  const child = await createChild();
  const original = await createForm();
  const revised = await request(app).post(formUrl(original.form.id) + '/revisions').send({ requestId: randomUUID(), version: original.form.version,
    changeNote: 'Synthetic template revision two', file: file('png') });
  expect(revised.status).toBe(201);
  const returned = await createReturn(child.id, revised.body.form);
  const replacement = await request(app).post(documentUrl(child.id, returned.document.id) + '/revisions').send({ requestId: randomUUID(),
    version: returned.document.version, changeNote: 'Synthetic returned revision two', file: file('png') });
  expect(replacement.status).toBe(201);
  const approved = await request(app).put(documentUrl(child.id, returned.document.id) + '/review').send({ version: replacement.body.document.version, reviewed: true });
  expect(approved.status).toBe(200);
  return { child, original, form: revised.body.form, document: approved.body.document, firstReturnRevisionId: returned.revision.id };
}
async function snapshot(saved) {
  const forms = await request(app).get(formUrl(saved.form.id));
  const documents = await request(app).get(documentUrl(saved.child.id, saved.document.id));
  const checklist = await request(app).get(documentUrl(saved.child.id) + '/checklist');
  expect(forms.status).toBe(200);
  expect(documents.status).toBe(200);
  expect(checklist.status).toBe(200);
  const { connection, schema } = context();
  const [templates] = await connection.query(`SELECT "id", "formId", "revision", "content", "byteLength", "sha256", "actorId", "uploadedBy", "changeNote"
    FROM "${schema}"."RegistrationFormRevisions" WHERE "formId" = $1 ORDER BY "revision"`, { bind: [saved.form.id] });
  const [returns] = await connection.query(`SELECT "id", "documentId", "revision", "content", "byteLength", "sha256", "actorId", "uploadedBy", "changeNote"
    FROM "${schema}"."ChildDocumentRevisions" WHERE "documentId" = $1 ORDER BY "revision"`, { bind: [saved.document.id] });
  const normalize = rows => rows.map(row => {
    expect(Buffer.isBuffer(row.content)).toBe(true);
    expect(row.byteLength).toBe(row.content.length);
    expect(row.sha256).toBe(digest(row.content));
    return { ...row, content: row.content.toString('base64') };
  });
  return { form: forms.body, document: documents.body, checklist: checklist.body,
    templates: normalize(templates), returns: normalize(returns) };
}

test('template BYTEA, old revisions, mapping metadata and review snapshots survive adapter reconnect', async () => {
  const saved = await seed();
  const before = await snapshot(saved);
  expect(before.templates.map(row => row.content)).toEqual([fixtures.pdf.toString('base64'), fixtures.png.toString('base64')]);
  expect(before.returns.map(row => row.content)).toEqual([fixtures.pdf.toString('base64'), fixtures.png.toString('base64')]);
  expect(before.form).toMatchObject({ form: { version: 2, templateRevision: 2, currentRevisionId: saved.form.currentRevisionId }, total: 2 });
  expect(before.document.document).toMatchObject({ registrationFormId: saved.form.id, registrationFormRevisionId: saved.form.currentRevisionId,
    reviewedRevisionId: saved.document.currentRevisionId, reviewedBy: request.credentials().account.id, reviewedAt: expect.any(String) });
  expect(before.checklist).toMatchObject({ requiredTotal: 1, requiredComplete: 1, complete: true,
    items: [expect.objectContaining({ status: 'complete', document: expect.objectContaining({ id: saved.document.id }) })] });
  for (const row of [...before.templates, ...before.returns]) {
    expect(row).toMatchObject({ actorId: request.credentials().account.id, uploadedBy: 'test-admin' });
  }
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect(await snapshot(saved)).toEqual(before);
});

test('an archived requirement retains its linked, reviewed history after reconnecting', async () => {
  const saved = await seed();
  const retired = await request(app).put(formUrl(saved.form.id)).send(formEdit(saved.form, { active: false }));
  expect(retired.status).toBe(200);
  saved.form = retired.body.form;
  const before = await snapshot(saved);
  expect(before.form.form.active).toBe(false);
  expect(before.form.total).toBe(2);
  expect(before.document.document.reviewedRevisionId).toBe(saved.document.currentRevisionId);
  expect(before.checklist).toEqual({ items: [], requiredTotal: 0, requiredComplete: 0, missingBasicInfo: [], percentage: 0, complete: false });
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect(await snapshot(saved)).toEqual(before);
  const catalog = await request(app).get(formUrl()).query({ includeArchived: '1' });
  expect(catalog.body.items).toContainEqual(expect.objectContaining({ id: saved.form.id, active: false }));
});

test('native constraints reject cross-form heads and mappings, foreign review files, incomplete snapshots and bad BYTEA lengths', async () => {
  const saved = await seed();
  const otherForm = await createForm('Synthetic other registration form');
  const otherChild = await createChild();
  const otherReturn = await createReturn(otherChild.id, otherForm.form);
  const { connection, schema } = context();
  await expect(connection.query(`UPDATE "${schema}"."RegistrationForms" SET "currentRevisionId" = $1 WHERE "id" = $2`,
    { bind: [otherForm.revision.id, saved.form.id] })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query(`UPDATE "${schema}"."ChildDocuments" SET "registrationFormRevisionId" = $1 WHERE "id" = $2`,
    { bind: [otherForm.revision.id, saved.document.id] })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query(`UPDATE "${schema}"."ChildDocuments" SET "reviewedRevisionId" = $1 WHERE "id" = $2`,
    { bind: [otherReturn.revision.id, saved.document.id] })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query(`UPDATE "${schema}"."ChildDocuments" SET "registrationFormRevisionId" = NULL WHERE "id" = $1`,
    { bind: [saved.document.id] })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(connection.query(`UPDATE "${schema}"."ChildDocuments" SET "reviewedAt" = NULL WHERE "id" = $1`,
    { bind: [saved.document.id] })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(connection.query(`UPDATE "${schema}"."RegistrationFormRevisions" SET "byteLength" = 1 WHERE "id" = $1`,
    { bind: [saved.form.currentRevisionId] })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(connection.query(`DELETE FROM "${schema}"."RegistrationFormRevisions" WHERE "id" = $1`,
    { bind: [saved.form.currentRevisionId] })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  const after = await snapshot(saved);
  expect(after.form.form.currentRevisionId).toBe(saved.form.currentRevisionId);
  expect(after.document.document.reviewedRevisionId).toBe(saved.document.currentRevisionId);
  expect(after.checklist).toMatchObject({ requiredTotal: 2, requiredComplete: 1, complete: false });
  expect(after.checklist.items.find(item => item.form.id === saved.form.id)).toMatchObject({
    status: 'complete', document: { id: saved.document.id },
  });
});

test('the registration migration adds nullable mapping/review columns and stores template content as required BYTEA', async () => {
  const { connection, schema } = context();
  const [columns] = await connection.query(`SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns
    WHERE table_schema = $1 AND table_name IN ('ChildDocuments', 'RegistrationForms', 'RegistrationFormRevisions')`, { bind: [schema] });
  const column = (table, name) => columns.find(row => row.table_name === table && row.column_name === name);
  for (const name of ['registrationFormId', 'registrationFormRevisionId', 'reviewedRevisionId', 'reviewedBy']) {
    expect(column('ChildDocuments', name)).toMatchObject({ udt_name: 'varchar', is_nullable: 'YES' });
  }
  expect(column('ChildDocuments', 'reviewedAt')).toMatchObject({ udt_name: 'timestamptz', is_nullable: 'YES' });
  expect(column('RegistrationFormRevisions', 'content')).toMatchObject({ udt_name: 'bytea', is_nullable: 'NO' });
  expect(column('RegistrationForms', 'audience')).toMatchObject({ udt_name: 'varchar', is_nullable: 'NO' });
  for (const name of ['required', 'active']) expect(column('RegistrationForms', name)).toMatchObject({ udt_name: 'bool', is_nullable: 'NO' });
  const child = await createChild();
  const legacy = await request(app).post(documentUrl(child.id)).send({ requestId: randomUUID(), title: 'Synthetic unlinked legacy document',
    category: 'other', file: file() });
  expect(legacy.status).toBe(201);
  expect(legacy.body.document).toMatchObject({ registrationFormId: null, registrationFormRevisionId: null,
    reviewedRevisionId: null, reviewedBy: null, reviewedAt: null });
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  const stored = await db.getChildDocument(legacy.body.document.id, child.id);
  expect(stored).toMatchObject({ registrationFormId: null, registrationFormRevisionId: null,
    reviewedRevisionId: null, reviewedBy: null, reviewedAt: null });
});

test('database retry keys preserve one template and review requires the persisted optimistic version', async () => {
  const child = await createChild();
  const payload = { requestId: randomUUID(), title: 'Synthetic concurrent template retry', instructions: '', category: 'contract', required: true, file: file() };
  const responses = await Promise.all([1, 2].map(() => request(app).post(formUrl()).send(payload)));
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  expect(responses[0].body.form.id).toBe(responses[1].body.form.id);
  expect(responses[0].body.revision.id).toBe(responses[1].body.revision.id);
  expect(responses.filter(response => response.body.replayed)).toHaveLength(1);
  const returned = await createReturn(child.id, responses[0].body.form);
  const reviews = await Promise.all([1, 2].map(() => request(app).put(documentUrl(child.id, returned.document.id) + '/review')
    .send({ version: returned.document.version, reviewed: true })));
  expect(reviews.map(response => response.status).sort()).toEqual([200, 409]);
  const { connection, schema } = context();
  const [[count]] = await connection.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."RegistrationFormRevisions" WHERE "formId" = $1`,
    { bind: [responses[0].body.form.id] });
  expect(count.count).toBe(1);
  const events = (await db.listAudit({ limit: 100 })).filter(event => /registration_form|child_document/.test(event.action));
  expect(events.filter(event => event.action === 'registration_form.upload')).toHaveLength(1);
  expect(events.filter(event => event.action === 'child_document.review')).toHaveLength(1);
});
