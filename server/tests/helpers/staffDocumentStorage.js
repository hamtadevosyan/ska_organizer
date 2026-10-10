const { createHash, randomUUID } = require('node:crypto');
const { PNG } = require('pngjs');
const db = require('../../services/dbAdapter');

function page(shade) {
  const image = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([shade, 70, 90, 255], offset);
  return PNG.sync.write(image);
}
const originalBytes = () => page(40);
const revisedBytes = () => page(190);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function saveStaffDocuments(actor) {
  const person = await db.createStaff({ id: randomUUID(), name: 'Synthetic certificate persistence', role: 'Teacher',
    active: true, roomId: null, version: 1 });
  const form = await db.createRegistrationForm({ id: randomUUID(), title: 'Synthetic CPR requirement', audience: 'employee',
    category: 'other', required: true, expirationRequired: true, active: true, version: 1, currentRevisionId: null });
  const documentId = randomUUID(); const firstId = randomUUID();
  const original = originalBytes(); const revised = revisedBytes();
  const metadata = { title: 'Synthetic certificate', category: 'other', documentDate: '2026-10-01',
    notes: 'Automated fictional certificate.', issuer: 'Synthetic training provider', reference: 'SYNTHETIC-1',
    issuedOn: '2026-10-01', expiresOn: '2027-10-01', nonExpiring: false, warningDays: null,
    registrationFormId: form.id, registrationFormRevisionId: null };
  const revision = (id, number, bytes, values) => ({ id, documentId, revision: number, ...values,
    filename: 'synthetic-certificate-' + number + '.png', contentType: 'image/png', byteLength: bytes.length,
    sha256: hash(bytes), content: bytes, uploadedAt: new Date(), actorId: actor.id, uploadedBy: actor.username,
    changeNote: 'Synthetic revision ' + number, requestId: randomUUID(), requestScope: documentId,
    requestHash: hash(Buffer.from('Synthetic request ' + number)) });
  await db.withAuthLock(async () => {
    await db.createStaffDocument({ id: documentId, staffId: person.id, ...metadata, version: 1, currentRevisionId: firstId });
    await db.createStaffDocumentRevision(revision(firstId, 1, original, metadata));
    const nextId = randomUUID();
    await db.createStaffDocumentRevision(revision(nextId, 2, revised, metadata));
    await db.updateStaffDocument(documentId, { version: 2, currentRevisionId: nextId });
    // A correction retains the same uploaded bytes and saves a new immutable
    // metadata snapshot, so the old certificate dates remain recoverable.
    const corrected = { ...metadata, reference: 'SYNTHETIC-2', expiresOn: '2028-10-01', warningDays: 30 };
    const correctedId = randomUUID();
    await db.createStaffDocumentRevision(revision(correctedId, 3, revised, corrected));
    await db.updateStaffDocument(documentId, { ...corrected, version: 3, currentRevisionId: correctedId,
      reviewedRevisionId: correctedId, reviewedBy: actor.id, reviewedAt: new Date() });
    await db.saveStaffDocumentSettings({ warningDays: 30, version: 2 });
  });
  return { person, form, documentId };
}

async function staffDocumentSnapshot(saved) {
  if (!saved) {
    const person = (await db.listAllStaff()).find((row) => row.name === 'Synthetic certificate persistence');
    if (!person) throw new Error('Synthetic staff record was not preserved.');
    const document = (await db.listAllStaffDocuments(person.id))[0];
    if (!document) throw new Error('Synthetic staff document was not preserved.');
    saved = { person, form: { id: document.registrationFormId }, documentId: document.id };
  }
  const document = await db.getStaffDocument(saved.documentId, saved.person.id);
  const revisions = await db.listStaffDocumentRevisions(saved.documentId);
  const files = [];
  if (!document || revisions.length !== 3 || document.reviewedRevisionId !== document.currentRevisionId) {
    throw new Error('Synthetic staff certificate history or review was not preserved.');
  }
  for (const revision of revisions) {
    const stored = await db.getStaffDocumentContent(saved.documentId, revision.id);
    const bytes = Buffer.from(stored.content);
    if (hash(bytes) !== stored.sha256 || bytes.length !== stored.byteLength ||
        !bytes.equals(revision.revision === 1 ? originalBytes() : revisedBytes())) {
      throw new Error('Synthetic staff file bytes were not preserved.');
    }
    const { content, ...metadata } = stored;
    files.push({ ...metadata, bytes: bytes.toString('base64') });
  }
  const form = await db.getRegistrationForm(saved.form.id);
  if (!form || form.currentRevisionId !== null || !form.expirationRequired || form.audience !== 'employee') {
    throw new Error('Synthetic certificate requirement without a blank file was not preserved.');
  }
  return { person: await db.getStaffById(saved.person.id), document, revisions, files, form,
    settings: await db.getStaffDocumentSettings() };
}

module.exports = { saveStaffDocuments, staffDocumentSnapshot, originalBytes };
