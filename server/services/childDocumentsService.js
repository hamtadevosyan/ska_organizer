const { createHash, randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const v = require('./childDocumentValidation');
const forms = require('./registrationFormsService');

const summary = (row) => ({
  ...Object.fromEntries(['id', 'childId', 'title', 'category', 'documentDate', 'notes', 'version', 'currentRevisionId'].map((key) => [key, row[key]])),
  ...Object.fromEntries(['registrationFormId', 'registrationFormRevisionId', 'reviewedRevisionId', 'reviewedBy'].map((key) => [key, row[key] ?? null])),
  reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
  updatedAt: new Date(row.updatedAt).toISOString(),
});
const revisionSummary = (row, document) => ({
  ...Object.fromEntries(['id', 'revision', 'filename', 'contentType', 'byteLength', 'sha256', 'uploadedBy', 'changeNote'].map((key) => [key, row[key]])),
  uploadedAt: new Date(row.uploadedAt).toISOString(), current: row.id === document.currentRevisionId,
});
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message = 'This document changed elsewhere. Reload it before saving again.') => auth.problem(message, 409, 'DOCUMENT_CONFLICT');
async function requireChild(childId) {
  v.identifier(childId, 'child');
  if (!await db.getChildById(childId)) throw auth.problem('Child not found.', 404, 'CHILD_NOT_FOUND');
}
async function requireDocument(childId, documentId) {
  v.identifier(documentId, 'document');
  const document = await db.getChildDocument(documentId, childId);
  if (!document) throw auth.problem('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  return document;
}
// Permission changes and session revocations use this same lock. Every read,
// including historical file bytes, refreshes access inside the transaction.
const authorized = (token, write, childId, fn) => db.withAuthLock(async () => {
  const actor = await auth.sessionAccount(token, { touch: true });
  auth.documentPermission(actor, write);
  await requireChild(childId);
  return fn(actor);
});
exports.list = (token, childId, query) => authorized(token, false, childId, async () => {
  const pagination = v.pagination(query);
  const [rows, total] = await Promise.all([db.listChildDocuments(childId, pagination), db.countChildDocuments(childId)]);
  return { items: rows.map(summary), total };
});
exports.checklist = (token, childId, query) => authorized(token, false, childId, async () => {
  v.object(query || {}, [], 'checklist');
  const [templates, documents] = await Promise.all([db.listRegistrationForms(), db.listAllChildDocuments(childId)]);
  const items = await Promise.all(templates.map(async (form) => {
    const matching = documents.filter((document) => document.registrationFormId === form.id);
    const current = matching.filter((document) => document.registrationFormRevisionId === form.currentRevisionId);
    // Prefer an accepted current submission even when a later duplicate exists.
    const accepted = current.find((document) => document.reviewedRevisionId === document.currentRevisionId && document.reviewedBy && document.reviewedAt);
    const document = accepted || current[0] || matching[0] || null;
    const status = accepted ? 'complete' : current.length ? 'needs_review' : matching.length ? 'outdated' : 'missing';
    return { form: await forms.currentSummary(form), status, document: document ? summary(document) : null };
  }));
  const required = items.filter((item) => item.form.required);
  const requiredComplete = required.filter((item) => item.status === 'complete').length;
  return { items, requiredTotal: required.length, requiredComplete, complete: items.length > 0 && requiredComplete === required.length };
});
exports.get = (token, childId, documentId, query) => authorized(token, false, childId, async () => {
  const pagination = v.pagination(query);
  const document = await requireDocument(childId, documentId);
  const [rows, total] = await Promise.all([db.listChildDocumentRevisions(documentId, pagination), db.countChildDocumentRevisions(documentId)]);
  return { document: summary(document), revisions: rows.map((row) => revisionSummary(row, document)), total };
});
exports.content = (token, childId, documentId, revisionId, query) => authorized(token, false, childId, async () => {
  v.object(query || {}, ['download'], 'download');
  if (query?.download !== undefined && query.download !== '1') throw v.invalid('Choose a valid download option.', 'download');
  await requireDocument(childId, documentId); v.identifier(revisionId, 'revision');
  const revision = await db.getChildDocumentContent(documentId, revisionId);
  if (!revision) throw auth.problem('Document version not found.', 404, 'DOCUMENT_NOT_FOUND');
  return { ...revision, content: Buffer.from(revision.content), download: query?.download === '1' };
});
async function repeated(requestScope, requestId, requestHash, childId) {
  const old = await db.getChildDocumentRevisionByRequest(requestScope, requestId);
  if (!old) return null;
  if (old.requestHash !== requestHash) throw conflict('This upload request was already used for different details. Reload the form before trying again.');
  const document = await requireDocument(childId, old.documentId);
  return { document: summary(document), revision: revisionSummary(old, document), replayed: true };
}
function revisionValues(file, actor, requestId, requestScope, requestHash, documentId, revision, changeNote) {
  return { id: randomUUID(), ...file, actorId: actor.id, uploadedBy: actor.username,
    uploadedAt: new Date().toISOString(), requestId, requestScope, requestHash, documentId, revision, changeNote };
}
const clearReview = { reviewedRevisionId: null, reviewedBy: null, reviewedAt: null };
function mapping(payload, fallback = { registrationFormId: null, registrationFormRevisionId: null }) {
  const hasForm = Object.hasOwn(payload, 'registrationFormId');
  const hasRevision = Object.hasOwn(payload, 'registrationFormRevisionId');
  if (!hasForm && !hasRevision) return { registrationFormId: fallback.registrationFormId ?? null,
    registrationFormRevisionId: fallback.registrationFormRevisionId ?? null };
  if (!hasForm || !hasRevision || ((payload.registrationFormId === null) !== (payload.registrationFormRevisionId === null))) {
    throw v.invalid('Choose both a registration form and its current blank version, or clear both.', 'registrationFormId');
  }
  if (payload.registrationFormId !== null) {
    v.identifier(payload.registrationFormId, 'registrationFormId');
    v.identifier(payload.registrationFormRevisionId, 'registrationFormRevisionId');
  }
  return { registrationFormId: payload.registrationFormId, registrationFormRevisionId: payload.registrationFormRevisionId };
}
async function requireCurrentMapping(values) {
  if (values.registrationFormId === null) return;
  const form = await db.getRegistrationForm(values.registrationFormId);
  if (!form || !form.active || form.currentRevisionId !== values.registrationFormRevisionId) {
    throw conflict('This registration form is no longer the current active blank. Reload the checklist and choose its current version.');
  }
}
exports.create = (token, childId, payload) => authorized(token, true, childId, async (actor) => {
  v.object(payload, ['requestId', 'title', 'category', 'documentDate', 'notes', 'file', 'registrationFormId', 'registrationFormRevisionId']);
  const requestId = v.requestId(payload.requestId); const metadata = v.metadata(payload);
  const values = { ...metadata, ...mapping(payload) }; const file = v.file(payload.file);
  const requestScope = hash([actor.id, childId, 'create']);
  // Preserve replay hashes for ordinary document requests created before
  // registration forms were configured. Mapped requests include both IDs.
  const hashedValues = values.registrationFormId === null ? metadata : values;
  const requestHash = hash([hashedValues, file.filename, file.contentType, file.sha256]);
  const replay = await repeated(requestScope, requestId, requestHash, childId);
  if (replay) return replay;
  await requireCurrentMapping(values);
  const documentId = randomUUID();
  const revision = revisionValues(file, actor, requestId, requestScope, requestHash, documentId, 1, '');
  const document = await db.createChildDocument({ id: documentId, childId, ...values, ...clearReview, version: 1, currentRevisionId: revision.id });
  await db.createChildDocumentRevision(revision);
  await auth.audit(actor, 'child_document.upload', documentId);
  return { document: summary(document), revision: revisionSummary(revision, document), replayed: false };
});
exports.revise = (token, childId, documentId, payload) => authorized(token, true, childId, async (actor) => {
  v.object(payload, ['requestId', 'version', 'changeNote', 'file']);
  const requestId = v.requestId(payload.requestId); const version = v.version(payload.version);
  const changeNote = v.text(payload.changeNote, 'changeNote', 500); const file = v.file(payload.file);
  const document = await requireDocument(childId, documentId);
  const requestScope = hash([actor.id, childId, documentId, 'revise']);
  const requestHash = hash([version, changeNote, file.filename, file.contentType, file.sha256]);
  const replay = await repeated(requestScope, requestId, requestHash, childId);
  if (replay) return replay;
  if (document.version !== version) throw conflict();
  const current = await db.getChildDocumentRevision(documentId, document.currentRevisionId);
  if (!current) throw auth.problem('The current document version could not be loaded.', 500);
  const revision = revisionValues(file, actor, requestId, requestScope, requestHash, documentId, current.revision + 1, changeNote);
  await db.createChildDocumentRevision(revision);
  const saved = await db.updateChildDocument(documentId, { ...clearReview, version: version + 1, currentRevisionId: revision.id });
  await auth.audit(actor, 'child_document.revise', documentId);
  return { document: summary(saved), revision: revisionSummary(revision, saved), replayed: false };
});
exports.update = (token, childId, documentId, payload) => authorized(token, true, childId, async (actor) => {
  v.object(payload, ['version', 'title', 'category', 'documentDate', 'notes', 'registrationFormId', 'registrationFormRevisionId']);
  const version = v.version(payload.version); const values = v.metadata(payload);
  const document = await requireDocument(childId, documentId);
  if (document.version !== version) throw conflict();
  const assignment = mapping(payload, document);
  const mappingChanged = assignment.registrationFormId !== (document.registrationFormId ?? null) ||
    assignment.registrationFormRevisionId !== (document.registrationFormRevisionId ?? null);
  if (mappingChanged) await requireCurrentMapping(assignment);
  const saved = await db.updateChildDocument(documentId, { ...values, ...assignment, ...(mappingChanged ? clearReview : {}), version: version + 1 });
  await auth.audit(actor, 'child_document.update_metadata', documentId);
  return { document: summary(saved) };
});
exports.review = (token, childId, documentId, payload) => authorized(token, true, childId, async (actor) => {
  v.object(payload, ['version', 'reviewed'], 'review');
  const version = v.version(payload.version);
  if (typeof payload.reviewed !== 'boolean') throw v.invalid('Choose whether this document is reviewed.', 'reviewed');
  const document = await requireDocument(childId, documentId);
  if (document.version !== version) throw conflict();
  if (!await db.getChildDocumentRevision(documentId, document.currentRevisionId)) {
    throw auth.problem('The current document version could not be loaded.', 500);
  }
  if (payload.reviewed) {
    if (!document.registrationFormId || !document.registrationFormRevisionId) throw v.invalid('Assign this document to a current registration form before reviewing it.', 'registrationFormId');
    await requireCurrentMapping(document);
  }
  const saved = await db.updateChildDocument(documentId, { version: version + 1,
    ...(payload.reviewed ? { reviewedRevisionId: document.currentRevisionId, reviewedBy: actor.id, reviewedAt: new Date().toISOString() } : clearReview) });
  await auth.audit(actor, 'child_document.review', documentId);
  return { document: summary(saved) };
});
