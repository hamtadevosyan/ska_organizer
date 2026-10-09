const { randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const { saveStaffDocuments, staffDocumentSnapshot } = require('./helpers/staffDocumentStorage');

afterEach(() => jest.restoreAllMocks());

test('mock storage retains staff revision metadata while excluding bytes and private retry fields from history', async () => {
  const saved = await saveStaffDocuments(request.credentials().account);
  const snapshot = await staffDocumentSnapshot(saved);
  expect(snapshot.document).toMatchObject({ staffId: saved.person.id, expiresOn: '2028-10-01', warningDays: 30 });
  expect(snapshot.revisions.map(({ expiresOn }) => expiresOn)).toEqual(['2028-10-01', '2027-10-01', '2027-10-01']);
  expect(snapshot.revisions.every((row) => !['content', 'requestId', 'requestScope', 'requestHash'].some((key) => Object.hasOwn(row, key)))).toBe(true);
  expect(await db.getStaffDocument(saved.documentId, randomUUID())).toBeNull();
  expect(await db.getStaffDocumentContent(randomUUID(), snapshot.document.currentRevisionId)).toBeNull();
  expect(snapshot.form).toMatchObject({ audience: 'employee', currentRevisionId: null, expirationRequired: true });
});

test('an audit failure rolls back all new document rows, immutable revisions and facility warning settings', async () => {
  const before = await db.getStaffDocumentSettings();
  let aborted;
  jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  await expect(db.withAuthLock(async () => {
    aborted = await saveStaffDocuments(request.credentials().account);
    await db.appendAudit({ action: 'Synthetic staff update' });
  })).rejects.toThrow('Synthetic audit failure');
  expect(await db.listAllStaff()).toEqual([]);
  expect(await db.listRegistrationForms()).toEqual([]);
  expect(await db.countStaffDocuments(aborted.person.id)).toBe(0);
  expect(await db.countStaffDocumentRevisions(aborted.documentId)).toBe(0);
  expect(await db.getStaffDocumentSettings()).toEqual(before);
  const saved = await saveStaffDocuments(request.credentials().account);
  expect(await db.countStaffDocuments(saved.person.id)).toBe(1);
  expect(await db.countStaffDocumentRevisions(saved.documentId)).toBe(3);
});
