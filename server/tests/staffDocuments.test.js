const anonymous = require('supertest');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const service = require('../services/staffDocumentsService');
const time = require('../services/facilityTime');

const fixtures = Object.fromEntries(['pdf', 'png', 'jpg'].map(extension => [extension,
  readFileSync(path.join(__dirname, 'fixtures/child-documents', 'synthetic.' + extension))]));
const file = (extension = 'pdf') => ({ name: 'synthetic.' + extension,
  contentType: { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' }[extension], dataBase64: fixtures[extension].toString('base64') });
const metadata = { title: 'Synthetic CPR certificate', category: 'other', documentDate: '2026-10-01',
  notes: 'Sensitive certificate notes', issuer: 'Synthetic Training Center', reference: 'Private-reference', issuedOn: '2026-01-01',
  expiresOn: '2026-11-18', nonExpiring: false, warningDays: null };
const upload = (changes = {}) => ({ requestId: randomUUID(), ...metadata, file: file(), ...changes });
const url = (staffId, documentId) => '/api/staff/' + staffId + '/documents' + (documentId ? '/' + documentId : '');
const binary = (staffId, documentId, revisionId) => request(app).get(url(staffId, documentId) + '/revisions/' + revisionId + '/content')
  .buffer(true).parse((response, done) => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => done(null, Buffer.concat(chunks)));
  });
let dateSpy;
beforeEach(() => { dateSpy = jest.spyOn(time, 'dateAt').mockReturnValue('2026-10-09'); });
afterEach(() => { dateSpy.mockRestore(); });
async function employee(values = {}) {
  const response = await request(app).post('/api/staff').send({ name: 'Synthetic Teacher', role: 'Teacher', active: true, roomId: null, ...values });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function requirement(values = {}, withFile = true) {
  const response = await request(app).post('/api/registration-forms').send({ requestId: randomUUID(), title: 'CPR training',
    instructions: 'Renew before expiration', category: 'other', audience: 'employee', required: true, expirationRequired: true,
    ...(withFile ? { file: file() } : {}), ...values });
  expect(response.status).toBe(201);
  return response.body.form;
}
async function create(person, form, values = {}) {
  const response = await request(app).post(url(person.id)).send(upload({
    ...(form ? { registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId } : {}), ...values }));
  expect(response.status).toBe(201);
  return response.body;
}
async function review(person, document, reviewed = true) {
  const response = await request(app).put(url(person.id, document.id) + '/review').send({ version: document.version, reviewed });
  expect(response.status).toBe(200);
  return response.body.document;
}
const checklist = async person => (await request(app).get(url(person.id) + '/checklist')).body;
const reminders = async () => {
  const response = await request(app).get('/api/staff-compliance'); expect(response.status).toBe(200); return response.body;
};

test.each(['pdf', 'png', 'jpg'])('employee %s documents remain private and preserve the original file bytes', async extension => {
  const person = await employee(); const form = await requirement();
  const saved = await create(person, form, { file: file(extension) });
  expect(saved.document).toMatchObject({ staffId: person.id, ...metadata, version: 1, reviewedRevisionId: null });
  expect(saved.revision).toMatchObject({ revision: 1, filename: 'synthetic.' + extension, expiresOn: metadata.expiresOn,
    issuedOn: metadata.issuedOn, issuer: metadata.issuer, reference: metadata.reference, current: true });
  const download = await binary(person.id, saved.document.id, saved.revision.id);
  expect(download.status).toBe(200); expect(download.body).toEqual(fixtures[extension]);
  expect(download.headers['cache-control']).toContain('no-store');
  expect(download.headers['x-content-type-options']).toBe('nosniff');
  expect(download.headers['content-security-policy']).toContain('sandbox');
  const listing = await request(app).get(url(person.id));
  expect(listing.status).toBe(200); expect(listing.body.total).toBe(1);
  const serialized = JSON.stringify(listing.body);
  expect(serialized).not.toMatch(/dataBase64|requestHash|requestScope|"content"/);
  expect(serialized).not.toContain(fixtures[extension].toString('base64'));
});

test('an empty required catalog stays unconfigured, and child, facility, optional and archived forms do not require employee uploads', async () => {
  const person = await employee();
  expect(await checklist(person)).toMatchObject({ requiredTotal: 0, complete: false, percentage: 0 });
  expect(await reminders()).toMatchObject({ configured: false, items: [], requiredTotal: 0 });
  await requirement({ title: 'Child consent', audience: 'child', expirationRequired: false });
  await requirement({ title: 'Facility plan', audience: 'facility', expirationRequired: false });
  await requirement({ title: 'Optional qualification', required: false, expirationRequired: false });
  const archived = await requirement({ title: 'Archived qualification' });
  expect((await request(app).put('/api/registration-forms/' + archived.id).send({ ...archived,
    title: archived.title, instructions: '', category: 'other', audience: 'employee', required: true, expirationRequired: true,
    active: false, version: archived.version, id: undefined, currentRevisionId: undefined, templateRevision: undefined, updatedAt: undefined })).status).toBe(200);
  const result = await checklist(person);
  expect(result.requiredTotal).toBe(0); expect(result.complete).toBe(false); expect(result.items).toHaveLength(1);
  expect(result.items[0].form.required).toBe(false); expect((await reminders()).items).toEqual([]);
});

test('required submissions need review; current reviewed forms alone determine completion', async () => {
  const person = await employee(); const form = await requirement();
  expect((await checklist(person)).items[0].status).toBe('missing');
  const saved = await create(person, form, { expiresOn: '2027-01-01' });
  expect(await checklist(person)).toMatchObject({ complete: false, percentage: 0, items: [expect.objectContaining({ status: 'needs_review' })] });
  const accepted = await review(person, saved.document);
  expect(await checklist(person)).toMatchObject({ complete: true, percentage: 100, requiredComplete: 1 });
  expect((await reminders()).items).toEqual([]);
  await review(person, accepted, false);
  expect((await checklist(person)).complete).toBe(false);
});

test.each([
  ['2026-11-19', 'complete', 41], ['2026-11-18', 'expiring', 40], ['2026-10-09', 'expiring', 0], ['2026-10-08', 'expired', -1],
])('expiration %s yields %s at its calendar boundary', async (expiresOn, status, daysRemaining) => {
  const person = await employee(); const form = await requirement();
  const saved = await create(person, form, { expiresOn }); await review(person, saved.document);
  const result = await checklist(person);
  expect(result.items[0]).toMatchObject({ status, daysRemaining, warningDays: 40,
    nextReminderDate: time.addDays(expiresOn, -40) });
  expect(result.complete).toBe(status !== 'expired');
  expect((await reminders()).items).toHaveLength(status === 'complete' ? 0 : 1);
});

test('expiration uses facility dates across midnight and daylight-saving days, without requiring a worker or a restart', async () => {
  const person = await employee(); const form = await requirement();
  const saved = await create(person, form, { expiresOn: '2026-11-01', issuedOn: null }); await review(person, saved.document);
  dateSpy.mockRestore();
  const original = time.dateAt;
  dateSpy = jest.spyOn(time, 'dateAt').mockImplementation(() => original('2026-11-02T07:59:59Z', 'America/Los_Angeles'));
  expect((await reminders()).items[0]).toMatchObject({ status: 'expiring', daysRemaining: 0 });
  dateSpy.mockImplementation(() => original('2026-11-02T08:00:00Z', 'America/Los_Angeles'));
  expect((await reminders()).items[0]).toMatchObject({ status: 'expired', daysRemaining: -1 });
  expect((await reminders()).today).toBe('2026-11-02');
});

test('facility reminders and certificate overrides update immediately, survive reads, and reject stale settings', async () => {
  const person = await employee(); const form = await requirement();
  const first = await create(person, form, { expiresOn: '2026-11-13' }); await review(person, first.document);
  expect((await reminders()).items[0].status).toBe('expiring');
  expect((await request(app).get('/api/staff-compliance/settings')).body).toEqual({ warningDays: 40, version: 1 });
  expect((await request(app).put('/api/staff-compliance/settings').send({ warningDays: 30, version: 1 })).body).toEqual({ warningDays: 30, version: 2 });
  expect((await reminders()).items).toEqual([]);
  expect((await request(app).put('/api/staff-compliance/settings').send({ warningDays: 365, version: 1 })).status).toBe(409);
  const corrected = await request(app).put(url(person.id, first.document.id)).send({ ...metadata, expiresOn: '2026-11-13',
    warningDays: 40, version: 2 });
  expect(corrected.status).toBe(200); await review(person, corrected.body.document);
  expect((await reminders()).items[0]).toMatchObject({ status: 'expiring', warningDays: 40, nextReminderDate: '2026-10-04' });
  expect((await db.getStaffDocumentSettings()).warningDays).toBe(30);
  for (const warningDays of [0, 366, 1.5, '40', null]) {
    expect((await request(app).put('/api/staff-compliance/settings').send({ warningDays, version: 2 })).status).toBe(400);
  }
});

test('date corrections append original-byte revisions, clear review, and preserve previous dates and filenames', async () => {
  const person = await employee(); const form = await requirement();
  const saved = await create(person, form); const accepted = await review(person, saved.document);
  const response = await request(app).put(url(person.id, saved.document.id)).send({ ...metadata, issuedOn: '2026-02-01',
    expiresOn: '2027-02-01', version: accepted.version });
  expect(response.status).toBe(200); expect(response.body.document).toMatchObject({ reviewedRevisionId: null, expiresOn: '2027-02-01', version: 3 });
  const detail = await request(app).get(url(person.id, saved.document.id));
  expect(detail.body.total).toBe(2);
  expect(detail.body.revisions[0]).toMatchObject({ revision: 2, issuedOn: '2026-02-01', expiresOn: '2027-02-01', current: true });
  expect(detail.body.revisions[1]).toMatchObject({ revision: 1, issuedOn: metadata.issuedOn, expiresOn: metadata.expiresOn, current: false });
  for (const revision of detail.body.revisions) expect((await binary(person.id, saved.document.id, revision.id)).body).toEqual(fixtures.pdf);
  expect((await checklist(person)).items[0].status).toBe('needs_review');
  expect((await request(app).put(url(person.id, saved.document.id)).send({ ...metadata, version: accepted.version })).status).toBe(409);
});

test('renewal replaces only the current certificate, retains historical bytes and dates, and clears its alert after review', async () => {
  const person = await employee(); const form = await requirement();
  const saved = await create(person, form, { expiresOn: '2026-10-08' }); const accepted = await review(person, saved.document);
  const payload = { requestId: randomUUID(), version: accepted.version, changeNote: 'Synthetic renewal',
    file: file('png'), issuedOn: '2026-10-09', expiresOn: '2027-10-09', nonExpiring: false };
  const renewal = await request(app).post(url(person.id, saved.document.id) + '/revisions').send(payload);
  expect(renewal.status).toBe(201); expect(renewal.body.document).toMatchObject({ id: saved.document.id, reviewedRevisionId: null, expiresOn: '2027-10-09' });
  expect((await checklist(person)).items[0].status).toBe('needs_review');
  const replay = await request(app).post(url(person.id, saved.document.id) + '/revisions').send(payload);
  expect(replay.status).toBe(201); expect(replay.body.replayed).toBe(true);
  expect((await binary(person.id, saved.document.id, saved.revision.id)).body).toEqual(fixtures.pdf);
  expect((await binary(person.id, saved.document.id, renewal.body.revision.id)).body).toEqual(fixtures.png);
  await review(person, renewal.body.document);
  expect((await reminders()).items).toEqual([]);
  const corrected = await request(app).put(url(person.id, saved.document.id)).send({ ...metadata,
    issuedOn: '2026-10-10', expiresOn: '2027-10-10', version: renewal.body.document.version + 1 });
  expect(corrected.status).toBe(200);
  const laterReplay = await request(app).post(url(person.id, saved.document.id) + '/revisions').send(payload);
  expect(laterReplay.status).toBe(201); expect(laterReplay.body.replayed).toBe(true);
  expect(laterReplay.body.revision.id).toBe(renewal.body.revision.id);
  expect(laterReplay.body.document.expiresOn).toBe('2027-10-10');
});

test('non-expiring qualifications require an explicit choice and expiring requirements cannot bypass dates', async () => {
  const person = await employee(); const permanent = await requirement({ title: 'Employment agreement', expirationRequired: false });
  const saved = await create(person, permanent, { expiresOn: null, nonExpiring: false });
  expect((await checklist(person)).items[0].status).toBe('expiry_missing');
  expect((await request(app).put(url(person.id, saved.document.id) + '/review').send({ version: saved.document.version, reviewed: true })).status).toBe(400);
  const correction = await request(app).put(url(person.id, saved.document.id)).send({ ...metadata, expiresOn: null, nonExpiring: true, version: saved.document.version });
  expect(correction.status).toBe(200); await review(person, correction.body.document);
  expect((await checklist(person)).items[0]).toMatchObject({ status: 'complete', daysRemaining: null, nextReminderDate: null });
  const expiring = await requirement({ title: 'CPR certificate' });
  const bypass = await create(person, expiring, { expiresOn: null, nonExpiring: true });
  expect((await request(app).put(url(person.id, bypass.document.id) + '/review').send({ version: bypass.document.version, reviewed: true })).status).toBe(400);
  expect((await reminders()).items[0].status).toBe('expiry_missing');
});

test.each([
  { expiresOn: '2026-02-30' }, { issuedOn: '2025-02-29' }, { expiresOn: '2025-12-31', issuedOn: '2026-01-01' },
  { expiresOn: '10/09/2026' }, { nonExpiring: true }, { nonExpiring: 'true' }, { warningDays: 0 }, { warningDays: 366 },
])('invalid certificate details reject without partial records: %j', async changes => {
  const person = await employee();
  expect((await request(app).post(url(person.id)).send(upload(changes))).status).toBe(400);
  expect(await db.countStaffDocuments(person.id)).toBe(0);
});

test('upload retries are idempotent, while changed retries, stale and simultaneous edits cannot overwrite history', async () => {
  const person = await employee(); const form = await requirement();
  const payload = upload({ registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId });
  const original = await request(app).post(url(person.id)).send(payload);
  const replay = await request(app).post(url(person.id)).send(payload);
  expect(replay.status).toBe(201); expect(replay.body.document.id).toBe(original.body.document.id); expect(replay.body.replayed).toBe(true);
  expect((await request(app).post(url(person.id)).send({ ...payload, expiresOn: '2027-01-01' })).status).toBe(409);
  const updates = await Promise.all(['2027-01-01', '2027-02-01'].map(expiresOn =>
    request(app).put(url(person.id, original.body.document.id)).send({ ...metadata, expiresOn, version: 1 })));
  expect(updates.map(response => response.status).sort()).toEqual([200, 409]);
  expect(await db.countStaffDocumentRevisions(original.body.document.id)).toBe(2);
});

test('a new requirement version makes old submissions outdated until assigned, reviewed and complete again', async () => {
  const person = await employee(); const form = await requirement();
  const saved = await create(person, form, { expiresOn: '2027-10-09' }); const accepted = await review(person, saved.document);
  const revised = await request(app).post('/api/registration-forms/' + form.id + '/revisions').send({ requestId: randomUUID(),
    version: form.version, changeNote: 'Updated requirement', file: file('png') });
  expect(revised.status).toBe(201); expect((await checklist(person)).items[0].status).toBe('outdated');
  expect((await request(app).put(url(person.id, saved.document.id) + '/review').send({ version: accepted.version, reviewed: true })).status).toBe(409);
  const assigned = await request(app).put(url(person.id, saved.document.id)).send({ ...metadata, expiresOn: '2027-10-09',
    version: accepted.version, registrationFormId: form.id, registrationFormRevisionId: revised.body.form.currentRevisionId });
  expect(assigned.status).toBe(200); await review(person, assigned.body.document);
  expect((await checklist(person)).complete).toBe(true);
});

test('metadata-only employee requirements accept a certificate without inventing a blank template', async () => {
  const person = await employee(); const form = await requirement({}, false);
  expect(form.currentRevisionId).toBeNull(); expect(form.templateRevision).toBe(0);
  const saved = await create(person, form, { expiresOn: '2027-10-09' }); await review(person, saved.document);
  expect((await checklist(person)).complete).toBe(true);
});

test('inactive staff keep private document history but no longer trigger reminders, and reactivation catches up immediately', async () => {
  const person = await employee(); const form = await requirement(); const saved = await create(person, form);
  await review(person, saved.document); expect((await reminders()).items).toHaveLength(1);
  const inactive = await request(app).put('/api/staff/' + person.id).send({ version: person.version, active: false });
  expect(inactive.status).toBe(200); expect((await reminders()).items).toEqual([]);
  expect((await binary(person.id, saved.document.id, saved.revision.id)).body).toEqual(fixtures.pdf);
  expect((await request(app).put('/api/staff/' + person.id).send({ version: inactive.body.data.version, active: true })).status).toBe(200);
  expect((await reminders()).items).toHaveLength(1);
});

test('required catalog changes apply immediately and a duplicate awaiting review cannot erase an accepted valid submission', async () => {
  const person = await employee(); const form = await requirement();
  const first = await create(person, form, { expiresOn: '2027-10-09' }); await review(person, first.document);
  await create(person, form, { expiresOn: '2026-10-08' });
  expect((await checklist(person)).complete).toBe(true);
  const second = await requirement({ title: 'Health screening', expirationRequired: false });
  expect((await checklist(person)).requiredTotal).toBe(2);
  expect((await reminders()).items[0]).toMatchObject({ requirementId: second.id, status: 'missing' });
  expect((await request(app).put('/api/registration-forms/' + second.id).send({ title: second.title, instructions: '', category: second.category,
    audience: 'employee', required: true, expirationRequired: false, active: false, version: second.version })).status).toBe(200);
  expect((await checklist(person)).complete).toBe(true);
});

test('failed file, revision or audit writes leave no partial record, revision, date update or reminder settings', async () => {
  const person = await employee(); const form = await requirement();
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const fail = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  expect((await request(app).post(url(person.id)).send(upload({ registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId }))).status).toBe(500);
  fail.mockRestore(); expect(await db.countStaffDocuments(person.id)).toBe(0);
  const saved = await create(person, form);
  const revisionFail = jest.spyOn(db, 'createStaffDocumentRevision').mockRejectedValueOnce(new Error('Synthetic revision failure'));
  expect((await request(app).put(url(person.id, saved.document.id)).send({ ...metadata, expiresOn: '2027-01-01', version: 1 })).status).toBe(500);
  revisionFail.mockRestore();
  expect(await db.getStaffDocument(saved.document.id, person.id)).toMatchObject({ version: 1, expiresOn: metadata.expiresOn });
  expect(await db.countStaffDocumentRevisions(saved.document.id)).toBe(1);
  const settingsFail = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic settings failure'));
  expect((await request(app).put('/api/staff-compliance/settings').send({ warningDays: 30, version: 1 })).status).toBe(500);
  settingsFail.mockRestore(); log.mockRestore();
  expect(await db.getStaffDocumentSettings()).toMatchObject({ warningDays: 40, version: 1 });
});

test('employee document IDs and revisions cannot be used across another employee or a child profile', async () => {
  const person = await employee(); const other = await employee({ name: 'Another teacher' }); const form = await requirement();
  const saved = await create(person, form);
  expect((await request(app).get(url(other.id, saved.document.id))).status).toBe(404);
  expect((await binary(other.id, saved.document.id, saved.revision.id)).status).toBe(404);
  const second = await create(other, form);
  expect((await binary(person.id, saved.document.id, second.revision.id)).status).toBe(404);
  expect((await request(app).get('/api/children/' + person.id + '/documents')).status).toBe(404);
});

test('editors see minimal local reminders only, viewers and legacy grants cannot access employee files or compliance', async () => {
  const person = await employee(); const form = await requirement(); const saved = await create(person, form); await review(person, saved.document);
  expect((await anonymous(app).get('/api/staff-compliance')).status).toBe(401);
  const { account, cookie } = request.credentials();
  await db.updateAccount(account.id, { role: 'editor', documentAccess: 'edit' });
  const result = await reminders();
  expect(Object.keys(result.items[0]).sort()).toEqual(['staffId', 'employeeName', 'requirementId', 'requirementTitle', 'status',
    'expiresOn', 'daysRemaining', 'warningDays', 'nextReminderDate'].sort());
  const serialized = JSON.stringify(result);
  for (const value of [metadata.notes, metadata.issuer, metadata.reference, saved.document.id, saved.revision.id, 'synthetic.pdf', account.id]) expect(serialized).not.toContain(value);
  for (const endpoint of [url(person.id), url(person.id) + '/checklist', url(person.id, saved.document.id),
    url(person.id, saved.document.id) + '/revisions/' + saved.revision.id + '/content']) expect((await request(app).get(endpoint)).status).toBe(403);
  expect((await request(app).post(url(person.id)).send(upload())).status).toBe(403);
  expect((await request(app).put('/api/staff-compliance/settings').send({ warningDays: 30, version: 1 })).status).toBe(403);
  const read = jest.spyOn(db, 'listAllStaffDocuments');
  await expect(service.list(cookie.split('=')[1], person.id, {})).rejects.toMatchObject({ status: 403 });
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
  await db.updateAccount(account.id, { role: 'viewer', documentAccess: 'edit' });
  for (const endpoint of ['/api/staff-compliance', '/api/staff-compliance/settings', url(person.id) + '/checklist']) {
    expect((await request(app).get(endpoint)).status).toBe(403);
  }
});

test('mutations require a trusted origin and CSRF and revoked sessions cannot retrieve stored file bytes', async () => {
  const person = await employee(); const form = await requirement(); const saved = await create(person, form);
  const { cookie } = request.credentials();
  expect((await anonymous(app).post(url(person.id)).set('Cookie', cookie).set('Origin', request.origin).send(upload())).status).toBe(403);
  expect((await anonymous(app).post(url(person.id)).set('Cookie', cookie).set('Origin', 'https://untrusted.invalid').send(upload())).status).toBe(403);
  expect((await request(app).post('/api/auth/logout').send({})).status).toBe(204);
  expect((await binary(person.id, saved.document.id, saved.revision.id)).status).toBe(401);
});

test('private access has attributed audits without content or names, and failure to audit sends no file bytes', async () => {
  const person = await employee(); const form = await requirement(); const saved = await create(person, form);
  await request(app).get(url(person.id)); await request(app).get(url(person.id, saved.document.id));
  await checklist(person); await binary(person.id, saved.document.id, saved.revision.id);
  await request(app).get(url(person.id, saved.document.id) + '/revisions/' + saved.revision.id + '/content?download=1');
  const events = (await db.listAudit({ limit: 100 })).filter(event => event.action.startsWith('staff_document.'));
  for (const action of ['list', 'view', 'checklist', 'preview', 'download']) expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'staff_document.' + action, actorId: request.credentials().account.id })]));
  for (const value of [person.name, metadata.notes, metadata.issuer, metadata.reference, 'synthetic.pdf']) expect(JSON.stringify(events)).not.toContain(value);
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const failure = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic read audit failure'));
  expect((await binary(person.id, saved.document.id, saved.revision.id)).status).toBe(500);
  failure.mockRestore(); log.mockRestore();
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  const before = (await db.listAudit({ limit: 100 })).length;
  expect((await request(app).get(url(person.id, saved.document.id))).status).toBe(403);
  expect((await db.listAudit({ limit: 100 })).length).toBe(before);
});

test('bounded document and revision histories stop new writes while allowing an exact retry and current reviews', async () => {
  const person = await employee(); const form = await requirement();
  const payload = upload({ registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId });
  const created = await request(app).post(url(person.id)).send(payload); expect(created.status).toBe(201);
  const countDocuments = jest.spyOn(db, 'countStaffDocuments').mockResolvedValue(100);
  expect((await request(app).post(url(person.id)).send(upload())).status).toBe(409);
  expect((await request(app).post(url(person.id)).send(payload)).body.replayed).toBe(true);
  countDocuments.mockRestore();
  const countRevisions = jest.spyOn(db, 'countStaffDocumentRevisions').mockResolvedValue(100);
  expect((await request(app).post(url(person.id, created.body.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1,
    changeNote: '', file: file('png') })).status).toBe(409);
  expect((await request(app).put(url(person.id, created.body.document.id)).send({ ...metadata, expiresOn: '2027-01-01', version: 1 })).status).toBe(409);
  await review(person, created.body.document); countRevisions.mockRestore();
  expect(await db.countStaffDocumentRevisions(created.body.document.id)).toBe(1);
});

test('urgent deadlines appear ahead of alphabetically earlier employees with missing requirements', async () => {
  const missing = await employee({ name: 'A early employee' });
  const expiring = await employee({ name: 'Y approaching deadline' });
  const expired = await employee({ name: 'Z overdue certificate' });
  const form = await requirement();
  const due = await create(expiring, form, { expiresOn: '2026-11-18' }); await review(expiring, due.document);
  const overdue = await create(expired, form, { expiresOn: '2026-10-08' }); await review(expired, overdue.document);
  const result = await reminders();
  expect(result.items.map(item => [item.staffId, item.status])).toEqual([
    [expired.id, 'expired'], [expiring.id, 'expiring'], [missing.id, 'missing'],
  ]);
  expect(result.totals).toMatchObject({ expired: 1, expiring: 1, missing: 1 });
});
