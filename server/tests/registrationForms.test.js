const anonymous = require('supertest');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const request = require('./helpers/authenticatedRequest');
const { compatiblePdfFixtures } = require('./helpers/pdfCompatibilityFixtures');
const app = require('../index');
const db = require('../services/dbAdapter');

// These committed files contain only fictional, generated document text.
const fixtures = Object.fromEntries(['pdf', 'png'].map(extension => [extension,
  readFileSync(path.join(__dirname, 'fixtures/child-documents', 'synthetic.' + extension))]));
const types = { pdf: 'application/pdf', png: 'image/png' };
const file = (extension = 'pdf') => ({ name: 'synthetic.' + extension, contentType: types[extension],
  dataBase64: fixtures[extension].toString('base64') });
const metadata = { title: 'Synthetic registration consent', instructions: 'Complete this fictional form and return it.',
  category: 'consent', required: true };
const formUrl = (id = '') => '/api/registration-forms' + (id ? '/' + id : '');
const documentUrl = (childId, documentId = '') => '/api/children/' + childId + '/documents' + (documentId ? '/' + documentId : '');
const formPayload = (changes = {}) => ({ requestId: randomUUID(), ...metadata, file: file(), ...changes });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function child() {
  const response = await request(app).post('/api/children').send({ firstName: 'Synthetic', lastName: randomUUID(), dateOfBirth: '2022-01-15' });
  expect(response.status).toBe(201);
  return response.body;
}
async function createForm(changes = {}) {
  const response = await request(app).post(formUrl()).send(formPayload(changes));
  expect(response.status).toBe(201);
  return response.body;
}
async function formDetails(id) {
  const response = await request(app).get(formUrl(id));
  expect(response.status).toBe(200);
  return response.body;
}
const formEdit = (form, changes = {}) => ({ version: form.version, title: form.title, instructions: form.instructions,
  category: form.category, required: form.required, active: form.active, ...changes });
async function updateForm(form, changes = {}) {
  const response = await request(app).put(formUrl(form.id)).send(formEdit(form, changes));
  expect(response.status).toBe(200);
  return response.body.form;
}
async function reviseForm(form, changes = {}) {
  const response = await request(app).post(formUrl(form.id) + '/revisions').send({ requestId: randomUUID(), version: form.version,
    changeNote: 'Synthetic revised template', file: file('png'), ...changes });
  expect(response.status).toBe(201);
  return response.body;
}
async function upload(childId, form = null, changes = {}) {
  const response = await request(app).post(documentUrl(childId)).send({ requestId: randomUUID(), title: 'Synthetic returned form',
    category: 'consent', documentDate: null, notes: '', file: file(),
    ...(form ? { registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId } : {}), ...changes });
  expect(response.status).toBe(201);
  return response.body;
}
const documentEdit = (document, changes = {}) => ({ version: document.version, title: document.title, category: document.category,
  documentDate: document.documentDate, notes: document.notes, ...changes });
async function editDocument(childId, document, changes) {
  const response = await request(app).put(documentUrl(childId, document.id)).send(documentEdit(document, changes));
  expect(response.status).toBe(200);
  return response.body.document;
}
async function review(childId, document, reviewed = true) {
  const response = await request(app).put(documentUrl(childId, document.id) + '/review').send({ version: document.version, reviewed });
  expect(response.status).toBe(200);
  return response.body.document;
}
async function checklist(childId) {
  const response = await request(app).get(documentUrl(childId) + '/checklist');
  expect(response.status).toBe(200);
  return response.body;
}
const itemFor = (list, formId) => list.items.find(item => item.form.id === formId);
function binary(url, query = {}, credentials = null) {
  const api = credentials ? anonymous(app).get(url).set('Origin', request.origin).set('Cookie', credentials.cookie) : request(app).get(url);
  return api.query(query).buffer(true).parse((response, done) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => done(null, Buffer.concat(chunks)));
  });
}
const contentUrl = (formId, revisionId) => formUrl(formId) + '/revisions/' + revisionId + '/content';
function expectMetadataOnly(body) {
  expect(JSON.stringify(body)).not.toMatch(/dataBase64|"content"|"requestId"|"requestHash"|passwordHash|csrfToken/);
  expect(JSON.stringify(body)).not.toContain(fixtures.pdf.toString('base64'));
}
const auditEvents = async () => (await db.listAudit({ limit: 1000 })).filter(event => /registration_form|child_document/.test(event.action));
const api = (credentials, method, url, body = {}) => anonymous(app)[method](url).set('Origin', request.origin)
  .set('Cookie', credentials.cookie).set('X-CSRF-Token', credentials.csrf).send(body);
async function actor(role, documentAccess) {
  const administrator = await db.getAccount(request.credentials().account.id);
  const account = await db.createAccount({ id: randomUUID(), username: 'registration-' + randomUUID().slice(0, 8),
    displayName: 'Synthetic registration operator', passwordHash: administrator.passwordHash, role, documentAccess,
    disabled: false, mustChangePassword: false });
  return signIn(account.username);
}
async function signIn(username) {
  const response = await anonymous(app).post('/api/auth/login').set('Origin', request.origin).send({ username, password: request.password });
  expect(response.status).toBe(200);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken, account: response.body.account };
}

test.each(compatiblePdfFixtures)('a compatible PDF template (%s) uploads and downloads without changing file bytes', async (_name, bytes) => {
  const saved = await createForm({ file: { ...file(), dataBase64: bytes.toString('base64') } });
  expect(saved.revision.byteLength).toBe(bytes.length);
  expect(saved.revision.sha256).toBe(digest(bytes));
  for (const query of [{}, { download: '1' }]) {
    const response = await binary(contentUrl(saved.form.id, saved.revision.id), query);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers['cache-control']).toContain('no-store');
  }
});

test.each(['pdf', 'png'])('an administrator saves a real %s template with private, byte-exact preview and download', async extension => {
  const saved = await createForm({ file: file(extension) });
  expect(saved.form).toMatchObject({ ...metadata, active: true, version: 1, templateRevision: 1, currentRevisionId: saved.revision.id });
  expect(saved.revision).toMatchObject({ revision: 1, filename: file(extension).name, contentType: types[extension],
    byteLength: fixtures[extension].length, sha256: digest(fixtures[extension]), current: true, uploadedBy: 'test-admin' });
  expect(Number.isNaN(Date.parse(saved.form.updatedAt))).toBe(false);
  expectMetadataOnly(saved);
  const list = await request(app).get(formUrl());
  expect(list.status).toBe(200);
  expect(list.body.items).toEqual([saved.form]);
  expectMetadataOnly(list.body);
  const details = await formDetails(saved.form.id);
  expect(details).toMatchObject({ form: saved.form, total: 1, revisions: [saved.revision] });
  expectMetadataOnly(details);
  for (const query of [{}, { download: '1' }]) {
    const response = await binary(contentUrl(saved.form.id, saved.revision.id), query);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(fixtures[extension]);
    expect(response.headers['content-type']).toContain(types[extension]);
    expect(Number(response.headers['content-length'])).toBe(fixtures[extension].length);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(response.headers['content-disposition']).toMatch(query.download ? /^attachment;/ : /^inline;/);
  }
  const head = await request(app).head(contentUrl(saved.form.id, saved.revision.id));
  expect(head.status).toBe(200);
  expect(head.headers['cache-control']).toContain('no-store');
  expect(head.text).toBeUndefined();
});

test('an empty catalog cannot claim registration is complete, and adding requirements reaches existing children', async () => {
  const existingChild = await child();
  expect(await checklist(existingChild.id)).toEqual({ items: [], requiredTotal: 0, requiredComplete: 0, missingBasicInfo: [], percentage: 0, complete: false });
  const required = await createForm();
  const optional = await createForm({ title: 'Synthetic optional form', required: false });
  const list = await checklist(existingChild.id);
  expect(list).toMatchObject({ requiredTotal: 1, requiredComplete: 0, complete: false });
  expect(itemFor(list, required.form.id)).toMatchObject({ form: required.form, status: 'missing', document: null });
  expect(itemFor(list, optional.form.id)).toMatchObject({ status: 'missing', document: null });
  const returned = await upload(existingChild.id, required.form);
  const approved = await review(existingChild.id, returned.document);
  const complete = await checklist(existingChild.id);
  expect(complete).toMatchObject({ requiredTotal: 1, requiredComplete: 1, complete: true });
  expect(itemFor(complete, required.form.id)).toMatchObject({ status: 'complete', document: { id: approved.id } });
  expect(itemFor(complete, optional.form.id)).toMatchObject({ status: 'missing', document: null });
});

test('uploading the blank template needs explicit review before it counts as returned paperwork', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  expect(returned.document).toMatchObject({ registrationFormId: saved.form.id, registrationFormRevisionId: saved.revision.id,
    reviewedRevisionId: null, reviewedBy: null, reviewedAt: null });
  const before = await checklist(savedChild.id);
  expect(before).toMatchObject({ requiredTotal: 1, requiredComplete: 0, complete: false });
  expect(itemFor(before, saved.form.id)).toMatchObject({ status: 'needs_review', document: { id: returned.document.id } });
  const approved = await review(savedChild.id, returned.document);
  expect(approved).toMatchObject({ version: returned.document.version + 1, reviewedRevisionId: returned.revision.id,
    reviewedBy: request.credentials().account.id });
  expect(Number.isNaN(Date.parse(approved.reviewedAt))).toBe(false);
  expect(itemFor(await checklist(savedChild.id), saved.form.id).status).toBe('complete');
  const cleared = await review(savedChild.id, approved, false);
  expect(cleared).toMatchObject({ reviewedRevisionId: null, reviewedBy: null, reviewedAt: null });
  expect(itemFor(await checklist(savedChild.id), saved.form.id).status).toBe('needs_review');
});

test('unlinked uploads cannot satisfy a requirement merely by sharing its title or category', async () => {
  const savedChild = await child();
  const saved = await createForm();
  await upload(savedChild.id, null, { title: saved.form.title, category: saved.form.category });
  const list = await checklist(savedChild.id);
  expect(list).toMatchObject({ requiredComplete: 0, complete: false });
  expect(itemFor(list, saved.form.id)).toMatchObject({ status: 'missing', document: null });
});

test('a later template revision makes reviewed old paperwork outdated until it is mapped and reviewed again', async () => {
  const savedChild = await child();
  const original = await createForm();
  const returned = await upload(savedChild.id, original.form);
  let document = await review(savedChild.id, returned.document);
  const revised = await reviseForm(original.form);
  expect(revised.form).toMatchObject({ id: original.form.id, version: 2, templateRevision: 2, currentRevisionId: revised.revision.id });
  const outdated = await checklist(savedChild.id);
  expect(outdated).toMatchObject({ requiredComplete: 0, complete: false });
  expect(itemFor(outdated, original.form.id)).toMatchObject({ status: 'outdated', document: { id: document.id } });
  expect((await request(app).put(documentUrl(savedChild.id, document.id) + '/review').send({ version: document.version, reviewed: true })).status).toBe(409);
  document = await editDocument(savedChild.id, document, { registrationFormId: revised.form.id, registrationFormRevisionId: revised.revision.id });
  expect(document).toMatchObject({ reviewedRevisionId: null, reviewedBy: null, reviewedAt: null });
  expect(itemFor(await checklist(savedChild.id), original.form.id).status).toBe('needs_review');
  await review(savedChild.id, document);
  expect((await checklist(savedChild.id)).complete).toBe(true);
  const history = await formDetails(original.form.id);
  expect(history.total).toBe(2);
  expect(history.revisions.filter(revision => revision.current).map(revision => revision.id)).toEqual([revised.revision.id]);
  expect((await binary(contentUrl(original.form.id, original.revision.id))).body).toEqual(fixtures.pdf);
  expect((await binary(contentUrl(original.form.id, revised.revision.id))).body).toEqual(fixtures.png);
});

test('replacing a reviewed child file invalidates its review while preserving both file revisions', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  const approved = await review(savedChild.id, returned.document);
  const replacement = await request(app).post(documentUrl(savedChild.id, approved.id) + '/revisions').send({
    requestId: randomUUID(), version: approved.version, changeNote: 'Synthetic corrected return', file: file('png') });
  expect(replacement.status).toBe(201);
  expect(replacement.body.document).toMatchObject({ registrationFormId: saved.form.id, registrationFormRevisionId: saved.revision.id,
    reviewedRevisionId: null, reviewedBy: null, reviewedAt: null, currentRevisionId: replacement.body.revision.id });
  expect(itemFor(await checklist(savedChild.id), saved.form.id).status).toBe('needs_review');
  const oldContent = await binary(documentUrl(savedChild.id, approved.id) + '/revisions/' + returned.revision.id + '/content');
  expect(oldContent.body).toEqual(fixtures.pdf);
  await review(savedChild.id, replacement.body.document);
  expect((await checklist(savedChild.id)).complete).toBe(true);
});

test('moving reviewed paperwork to another form clears review; removing its mapping restores missing status', async () => {
  const savedChild = await child();
  const first = await createForm();
  const second = await createForm({ title: 'Synthetic second required form', category: 'contract' });
  const returned = await upload(savedChild.id, first.form);
  const approved = await review(savedChild.id, returned.document);
  const moved = await editDocument(savedChild.id, approved, { registrationFormId: second.form.id, registrationFormRevisionId: second.revision.id });
  expect(moved).toMatchObject({ reviewedRevisionId: null, reviewedBy: null, reviewedAt: null });
  const changed = await checklist(savedChild.id);
  expect(itemFor(changed, first.form.id).status).toBe('missing');
  expect(itemFor(changed, second.form.id).status).toBe('needs_review');
  const removed = await editDocument(savedChild.id, moved, { registrationFormId: null, registrationFormRevisionId: null });
  expect(removed).toMatchObject({ registrationFormId: null, registrationFormRevisionId: null });
  expect(itemFor(await checklist(savedChild.id), second.form.id).status).toBe('missing');
});

test('a newer unreviewed duplicate cannot mask an accepted current return', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  const approved = await review(savedChild.id, returned.document);
  await upload(savedChild.id, saved.form, { title: 'Synthetic later duplicate' });
  const list = await checklist(savedChild.id);
  expect(list).toMatchObject({ requiredComplete: 1, complete: true });
  expect(itemFor(list, saved.form.id)).toMatchObject({ status: 'complete', document: { id: approved.id } });
});

test('checklist computation considers accepted paperwork beyond the first document page', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  const approved = await review(savedChild.id, returned.document);
  for (let index = 0; index < 51; index++) await upload(savedChild.id, null, { title: 'Synthetic unrelated page ' + index });
  const firstPage = await request(app).get(documentUrl(savedChild.id)).query({ pageSize: 50, page: 1 });
  expect(firstPage.body).toMatchObject({ total: 52 });
  expect(firstPage.body.items.map(document => document.id)).not.toContain(approved.id);
  const list = await checklist(savedChild.id);
  expect(list).toMatchObject({ requiredComplete: 1, complete: true });
  expect(itemFor(list, saved.form.id).document.id).toBe(approved.id);
}, 20000);

test('archiving removes a requirement without removing template or child document history', async () => {
  const savedChild = await child();
  const required = await createForm();
  const archived = await createForm({ title: 'Synthetic retired requirement' });
  const returned = await upload(savedChild.id, archived.form);
  const approved = await review(savedChild.id, returned.document);
  await reviseForm(archived.form);
  const current = (await formDetails(archived.form.id)).form;
  const retired = await updateForm(current, { active: false });
  expect(retired.active).toBe(false);
  expect((await request(app).get(formUrl()).query({ includeArchived: '1' })).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: retired.id, active: false })]));
  const list = await checklist(savedChild.id);
  expect(list).toMatchObject({ requiredTotal: 1, requiredComplete: 0, complete: false });
  expect(list.items.map(item => item.form.id)).toEqual([required.form.id]);
  expect((await formDetails(retired.id)).total).toBe(2);
  const childHistory = await request(app).get(documentUrl(savedChild.id, approved.id));
  expect(childHistory.status).toBe(200);
  expect(childHistory.body.document.registrationFormId).toBe(retired.id);
  expect((await binary(contentUrl(retired.id, archived.revision.id))).body).toEqual(fixtures.pdf);
  expect((await review(savedChild.id, approved, false)).reviewedRevisionId).toBeNull();
});

test('catalog metadata edits use optimistic versions and preserve the current template revision', async () => {
  const original = await createForm();
  const saved = await updateForm(original.form, { title: 'Synthetic edited title', instructions: 'Updated fictional instructions.', category: 'contract', required: false });
  expect(saved).toMatchObject({ version: 2, title: 'Synthetic edited title', required: false, currentRevisionId: original.revision.id, templateRevision: 1 });
  const stale = await request(app).put(formUrl(saved.id)).send(formEdit(original.form));
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('REGISTRATION_FORM_CONFLICT');
  expect((await formDetails(saved.id)).total).toBe(1);
  expect((await binary(contentUrl(saved.id, original.revision.id))).body).toEqual(fixtures.pdf);
});

test.each([
  { file: { ...file(), dataBase64: 'not base64!' } },
  { file: { ...file('png'), dataBase64: fixtures.png.subarray(0, 25).toString('base64') } },
  { file: { ...file(), contentType: 'image/png' } },
  { file: { ...file(), name: '../synthetic.pdf' } },
])('invalid template revision input preserves the old current file and successful audits %#', async changes => {
  const original = await createForm();
  const before = await auditEvents();
  const response = await request(app).post(formUrl(original.form.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file(), ...changes });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('DOCUMENT_INVALID');
  expect(await formDetails(original.form.id)).toMatchObject({ form: original.form, total: 1 });
  expect((await binary(contentUrl(original.form.id, original.revision.id))).body).toEqual(fixtures.pdf);
  expect(await auditEvents()).toEqual(before);
});

test('invalid catalog metadata cannot create requirements', async () => {
  for (const changes of [{ title: '' }, { category: 'unknown' }, { required: 'yes' }, { instructions: {} }, { active: true }, { unexpected: true }]) {
    const response = await request(app).post(formUrl()).send(formPayload(changes));
    expect(response.status).toBe(400);
  }
  expect((await request(app).get(formUrl())).body.items).toEqual([]);
  expect(await auditEvents()).toEqual([]);
});

test('template creation and revision retries are idempotent even after later catalog changes', async () => {
  const payload = formPayload();
  const first = await request(app).post(formUrl()).send(payload);
  expect(first.status).toBe(201);
  const retry = await request(app).post(formUrl()).send(payload);
  expect(retry.status).toBe(201);
  expect(retry.body).toMatchObject({ replayed: true, form: { id: first.body.form.id }, revision: { id: first.body.revision.id } });
  const revisionPayload = { requestId: randomUUID(), version: 1, changeNote: 'Synthetic replacement', file: file('png') };
  const revised = await request(app).post(formUrl(first.body.form.id) + '/revisions').send(revisionPayload);
  expect(revised.status).toBe(201);
  await updateForm(revised.body.form, { active: false });
  const revisionRetry = await request(app).post(formUrl(first.body.form.id) + '/revisions').send(revisionPayload);
  expect(revisionRetry.status).toBe(201);
  expect(revisionRetry.body).toMatchObject({ replayed: true, revision: { id: revised.body.revision.id } });
  const lateCreationRetry = await request(app).post(formUrl()).send(payload);
  expect(lateCreationRetry.status).toBe(201);
  expect(lateCreationRetry.body.revision.id).toBe(first.body.revision.id);
  expect((await request(app).get(formUrl()).query({ includeArchived: '1' })).body.items).toHaveLength(1);
  expect((await formDetails(first.body.form.id)).total).toBe(2);
  expect(await auditEvents()).toHaveLength(3);
  expect((await request(app).post(formUrl()).send({ ...payload, title: 'Synthetic changed retry' })).status).toBe(409);
  expect((await request(app).post(formUrl(first.body.form.id) + '/revisions').send({ ...revisionPayload, file: file() })).status).toBe(409);
});

test('competing template revisions cannot both advance the same version', async () => {
  const original = await createForm();
  const responses = await Promise.all(['pdf', 'png'].map(extension => request(app).post(formUrl(original.form.id) + '/revisions').send({
    requestId: randomUUID(), version: 1, file: file(extension) })));
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  expect((await formDetails(original.form.id)).total).toBe(2);
  expect(await auditEvents()).toHaveLength(2);
});

test('mixed form revision IDs, stale template pins, unknown templates and incomplete mappings are rejected', async () => {
  const savedChild = await child();
  const first = await createForm();
  const second = await createForm({ title: 'Synthetic other form' });
  await reviseForm(first.form);
  const mappings = [
    { registrationFormId: first.form.id, registrationFormRevisionId: second.revision.id },
    { registrationFormId: first.form.id, registrationFormRevisionId: first.revision.id },
    { registrationFormId: randomUUID(), registrationFormRevisionId: randomUUID() },
    { registrationFormId: second.form.id },
    { registrationFormRevisionId: second.revision.id },
    { registrationFormId: null, registrationFormRevisionId: second.revision.id },
  ];
  for (const mapping of mappings) {
    const response = await request(app).post(documentUrl(savedChild.id)).send({ requestId: randomUUID(), title: 'Synthetic invalid mapping',
      category: 'consent', file: file(), ...mapping });
    expect([400, 404, 409]).toContain(response.status);
  }
  expect((await request(app).get(documentUrl(savedChild.id))).body.total).toBe(0);
  const retired = await updateForm(second.form, { active: false });
  const response = await request(app).post(documentUrl(savedChild.id)).send({ requestId: randomUUID(), title: 'Synthetic archived mapping',
    category: 'consent', file: file(), registrationFormId: retired.id, registrationFormRevisionId: retired.currentRevisionId });
  expect(response.status).toBe(409);
});

test('a mapped child upload retry still resolves its original upload after the template changes or is archived', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const payload = { requestId: randomUUID(), title: 'Synthetic retried return', category: 'consent', file: file(),
    registrationFormId: saved.form.id, registrationFormRevisionId: saved.revision.id };
  const first = await request(app).post(documentUrl(savedChild.id)).send(payload);
  expect(first.status).toBe(201);
  const revised = await reviseForm(saved.form);
  await updateForm(revised.form, { active: false });
  const retry = await request(app).post(documentUrl(savedChild.id)).send(payload);
  expect(retry.status).toBe(201);
  expect(retry.body).toMatchObject({ replayed: true, document: { id: first.body.document.id }, revision: { id: first.body.revision.id } });
  expect((await request(app).get(documentUrl(savedChild.id))).body.total).toBe(1);
});

test('legacy unmapped upload retries retain the pre-registration request hash, including explicit null mappings', async () => {
  const savedChild = await child();
  const values = { title: 'Synthetic legacy upload', category: 'consent', documentDate: null, notes: '' };
  const payload = { requestId: randomUUID(), ...values, file: file() };
  const first = await request(app).post(documentUrl(savedChild.id)).send(payload);
  expect(first.status).toBe(201);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = hash([request.credentials().account.id, savedChild.id, 'create']);
  const stored = await db.getChildDocumentRevisionByRequest(scope, payload.requestId);
  // Model a record saved before mapping fields existed. Adding null mapping
  // keys to this old hash would reject a valid lost-response retry.
  const legacy = { ...stored, requestHash: hash([values, file().name, file().contentType, digest(fixtures.pdf)]) };
  const lookup = jest.spyOn(db, 'getChildDocumentRevisionByRequest').mockResolvedValueOnce(legacy);
  try {
    const retry = await request(app).post(documentUrl(savedChild.id)).send({ ...payload, registrationFormId: null, registrationFormRevisionId: null });
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ replayed: true, document: { id: first.body.document.id }, revision: { id: first.body.revision.id } });
    expect((await request(app).get(documentUrl(savedChild.id))).body.total).toBe(1);
    expect((await auditEvents()).filter(event => event.action === 'child_document.upload')).toHaveLength(1);
  } finally { lookup.mockRestore(); }
});

test('editing metadata with an unchanged outdated or archived form pin preserves the original review snapshot', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  const approved = await review(savedChild.id, returned.document);
  const revised = await reviseForm(saved.form);
  let document = await editDocument(savedChild.id, approved, { notes: 'Synthetic correction to notes.',
    registrationFormId: saved.form.id, registrationFormRevisionId: saved.revision.id });
  expect(document).toMatchObject({ notes: 'Synthetic correction to notes.', registrationFormRevisionId: saved.revision.id,
    reviewedRevisionId: approved.reviewedRevisionId, reviewedBy: approved.reviewedBy, reviewedAt: approved.reviewedAt });
  expect(itemFor(await checklist(savedChild.id), saved.form.id).status).toBe('outdated');
  await updateForm(revised.form, { active: false });
  document = await editDocument(savedChild.id, document, { title: 'Synthetic archived return notes',
    registrationFormId: saved.form.id, registrationFormRevisionId: saved.revision.id });
  expect(document).toMatchObject({ title: 'Synthetic archived return notes', registrationFormRevisionId: saved.revision.id,
    reviewedRevisionId: approved.reviewedRevisionId, reviewedBy: approved.reviewedBy, reviewedAt: approved.reviewedAt });
  expect((await checklist(savedChild.id)).items).toEqual([]);
});

test('review uses optimistic versions and cannot cross a child or file boundary', async () => {
  const firstChild = await child();
  const secondChild = await child();
  const first = await createForm();
  const second = await createForm({ title: 'Synthetic second template' });
  const returned = await upload(firstChild.id, first.form);
  const approved = await review(firstChild.id, returned.document);
  const stale = await request(app).put(documentUrl(firstChild.id, approved.id) + '/review').send({ version: returned.document.version, reviewed: false });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('DOCUMENT_CONFLICT');
  const foreignReview = await request(app).put(documentUrl(secondChild.id, approved.id) + '/review').send({ version: approved.version, reviewed: false });
  expect(foreignReview.status).toBe(404);
  const foreignRead = await request(app).get(documentUrl(secondChild.id, approved.id));
  expect(foreignRead.status).toBe(404);
  const foreignTemplate = await request(app).get(contentUrl(first.form.id, second.revision.id));
  expect(foreignTemplate.status).toBe(404);
  expect((await request(app).get(formUrl(randomUUID()))).status).toBe(404);
  for (const payload of [{ version: approved.version, reviewed: 'yes' }, { version: approved.version, reviewed: true, revisionId: returned.revision.id }]) {
    expect((await request(app).put(documentUrl(firstChild.id, approved.id) + '/review').send(payload)).status).toBe(400);
  }
  expect(itemFor(await checklist(firstChild.id), first.form.id).status).toBe('complete');
  expect(itemFor(await checklist(secondChild.id), first.form.id).status).toBe('missing');
});

test('only administrators access templates and checklists, including when older grants exist', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  for (const [role, access] of [['editor', 'view'], ['viewer', 'view'], ['editor', 'edit']]) {
    const user = await actor(role, access);
    for (const url of [formUrl(), formUrl(saved.form.id), contentUrl(saved.form.id, saved.revision.id), documentUrl(savedChild.id) + '/checklist']) {
      expect((await api(user, 'get', url)).status).toBe(403);
    }
    expect((await api(user, 'post', formUrl(), formPayload())).status).toBe(403);
    expect((await api(user, 'put', formUrl(saved.form.id), formEdit(saved.form))).status).toBe(403);
    expect((await api(user, 'post', formUrl(saved.form.id) + '/revisions', { requestId: randomUUID(), version: 1, file: file() })).status).toBe(403);
    expect((await api(user, 'put', documentUrl(savedChild.id, returned.document.id) + '/review', { version: 1, reviewed: true })).status).toBe(403);
  }
  const denied = await actor('editor', 'none');
  for (const url of [formUrl(), formUrl(saved.form.id), contentUrl(saved.form.id, saved.revision.id), documentUrl(savedChild.id) + '/checklist']) {
    expect((await api(denied, 'get', url)).status).toBe(403);
    expect((await anonymous(app).get(url)).status).toBe(401);
  }
});

test('revoking document access invalidates old checklist and template-content sessions', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const user = await actor('admin', 'view');
  expect((await api(user, 'get', documentUrl(savedChild.id) + '/checklist')).status).toBe(200);
  const response = await request(app).put('/api/admin/accounts/' + user.account.id).send({ displayName: user.account.displayName,
    role: 'editor', disabled: false, documentAccess: 'none' });
  expect(response.status).toBe(200);
  for (const url of [documentUrl(savedChild.id) + '/checklist', contentUrl(saved.form.id, saved.revision.id)]) {
    expect((await api(user, 'get', url)).status).toBe(401);
  }
  const revoked = await signIn(user.account.username);
  expect((await api(revoked, 'get', contentUrl(saved.form.id, saved.revision.id))).status).toBe(403);
});

test('a queued review rechecks document permission after a revocation commits', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  const { account } = request.credentials();
  let release, entered, waiting;
  const reachedLock = new Promise(resolve => { entered = resolve; });
  const writeWaiting = new Promise(resolve => { waiting = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = db.withAuthLock(async () => { entered(); await gate; await db.updateAccount(account.id, { role: 'editor', documentAccess: 'none' }); });
  await reachedLock;
  const originalLock = db.withAuthLock;
  const spy = jest.spyOn(db, 'withAuthLock').mockImplementation(callback => { waiting(); return originalLock(callback); });
  let timer;
  try {
    const pending = request(app).put(documentUrl(savedChild.id, returned.document.id) + '/review').send({ version: 1, reviewed: true }).then(response => response);
    await Promise.race([writeWaiting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Review never reached its write lock.')), 10000); })]);
    release();
    await blocker;
    expect((await pending).status).toBe(403);
    await db.updateAccount(account.id, { role: 'admin', documentAccess: 'none' });
    const detail = await request(app).get(documentUrl(savedChild.id, returned.document.id));
    expect(detail.body.document).toMatchObject({ version: 1, reviewedRevisionId: null });
  } finally { clearTimeout(timer); release(); await blocker; spy.mockRestore(); }
});

test('template and review audit records contain the actor without file bytes or private instructions', async () => {
  const savedChild = await child();
  const saved = await createForm();
  const returned = await upload(savedChild.id, saved.form);
  const approved = await review(savedChild.id, returned.document);
  await review(savedChild.id, approved, false);
  const events = await auditEvents();
  expect(events).toHaveLength(4);
  expect(events.every(event => event.actorId === request.credentials().account.id && event.actorUsername === 'test-admin')).toBe(true);
  expect(events.some(event => event.entityId === saved.form.id)).toBe(true);
  expect(events.filter(event => event.entityId === approved.id)).toHaveLength(3);
  expect(JSON.stringify(events)).not.toMatch(/Complete this fictional form|Synthetic returned form|dataBase64|sha256|reviewedAt/);
});

test.each(['create', 'revision', 'review'])('audit failure rolls back registration %s atomically', async operation => {
  const savedChild = await child();
  const saved = operation === 'create' ? null : await createForm();
  const returned = operation === 'review' ? await upload(savedChild.id, saved.form) : null;
  const before = await auditEvents();
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic private template detail'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = operation === 'create' ? await request(app).post(formUrl()).send(formPayload()) : operation === 'revision' ?
      await request(app).post(formUrl(saved.form.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') }) :
      await request(app).put(documentUrl(savedChild.id, returned.document.id) + '/review').send({ version: 1, reviewed: true });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic private template detail');
    expect(await auditEvents()).toEqual(before);
    if (operation === 'create') expect((await request(app).get(formUrl())).body.items).toEqual([]);
    else expect(await formDetails(saved.form.id)).toMatchObject({ form: saved.form, total: 1 });
    if (operation === 'review') {
      const detail = await request(app).get(documentUrl(savedChild.id, returned.document.id));
      expect(detail.body.document).toMatchObject({ version: 1, reviewedRevisionId: null, reviewedAt: null });
      expect((await checklist(savedChild.id)).complete).toBe(false);
    }
  } finally { audit.mockRestore(); log.mockRestore(); }
});


test('only child templates affect enrollment and a reviewed packet reaches 100 percent', async () => {
  const record = await child();
  const childForm = (await createForm({ audience: 'child' })).form;
  const employeeForm = (await createForm({ audience: 'employee', title: 'Employee contract' })).form;
  await createForm({ audience: 'facility', title: 'Facility license' });
  const checklist = await request(app).get(documentUrl(record.id) + '/checklist');
  expect(checklist.body.items.map(item => item.form.id)).toEqual([childForm.id]);
  expect(checklist.body).toMatchObject({ complete: false, requiredTotal: 1, percentage: 75 });
  const rejected = await request(app).post(documentUrl(record.id)).send({ requestId: randomUUID(), title: 'Wrong group', category: 'contract', file: file(), registrationFormId: employeeForm.id, registrationFormRevisionId: employeeForm.currentRevisionId });
  expect(rejected.status).toBe(409);
  const copy = await upload(record.id, childForm);
  expect((await request(app).get('/api/children/' + record.id + '/enrollment-progress')).body).toEqual({ complete: false, percentage: 75 });
  await review(record.id, copy.document);
  expect((await request(app).get('/api/children/' + record.id + '/enrollment-progress')).body).toEqual({ complete: true, percentage: 100 });
  await db.updateChild(record.id, { dateOfBirth: null });
  expect((await request(app).get(documentUrl(record.id) + '/checklist')).body).toMatchObject({ complete: false, percentage: 75, missingBasicInfo: ['Date of birth'] });
  const moved = await request(app).put(formUrl(childForm.id)).send(formEdit(childForm, { audience: 'facility' }));
  expect(moved.status).toBe(400);
});

test('editors save basic information and see only coarse progress; read-only users cannot request it', async () => {
  const template = (await createForm({ audience: 'child', title: 'Private medical history' })).form;
  for (const role of ['editor', 'viewer']) {
    const administrator = request.credentials().account;
    const account = await db.createAccount({ id: randomUUID(), username: 'progress-' + randomUUID().slice(0, 8), displayName: 'Synthetic user', passwordHash: administrator.passwordHash, role, disabled: false, mustChangePassword: false });
    const login = await anonymous(app).post('/api/auth/login').set('Origin', request.origin).send({ username: account.username, password: request.password });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const basic = await anonymous(app).post('/api/children').set('Origin', request.origin).set('Cookie', cookie).set('X-CSRF-Token', login.body.csrfToken).send({ firstName: 'Basic', lastName: randomUUID(), dateOfBirth: '2023-01-01' });
    if (role === 'viewer') { expect(basic.status).toBe(403); }
    const record = role === 'editor' ? basic.body : await child();
    if (role === 'editor') expect(basic.status).toBe(201);
    const result = await anonymous(app).get('/api/children/' + record.id + '/enrollment-progress').set('Cookie', cookie);
    expect(result.status).toBe(role === 'editor' ? 200 : 403);
    if (role === 'editor') {
      expect(result.body).toEqual({ complete: false, percentage: 75 });
      expect(JSON.stringify(result.body)).not.toContain(template.title);
      expect((await anonymous(app).get(documentUrl(record.id) + '/checklist').set('Cookie', cookie)).status).toBe(403);
    }
  }
});

test('invalid groups are rejected and a facility-only catalog cannot declare a child complete', async () => {
  expect((await request(app).post(formUrl()).send(formPayload({ audience: 'unknown' }))).status).toBe(400);
  await createForm({ audience: 'facility' });
  const record = await child();
  expect((await request(app).get(documentUrl(record.id) + '/checklist')).body).toMatchObject({ items: [], complete: false, percentage: 0 });
});

test('an employee training requirement can exist without a fake blank file and gains its first real version later', async () => {
  const saved = await createForm({ audience: 'employee', title: 'Synthetic CPR certificate', expirationRequired: true, file: undefined });
  expect(saved).toMatchObject({ revision: null, replayed: false, form: { audience: 'employee', expirationRequired: true, currentRevisionId: null, templateRevision: 0 } });
  expect(await formDetails(saved.form.id)).toEqual({ form: saved.form, revisions: [], total: 0 });
  expect((await request(app).get(formUrl())).body.items).toEqual([saved.form]);
  const basic = await child();
  expect((await checklist(basic.id)).items).toEqual([]);
  const revised = await reviseForm(saved.form);
  expect(revised).toMatchObject({ form: { expirationRequired: true, version: 2, templateRevision: 1, currentRevisionId: revised.revision.id }, revision: { revision: 1 } });
  expect((await formDetails(saved.form.id)).total).toBe(1);
  expect((await binary(contentUrl(saved.form.id, revised.revision.id))).body).toEqual(fixtures.png);
});

test.each(['child', 'facility'])('%s templates still require blank files and cannot require employee expiration dates', async audience => {
  for (const changes of [{ file: undefined }, { expirationRequired: true }, { file: undefined, expirationRequired: true }]) {
    const response = await request(app).post(formUrl()).send(formPayload({ audience, ...changes }));
    expect(response.status).toBe(400);
  }
  const saved = await createForm({ audience, expirationRequired: false });
  expect(saved.form.expirationRequired).toBe(false);
  expect((await request(app).put(formUrl(saved.form.id)).send(formEdit(saved.form, { expirationRequired: true }))).status).toBe(400);
  expect((await formDetails(saved.form.id)).form).toEqual(saved.form);
});

test.each([null, 0, 1, 'true', 'false', [], {}])('expiration policy must be an actual boolean (%p)', async expirationRequired => {
  expect((await request(app).post(formUrl()).send(formPayload({ audience: 'employee', expirationRequired, file: undefined }))).status).toBe(400);
  const saved = await createForm({ audience: 'employee', file: undefined });
  expect((await request(app).put(formUrl(saved.form.id)).send(formEdit(saved.form, { expirationRequired }))).status).toBe(400);
  expect((await formDetails(saved.form.id)).form.expirationRequired).toBe(false);
});

test('omitted expiration policy defaults to false at creation and preserves the saved policy on edit', async () => {
  const saved = await createForm({ audience: 'employee', file: undefined });
  expect(saved.form.expirationRequired).toBe(false);
  const changed = await updateForm(saved.form, { expirationRequired: true });
  expect(changed.expirationRequired).toBe(true);
  const unchanged = await updateForm(changed, { instructions: 'Synthetic renewal reminder' });
  expect(unchanged.expirationRequired).toBe(true);
  const cleared = await updateForm(unchanged, { expirationRequired: false });
  expect(cleared.expirationRequired).toBe(false);
});

test('metadata-only employee creation retries are scoped, idempotent and reject conflicting or changed requests', async () => {
  const payload = formPayload({ audience: 'employee', expirationRequired: true, file: undefined });
  const [first, simultaneous] = await Promise.all([request(app).post(formUrl()).send(payload), request(app).post(formUrl()).send(payload)]);
  expect(first.status).toBe(201); expect(simultaneous.status).toBe(201);
  expect(first.body.form.id).toBe(simultaneous.body.form.id);
  expect([first.body.replayed, simultaneous.body.replayed].sort()).toEqual([false, true]);
  expect(await auditEvents()).toHaveLength(1);
  expect((await request(app).post(formUrl()).send({ ...payload, title: 'Different certificate' })).status).toBe(409);
  expect((await request(app).post(formUrl()).send({ ...payload, file: file() })).status).toBe(409);
  const secondAdmin = await actor('admin', 'none');
  const other = await api(secondAdmin, 'post', formUrl(), payload);
  expect(other.status).toBe(201); expect(other.body.form.id).not.toBe(first.body.form.id);
  await updateForm(first.body.form, { instructions: 'Changed after initial save' });
  expect((await request(app).post(formUrl()).send(payload)).status).toBe(409);
  expect((await request(app).get(formUrl())).body.items).toHaveLength(2);
});

test('a file creation request cannot be reused for a metadata-only requirement', async () => {
  const payload = formPayload({ audience: 'employee' });
  expect((await request(app).post(formUrl()).send(payload)).status).toBe(201);
  const { file: _file, ...noFile } = payload;
  expect((await request(app).post(formUrl()).send(noFile)).status).toBe(409);
  expect((await request(app).get(formUrl())).body.items).toHaveLength(1);
});

test('legacy file upload replay retains the pre-expiration metadata hash', async () => {
  const payload = formPayload({ audience: 'employee' });
  const first = await request(app).post(formUrl()).send(payload);
  expect(first.status).toBe(201);
  const scope = createHash('sha256').update(JSON.stringify([request.credentials().account.id, 'registration-form-create'])).digest('hex');
  const old = await db.getRegistrationFormRevisionByRequest(scope, payload.requestId);
  const oldValues = { ...metadata, audience: 'employee' };
  // Match field insertion order used by the pre-expiration service.
  const legacyValues = { title: oldValues.title, audience: oldValues.audience, instructions: oldValues.instructions, category: oldValues.category, required: oldValues.required };
  const legacyHash = createHash('sha256').update(JSON.stringify([legacyValues, file().name, file().contentType, digest(fixtures.pdf)])).digest('hex');
  expect(old.requestHash).toBe(legacyHash);
  const retry = await request(app).post(formUrl()).send(payload);
  expect(retry.status).toBe(201); expect(retry.body.replayed).toBe(true); expect(retry.body.revision.id).toBe(first.body.revision.id);
});

test('metadata-only requirement creation obeys catalog limits and audit rollback without storing partial requirements', async () => {
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic private requirement detail'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await request(app).post(formUrl()).send(formPayload({ audience: 'employee', file: undefined }))).status).toBe(500);
    expect((await request(app).get(formUrl())).body.items).toEqual([]);
    expect(await auditEvents()).toEqual([]);
  } finally { audit.mockRestore(); log.mockRestore(); }
  const count = jest.spyOn(db, 'countRegistrationForms').mockResolvedValueOnce(100);
  try {
    const limited = await request(app).post(formUrl()).send(formPayload({ audience: 'employee', file: undefined }));
    expect(limited.status).toBe(409); expect(limited.body.error.code).toBe('REGISTRATION_FORM_LIMIT');
    expect((await request(app).get(formUrl())).body.items).toEqual([]);
  } finally { count.mockRestore(); }
});

test('employee requirements remain administrator-only including metadata-only creation', async () => {
  const saved = await createForm({ audience: 'employee', expirationRequired: true, file: undefined });
  for (const role of ['editor', 'viewer']) {
    const credentials = await actor(role, 'edit');
    expect((await api(credentials, 'get', formUrl(saved.form.id))).status).toBe(403);
    expect((await api(credentials, 'post', formUrl(), formPayload({ audience: 'employee', file: undefined }))).status).toBe(403);
  }
});
