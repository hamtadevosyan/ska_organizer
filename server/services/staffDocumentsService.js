const { createHash, randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const v = require('./childDocumentValidation');
const forms = require('./registrationFormsService');
const time = require('./facilityTime');

const MAX_DOCUMENTS = 100;
const MAX_REVISIONS = 100;

const metadataKeys = ['title', 'category', 'documentDate', 'notes', 'issuer', 'reference', 'issuedOn', 'expiresOn', 'nonExpiring', 'warningDays'];
const mappingKeys = ['registrationFormId', 'registrationFormRevisionId'];
const reviewKeys = ['reviewedRevisionId', 'reviewedBy', 'reviewedAt'];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message = 'This employee document changed elsewhere. Reload it before saving again.') =>
  auth.problem(message, 409, 'DOCUMENT_CONFLICT');
const clearReview = { reviewedRevisionId: null, reviewedBy: null, reviewedAt: null };
const summary = (row) => ({
  ...Object.fromEntries(['id', 'staffId', ...metadataKeys, 'version', 'currentRevisionId', ...mappingKeys, ...reviewKeys]
    .map((key) => [key, row[key] ?? null])),
  reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
  updatedAt: new Date(row.updatedAt).toISOString(),
});
const revisionSummary = (row, document) => ({
  ...Object.fromEntries(['id', 'revision', 'filename', 'contentType', 'byteLength', 'sha256', 'uploadedBy', 'changeNote',
    ...metadataKeys, ...mappingKeys].map((key) => [key, row[key] ?? null])),
  uploadedAt: new Date(row.uploadedAt).toISOString(), current: row.id === document.currentRevisionId,
});
const authorized = (token, privateFiles, fn) => db.withAuthLock(async () => {
  const actor = await auth.sessionAccount(token, { touch: true });
  if (privateFiles) {
    auth.operationalPermission(actor, false);
    if (actor.role !== 'admin') throw auth.problem('Administrator access is required for employee documents.', 403, 'DOCUMENT_ACCESS_REQUIRED');
  } else auth.operationalPermission(actor, true);
  return fn(actor);
});
async function requireStaff(staffId) {
  v.identifier(staffId, 'employee');
  const employee = await db.getStaffById(staffId);
  if (!employee) throw auth.problem('Employee not found.', 404, 'STAFF_NOT_FOUND');
  return employee;
}
async function requireDocument(staffId, documentId) {
  v.identifier(documentId, 'document');
  const document = await db.getStaffDocument(documentId, staffId);
  if (!document) throw auth.problem('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  return document;
}
function date(value, field) {
  if (value === undefined || value === null || value === '') return null;
  try {
    if (value > '9999-12-31') throw new Error('Date outside supported range.');
    return time.validateDate(value);
  } catch { throw v.invalid('Enter a real calendar date for ' + field + '.', field); }
}
function warningDays(value, nullable = false) {
  if (nullable && (value === undefined || value === null)) return null;
  if (!Number.isInteger(value) || value < 1 || value > 365) throw v.invalid('Choose a reminder period from 1 to 365 days.', 'warningDays');
  return value;
}
function expirationMetadata(payload, previous = {}) {
  const read = (key, fallback) => Object.hasOwn(payload, key) ? payload[key] : previous[key] ?? fallback;
  const values = {
    issuer: v.text(read('issuer', ''), 'issuer', 200), reference: v.text(read('reference', ''), 'reference', 100),
    issuedOn: date(read('issuedOn', null), 'issuedOn'), expiresOn: date(read('expiresOn', null), 'expiresOn'),
    nonExpiring: read('nonExpiring', false), warningDays: warningDays(read('warningDays', null), true),
  };
  if (typeof values.nonExpiring !== 'boolean') throw v.invalid('Choose whether this document has no expiration date.', 'nonExpiring');
  if (values.nonExpiring && values.expiresOn) throw v.invalid('Clear the expiration date or turn off Does not expire.', 'expiresOn');
  if (values.issuedOn && values.expiresOn && values.issuedOn > values.expiresOn) throw v.invalid('Expiration cannot be before the issue date.', 'expiresOn');
  return values;
}
function metadata(payload) {
  return { ...v.metadata(payload), ...expirationMetadata(payload) };
}
function mapping(payload, previous = {}) {
  if (!mappingKeys.some((key) => Object.hasOwn(payload, key))) return Object.fromEntries(mappingKeys.map((key) => [key, previous[key] ?? null]));
  if (!mappingKeys.every((key) => Object.hasOwn(payload, key)) ||
      payload.registrationFormId === null && payload.registrationFormRevisionId !== null) {
    throw v.invalid('Choose both an employee requirement and its current blank version, or clear both.', 'registrationFormId');
  }
  return Object.fromEntries(mappingKeys.map((key) => [key, payload[key] === null ? null : v.identifier(payload[key], key)]));
}
async function requireCurrentMapping(values) {
  if (values.registrationFormId === null) return null;
  const form = await db.getRegistrationForm(values.registrationFormId);
  if (!form || form.audience !== 'employee' || !form.active || form.currentRevisionId !== values.registrationFormRevisionId) {
    throw conflict('This employee requirement is no longer the current active version. Reload the checklist and choose its current version.');
  }
  return form;
}
function ensureExpirationChoice(values, form) {
  if (form.expirationRequired && (!values.expiresOn || values.nonExpiring)) {
    throw v.invalid('This requirement needs an expiration date before it can be reviewed.', 'expiresOn');
  }
  if (!values.expiresOn && !values.nonExpiring) {
    throw v.invalid('Enter an expiration date or explicitly choose Does not expire before reviewing.', 'expiresOn');
  }
}
function revisionValues(file, actor, documentId, revision, values, request, changeNote) {
  return { id: randomUUID(), ...file, ...Object.fromEntries([...metadataKeys, ...mappingKeys].map((key) => [key, values[key] ?? null])),
    actorId: actor.id, uploadedBy: actor.username, uploadedAt: new Date().toISOString(), documentId, revision, ...request, changeNote };
}
async function repeated(requestScope, requestId, requestHash, staffId) {
  const old = await db.getStaffDocumentRevisionByRequest(requestScope, requestId);
  if (!old) return null;
  if (old.requestHash !== requestHash) throw conflict('This upload request was already used for different details. Reload before trying again.');
  const document = await requireDocument(staffId, old.documentId);
  return { document: summary(document), revision: revisionSummary(old, document), replayed: true };
}
exports.list = (token, staffId, query) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  const pagination = v.pagination(query);
  const [rows, total] = await Promise.all([db.listStaffDocuments(staffId, pagination), db.countStaffDocuments(staffId)]);
  await auth.audit(actor, 'staff_document.list', staffId);
  return { items: rows.map(summary), total };
});
exports.get = (token, staffId, documentId, query) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  const pagination = v.pagination(query);
  const document = await requireDocument(staffId, documentId);
  const [rows, total] = await Promise.all([db.listStaffDocumentRevisions(documentId, pagination), db.countStaffDocumentRevisions(documentId)]);
  await auth.audit(actor, 'staff_document.view', documentId);
  return { document: summary(document), revisions: rows.map((row) => revisionSummary(row, document)), total };
});
exports.content = (token, staffId, documentId, revisionId, query) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  v.object(query || {}, ['download'], 'download');
  if (query?.download !== undefined && query.download !== '1') throw v.invalid('Choose a valid download option.', 'download');
  await requireDocument(staffId, documentId); v.identifier(revisionId, 'revision');
  const revision = await db.getStaffDocumentContent(documentId, revisionId);
  if (!revision) throw auth.problem('Document version not found.', 404, 'DOCUMENT_NOT_FOUND');
  await auth.audit(actor, query?.download === '1' ? 'staff_document.download' : 'staff_document.preview', documentId);
  return { ...revision, content: Buffer.from(revision.content), download: query?.download === '1' };
});
exports.create = (token, staffId, payload) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  v.object(payload, ['requestId', ...metadataKeys, ...mappingKeys, 'file'], 'employee document');
  const requestId = v.requestId(payload.requestId); const values = { ...metadata(payload), ...mapping(payload) }; const file = v.file(payload.file);
  const requestScope = hash([actor.id, staffId, 'staff-document-create']);
  const requestHash = hash([values, file.filename, file.contentType, file.sha256]);
  const replay = await repeated(requestScope, requestId, requestHash, staffId);
  if (replay) return replay;
  await requireCurrentMapping(values);
  if (await db.countStaffDocuments(staffId) >= MAX_DOCUMENTS) throw auth.problem('This employee can have at most 100 documents.', 409, 'DOCUMENT_LIMIT');
  const documentId = randomUUID();
  const revision = revisionValues(file, actor, documentId, 1, values, { requestId, requestScope, requestHash }, '');
  const document = await db.createStaffDocument({ id: documentId, staffId, ...values, ...clearReview, version: 1, currentRevisionId: revision.id });
  await db.createStaffDocumentRevision(revision);
  await auth.audit(actor, 'staff_document.upload', documentId);
  return { document: summary(document), revision: revisionSummary(revision, document), replayed: false };
});
exports.revise = (token, staffId, documentId, payload) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  v.object(payload, ['requestId', 'version', 'changeNote', 'file', 'issuedOn', 'expiresOn', 'nonExpiring', 'issuer', 'reference', 'warningDays', ...mappingKeys]);
  const requestId = v.requestId(payload.requestId); const version = v.version(payload.version);
  const changeNote = v.text(payload.changeNote, 'changeNote', 500); const file = v.file(payload.file);
  const document = await requireDocument(staffId, documentId);
  const requestScope = hash([actor.id, staffId, documentId, 'staff-document-revise']);
  // Hash the submitted renewal choices, not mutable current metadata. An exact
  // retry remains an exact retry even after another correction or review.
  const requestHash = hash([version, changeNote, Object.fromEntries(['issuedOn', 'expiresOn', 'nonExpiring', 'issuer', 'reference', 'warningDays', ...mappingKeys]
    .filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]])), file.filename, file.contentType, file.sha256]);
  const replay = await repeated(requestScope, requestId, requestHash, staffId);
  if (replay) return replay;
  if (document.version !== version) throw conflict();
  const values = { ...Object.fromEntries(metadataKeys.map((key) => [key, document[key] ?? null])),
    ...expirationMetadata(payload, document), ...mapping(payload, document) };
  if (mappingKeys.some((key) => values[key] !== document[key])) await requireCurrentMapping(values);
  if (await db.countStaffDocumentRevisions(documentId) >= MAX_REVISIONS) throw auth.problem('This document can have at most 100 revisions.', 409, 'DOCUMENT_REVISION_LIMIT');
  const current = await db.getStaffDocumentRevision(documentId, document.currentRevisionId);
  if (!current) throw auth.problem('The current document version could not be loaded.', 500);
  const revision = revisionValues(file, actor, documentId, current.revision + 1, values, { requestId, requestScope, requestHash }, changeNote);
  await db.createStaffDocumentRevision(revision);
  const saved = await db.updateStaffDocument(documentId, { ...values, ...clearReview, version: version + 1, currentRevisionId: revision.id });
  await auth.audit(actor, 'staff_document.renew', documentId);
  return { document: summary(saved), revision: revisionSummary(revision, saved), replayed: false };
});
exports.update = (token, staffId, documentId, payload) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  v.object(payload, ['version', ...metadataKeys, ...mappingKeys], 'employee document');
  const version = v.version(payload.version); const values = metadata(payload);
  const document = await requireDocument(staffId, documentId);
  if (document.version !== version) throw conflict();
  const assignment = mapping(payload, document);
  if (mappingKeys.some((key) => assignment[key] !== (document[key] ?? null))) await requireCurrentMapping(assignment);
  const snapshot = { ...values, ...assignment };
  let revision;
  if ([...metadataKeys, ...mappingKeys].some((key) => snapshot[key] !== (document[key] ?? null))) {
    if (await db.countStaffDocumentRevisions(documentId) >= MAX_REVISIONS) throw auth.problem('This document can have at most 100 revisions.', 409, 'DOCUMENT_REVISION_LIMIT');
    // Date corrections are revisions too: retain the original file bytes and
    // the prior certificate metadata, and require review of the corrected copy.
    const file = await db.getStaffDocumentContent(documentId, document.currentRevisionId);
    if (!file) throw auth.problem('The current document version could not be loaded.', 500);
    revision = revisionValues({ filename: file.filename, contentType: file.contentType, byteLength: file.byteLength,
      sha256: file.sha256, content: Buffer.from(file.content) }, actor, documentId, file.revision + 1, snapshot,
    { requestId: randomUUID(), requestScope: hash([actor.id, staffId, documentId, 'metadata']), requestHash: hash([version, snapshot]) }, 'Document details corrected');
    await db.createStaffDocumentRevision(revision);
  }
  const saved = await db.updateStaffDocument(documentId, { ...snapshot, version: version + 1,
    ...(revision ? { ...clearReview, currentRevisionId: revision.id } : {}) });
  await auth.audit(actor, 'staff_document.update_metadata', documentId);
  return { document: summary(saved) };
});
exports.review = (token, staffId, documentId, payload) => authorized(token, true, async (actor) => {
  await requireStaff(staffId);
  v.object(payload, ['version', 'reviewed'], 'review');
  const version = v.version(payload.version);
  if (typeof payload.reviewed !== 'boolean') throw v.invalid('Choose whether this document is reviewed.', 'reviewed');
  const document = await requireDocument(staffId, documentId);
  if (document.version !== version) throw conflict();
  if (!await db.getStaffDocumentRevision(documentId, document.currentRevisionId)) throw auth.problem('The current document version could not be loaded.', 500);
  if (payload.reviewed) {
    if (!document.registrationFormId) throw v.invalid('Assign this document to a current employee requirement before reviewing it.', 'registrationFormId');
    ensureExpirationChoice(document, await requireCurrentMapping(document));
  }
  const saved = await db.updateStaffDocument(documentId, { version: version + 1,
    ...(payload.reviewed ? { reviewedRevisionId: document.currentRevisionId, reviewedBy: actor.id, reviewedAt: new Date().toISOString() } : clearReview) });
  await auth.audit(actor, 'staff_document.review', documentId);
  return { document: summary(saved) };
});
const accepted = (document) => Boolean(document.reviewedRevisionId === document.currentRevisionId && document.reviewedBy && document.reviewedAt);
function timing(document, settings, today) {
  const days = document.warningDays ?? settings.warningDays;
  const expiresOn = document.expiresOn ?? null;
  const daysRemaining = expiresOn ? Math.round((Date.parse(expiresOn + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) : null;
  return { expiresOn, daysRemaining, warningDays: days, nextReminderDate: expiresOn ? time.addDays(expiresOn, -days) : null };
}
function status(form, document, isCurrent, timingValues, today) {
  if (!document) return 'missing';
  if (!isCurrent) return 'outdated';
  if (form.expirationRequired && (!document.expiresOn || document.nonExpiring) || !document.expiresOn && !document.nonExpiring) return 'expiry_missing';
  if (document.expiresOn && document.expiresOn < today) return 'expired';
  if (!accepted(document)) return 'needs_review';
  return timingValues.daysRemaining !== null && timingValues.daysRemaining <= timingValues.warningDays ? 'expiring' : 'complete';
}
async function checklist(staffId, templates, settings, today, fullForms = true) {
  const documents = await db.listAllStaffDocuments(staffId);
  const items = await Promise.all(templates.map(async (form) => {
    const matching = documents.filter((document) => document.registrationFormId === form.id);
    const current = matching.filter((document) => document.registrationFormRevisionId === form.currentRevisionId);
    const validAccepted = current.find((document) => accepted(document) && (!document.expiresOn || document.expiresOn >= today) &&
      (form.expirationRequired ? Boolean(document.expiresOn && !document.nonExpiring) : Boolean(document.expiresOn || document.nonExpiring)));
    const document = validAccepted || current[0] || matching[0] || null;
    const timingValues = document ? timing(document, settings, today) : { expiresOn: null, daysRemaining: null, warningDays: settings.warningDays, nextReminderDate: null };
    return { form: fullForms ? await forms.currentSummary(form) : { id: form.id, title: form.title, required: form.required },
      status: status(form, document, current.includes(document), timingValues, today), document: document ? summary(document) : null, ...timingValues };
  }));
  const required = items.filter((item) => item.form.required);
  const requiredComplete = required.filter((item) => ['complete', 'expiring'].includes(item.status)).length;
  return { items, requiredTotal: required.length, requiredComplete,
    complete: required.length > 0 && requiredComplete === required.length,
    percentage: required.length ? Math.floor(100 * requiredComplete / required.length) : 0 };
}
exports.checklist = (token, staffId, query) => authorized(token, true, async (actor) => {
  await requireStaff(staffId); v.object(query || {}, [], 'employee checklist');
  const [catalog, settings] = await Promise.all([db.listRegistrationForms(), db.getStaffDocumentSettings()]);
  const today = time.dateAt();
  const result = await checklist(staffId, catalog.filter((form) => form.audience === 'employee'), settings, today);
  await auth.audit(actor, 'staff_document.checklist', staffId);
  return { ...result,
    warningDays: settings.warningDays, today, timeZone: time.timeZone() };
});
exports.compliance = (token, query) => authorized(token, false, async () => {
  v.object(query || {}, [], 'employee reminders');
  const [catalog, settings, employees] = await Promise.all([db.listRegistrationForms(), db.getStaffDocumentSettings(), db.listAllStaff()]);
  const required = catalog.filter((form) => form.audience === 'employee' && form.required);
  const active = employees.filter((person) => person.active);
  const today = time.dateAt();
  const items = [];
  for (const employee of active) {
    const result = await checklist(employee.id, required, settings, today, false);
    for (const item of result.items) {
      if (item.status === 'complete') continue;
      // Explicit allowlist: editors receive only actionable compliance facts,
      // never document IDs, medical notes, filenames or revision/review details.
      items.push({ staffId: employee.id, employeeName: employee.name, requirementId: item.form.id, requirementTitle: item.form.title,
        status: item.status, expiresOn: item.expiresOn, daysRemaining: item.daysRemaining, warningDays: item.warningDays, nextReminderDate: item.nextReminderDate });
    }
  }
  // The dashboard may show only the first few reminders. Put overdue and
  // approaching deadlines first so alphabetical staff order cannot hide them.
  const urgency = { expired: 0, expiring: 1, expiry_missing: 2, outdated: 3, needs_review: 4, missing: 5 };
  items.sort((a, b) => urgency[a.status] - urgency[b.status] ||
    (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity) ||
    a.employeeName.localeCompare(b.employeeName, 'en') || a.requirementTitle.localeCompare(b.requirementTitle, 'en') ||
    a.staffId.localeCompare(b.staffId, 'en') || a.requirementId.localeCompare(b.requirementId, 'en'));
  const totals = Object.fromEntries(['missing', 'needs_review', 'outdated', 'expiry_missing', 'expired', 'expiring']
    .map((state) => [state, items.filter((item) => item.status === state).length]));
  return { items, totals, warningDays: settings.warningDays, today, timeZone: time.timeZone(),
    configured: required.length > 0, requiredTotal: required.length, activeStaffTotal: active.length };
});
exports.getSettings = (token, query) => authorized(token, false, async () => {
  v.object(query || {}, [], 'employee reminder settings');
  const settings = await db.getStaffDocumentSettings();
  return { warningDays: settings.warningDays, version: settings.version };
});
exports.updateSettings = (token, payload) => authorized(token, true, async (actor) => {
  v.object(payload, ['warningDays', 'version'], 'employee reminder settings');
  const version = v.version(payload.version); const days = warningDays(payload.warningDays);
  const old = await db.getStaffDocumentSettings();
  if (old.version !== version) throw conflict('The reminder settings changed elsewhere. Reload them before saving.');
  const settings = await db.saveStaffDocumentSettings({ id: 'current', warningDays: days, version: version + 1 });
  await auth.audit(actor, 'staff_document.reminder_settings', 'current');
  return { warningDays: settings.warningDays, version: settings.version };
});
