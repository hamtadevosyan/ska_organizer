const { createHash, randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const v = require('./childDocumentValidation');

const summary = (row) => ({
  ...Object.fromEntries(['id', 'childId', 'title', 'category', 'documentDate', 'notes', 'version', 'currentRevisionId'].map((key) => [key, row[key]])),
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
exports.create = (token, childId, payload) => authorized(token, true, childId, async (actor) => {
  v.object(payload, ['requestId', 'title', 'category', 'documentDate', 'notes', 'file']);
  const requestId = v.requestId(payload.requestId); const values = v.metadata(payload); const file = v.file(payload.file);
  const requestScope = hash([actor.id, childId, 'create']);
  const requestHash = hash([values, file.filename, file.contentType, file.sha256]);
  const replay = await repeated(requestScope, requestId, requestHash, childId);
  if (replay) return replay;
  const documentId = randomUUID();
  const revision = revisionValues(file, actor, requestId, requestScope, requestHash, documentId, 1, '');
  const document = await db.createChildDocument({ id: documentId, childId, ...values, version: 1, currentRevisionId: revision.id });
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
  const saved = await db.updateChildDocument(documentId, { version: version + 1, currentRevisionId: revision.id });
  await auth.audit(actor, 'child_document.revise', documentId);
  return { document: summary(saved), revision: revisionSummary(revision, saved), replayed: false };
});
exports.update = (token, childId, documentId, payload) => authorized(token, true, childId, async (actor) => {
  v.object(payload, ['version', 'title', 'category', 'documentDate', 'notes']);
  const version = v.version(payload.version); const values = v.metadata(payload);
  const document = await requireDocument(childId, documentId);
  if (document.version !== version) throw conflict();
  const saved = await db.updateChildDocument(documentId, { ...values, version: version + 1 });
  await auth.audit(actor, 'child_document.update_metadata', documentId);
  return { document: summary(saved) };
});
