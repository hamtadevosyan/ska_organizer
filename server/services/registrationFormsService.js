const { createHash, randomUUID } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const v = require('./childDocumentValidation');

const MAX_FORMS = 100;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message = 'This registration form changed elsewhere. Reload it before saving again.') =>
  auth.problem(message, 409, 'REGISTRATION_FORM_CONFLICT');
const summary = (form, revision) => ({
  audience: form.audience || 'child',
  expirationRequired: form.expirationRequired === true,
  ...Object.fromEntries(['id', 'title', 'instructions', 'category', 'audience', 'required', 'active', 'version', 'currentRevisionId']
    .map((key) => [key, form[key]])),
  templateRevision: revision?.revision || 0,
  updatedAt: new Date(form.updatedAt).toISOString(),
});
const revisionSummary = (revision, form) => ({
  ...Object.fromEntries(['id', 'revision', 'filename', 'contentType', 'byteLength', 'sha256', 'uploadedBy', 'changeNote']
    .map((key) => [key, revision[key]])),
  uploadedAt: new Date(revision.uploadedAt).toISOString(), current: revision.id === form.currentRevisionId,
});
function metadata(payload, previousAudience = 'child', previousExpirationRequired = false) {
  const audience = payload.audience === undefined ? previousAudience : payload.audience;
  if (!['child', 'employee', 'facility'].includes(audience)) throw v.invalid('Choose children, employees or facility.', 'audience');
  if (!['medical', 'contract', 'consent', 'other'].includes(payload.category)) throw v.invalid('Choose a form category.', 'category');
  if (typeof payload.required !== 'boolean') throw v.invalid('Choose whether this form is required.', 'required');
  const expirationRequired = payload.expirationRequired === undefined ? previousExpirationRequired : payload.expirationRequired;
  if (typeof expirationRequired !== 'boolean') throw v.invalid('Choose whether an expiration date is required.', 'expirationRequired');
  if (expirationRequired && audience !== 'employee') throw v.invalid('Only employee requirements can require an expiration date.', 'expirationRequired');
  return { title: v.text(payload.title, 'title', 160, { required: true }),
    audience, instructions: v.text(payload.instructions, 'instructions', 2000), category: payload.category, required: payload.required, expirationRequired };
}
const authorized = (token, write, fn) => db.withAuthLock(async () => {
  const actor = await auth.sessionAccount(token, { touch: true });
  auth.documentPermission(actor, false);
  if (write && actor.role !== 'admin') throw auth.problem('Administrator access is required.', 403, 'FORBIDDEN');
  return fn(actor);
});
async function requireForm(formId) {
  v.identifier(formId, 'registrationFormId');
  const form = await db.getRegistrationForm(formId);
  if (!form) throw auth.problem('Registration form not found.', 404, 'REGISTRATION_FORM_NOT_FOUND');
  return form;
}
async function currentSummary(form) {
  if (!form.currentRevisionId && form.audience === 'employee') return summary(form, null);
  const revision = await db.getRegistrationFormRevision(form.id, form.currentRevisionId);
  if (!revision) throw auth.problem('The current registration form version could not be loaded.', 500);
  return summary(form, revision);
}
exports.list = (token, query) => authorized(token, false, async (actor) => {
  v.object(query || {}, ['includeArchived'], 'forms');
  if (query?.includeArchived !== undefined && query.includeArchived !== '1') throw v.invalid('Choose a valid archive option.', 'includeArchived');
  if (query?.includeArchived === '1' && actor.role !== 'admin') throw auth.problem('Administrator access is required.', 403, 'FORBIDDEN');
  const forms = await db.listRegistrationForms({ includeArchived: query?.includeArchived === '1' });
  return { items: await Promise.all(forms.map(currentSummary)) };
});
exports.get = (token, formId, query) => authorized(token, false, async () => {
  const pagination = v.pagination(query);
  const form = await requireForm(formId);
  const [rows, total, formSummary] = await Promise.all([db.listRegistrationFormRevisions(formId, pagination),
    db.countRegistrationFormRevisions(formId), currentSummary(form)]);
  return { form: formSummary, revisions: rows.map((row) => revisionSummary(row, form)), total };
});
exports.content = (token, formId, revisionId, query) => authorized(token, false, async () => {
  v.object(query || {}, ['download'], 'download');
  if (query?.download !== undefined && query.download !== '1') throw v.invalid('Choose a valid download option.', 'download');
  await requireForm(formId); v.identifier(revisionId, 'revision');
  const revision = await db.getRegistrationFormContent(formId, revisionId);
  if (!revision) throw auth.problem('Registration form version not found.', 404, 'REGISTRATION_FORM_NOT_FOUND');
  return { ...revision, content: Buffer.from(revision.content), download: query?.download === '1' };
});
async function repeated(requestScope, requestId, requestHash) {
  const old = await db.getRegistrationFormRevisionByRequest(requestScope, requestId);
  if (!old) return null;
  if (old.requestHash !== requestHash) throw conflict('This upload request was already used for different details. Reload the form before trying again.');
  const form = await requireForm(old.formId);
  return { form: await currentSummary(form), revision: revisionSummary(old, form), replayed: true };
}
function revisionValues(file, actor, requestId, requestScope, requestHash, formId, revision, changeNote) {
  return { id: randomUUID(), ...file, actorId: actor.id, uploadedBy: actor.username,
    uploadedAt: new Date().toISOString(), requestId, requestScope, requestHash, formId, revision, changeNote };
}
exports.create = (token, payload) => authorized(token, true, async (actor) => {
  v.object(payload, ['requestId', 'title', 'instructions', 'category', 'audience', 'required', 'expirationRequired', 'file'], 'registration form');
  const requestId = v.requestId(payload.requestId); const values = metadata(payload);
  const file = values.audience === 'employee' && payload.file === undefined ? null : v.file(payload.file);
  const requestScope = hash([actor.id, 'registration-form-create']);
  // Preserve lost-response retries saved before the audience / expiration flags existed.
  const hashedValues = Object.fromEntries(Object.entries(values).filter(([key]) =>
    (key !== 'audience' || payload.audience !== undefined) && (key !== 'expirationRequired' || payload.expirationRequired !== undefined)));
  const requestHash = hash([hashedValues, file?.filename, file?.contentType, file?.sha256]);
  const requirementId = hash([actor.id, 'employee-requirement', requestId]);
  const existingRequirement = await db.getRegistrationForm(requirementId);
  if (existingRequirement) {
    const sameMetadata = Object.entries(values).every(([key, value]) => existingRequirement[key] === value);
    if (file || existingRequirement.currentRevisionId || existingRequirement.version !== 1 || !existingRequirement.active || !sameMetadata) {
      throw conflict('This requirement request was already used or changed. Reload the catalog before trying again.');
    }
    return { form: await currentSummary(existingRequirement), revision: null, replayed: true };
  }
  const replay = await repeated(requestScope, requestId, requestHash);
  if (replay) return replay;
  if (await db.countRegistrationForms() >= MAX_FORMS) {
    throw auth.problem('The registration form catalog can contain at most 100 forms.', 409, 'REGISTRATION_FORM_LIMIT');
  }
  const formId = file ? randomUUID() : requirementId;
  const revision = file ? revisionValues(file, actor, requestId, requestScope, requestHash, formId, 1, '') : null;
  const form = await db.createRegistrationForm({ id: formId, ...values, active: true, version: 1, currentRevisionId: revision?.id || null });
  if (revision) await db.createRegistrationFormRevision(revision);
  await auth.audit(actor, file ? 'registration_form.upload' : 'registration_form.create_requirement', formId);
  return { form: summary(form, revision), revision: revision ? revisionSummary(revision, form) : null, replayed: false };
});
exports.update = (token, formId, payload) => authorized(token, true, async (actor) => {
  v.object(payload, ['version', 'title', 'instructions', 'category', 'audience', 'required', 'expirationRequired', 'active'], 'registration form');
  const version = v.version(payload.version);
  const form = await requireForm(formId);
  const values = metadata(payload, form.audience || 'child', form.expirationRequired === true);
  if (values.audience !== (form.audience || 'child')) throw v.invalid('The template belongs to its original group. Upload a separate template for another group.', 'audience');
  if (typeof payload.active !== 'boolean') throw v.invalid('Choose whether this form is active.', 'active');
  if (form.version !== version) throw conflict();
  const saved = await db.updateRegistrationForm(formId, { ...values, active: payload.active, version: version + 1 });
  await auth.audit(actor, 'registration_form.update_metadata', formId);
  return { form: await currentSummary(saved) };
});
exports.revise = (token, formId, payload) => authorized(token, true, async (actor) => {
  v.object(payload, ['requestId', 'version', 'changeNote', 'file'], 'registration form');
  const requestId = v.requestId(payload.requestId); const version = v.version(payload.version);
  const changeNote = v.text(payload.changeNote, 'changeNote', 500); const file = v.file(payload.file);
  const form = await requireForm(formId);
  const requestScope = hash([actor.id, formId, 'registration-form-revise']);
  const requestHash = hash([version, changeNote, file.filename, file.contentType, file.sha256]);
  const replay = await repeated(requestScope, requestId, requestHash);
  if (replay) return replay;
  if (form.version !== version) throw conflict();
  const current = form.currentRevisionId ? await db.getRegistrationFormRevision(formId, form.currentRevisionId) : null;
  if (!current && (form.currentRevisionId || form.audience !== 'employee')) throw auth.problem('The current registration form version could not be loaded.', 500);
  const revision = revisionValues(file, actor, requestId, requestScope, requestHash, formId, (current?.revision || 0) + 1, changeNote);
  await db.createRegistrationFormRevision(revision);
  const saved = await db.updateRegistrationForm(formId, { version: version + 1, currentRevisionId: revision.id });
  await auth.audit(actor, 'registration_form.revise', formId);
  return { form: summary(saved, revision), revision: revisionSummary(revision, saved), replayed: false };
});
exports.summary = summary;
exports.currentSummary = currentSummary;
