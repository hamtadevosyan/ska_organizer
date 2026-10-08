const anonymous = require('supertest');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { deflateSync } = require('node:zlib');
const path = require('node:path');
const pngFixture = require('./helpers/pngFixture');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');

// Generated paper containing only "Synthetic document only". These are real
// encodings rather than magic-byte stubs, so validation exercises actual files.
const fixtures = Object.fromEntries(['pdf', 'png', 'jpg'].map(extension => [extension,
  readFileSync(path.join(__dirname, 'fixtures/child-documents', 'synthetic.' + extension))]));
const mime = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };
const file = (extension = 'pdf') => ({ name: 'synthetic.' + extension, contentType: mime[extension], dataBase64: fixtures[extension].toString('base64') });
const metadata = { title: 'Synthetic consent', category: 'consent', documentDate: '2026-10-01', notes: 'Synthetic private notes.' };
const upload = (changes = {}) => ({ requestId: randomUUID(), ...metadata, file: file(), ...changes });
const url = (childId, documentId, revisionId) => '/api/children/' + childId + '/documents' +
  (documentId ? '/' + documentId : '') + (revisionId ? '/revisions/' + revisionId + '/content' : '');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function paddedPdf(totalBytes) {
  function encode(padding) {
    const stream = Buffer.from('BT /F1 12 Tf 10 50 Td (Synthetic document only) Tj ET\n' + ' '.repeat(padding));
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + stream.length + ' >>\nstream\n' + stream.toString() + '\nendstream'];
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets = [];
    for (let index = 0; index < objects.length; index++) {
      offsets.push(chunks.reduce((size, bytes) => size + bytes.length, 0));
      chunks.push(Buffer.from((index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n'));
    }
    const xref = chunks.reduce((size, bytes) => size + bytes.length, 0);
    chunks.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
      'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
    return Buffer.concat(chunks);
  }
  let padding = totalBytes - 1024;
  let result = encode(padding);
  while (result.length !== totalBytes) {
    padding += totalBytes - result.length;
    result = encode(padding);
  }
  return result;
}

function scannerPdf({ xrefStream = false, newline = '\n' } = {}) {
  const content = Buffer.from('BT /F1 12 Tf 10 50 Td (Synthetic scanner document only) Tj ET' + newline);
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const chunks = [Buffer.from('%PDF-' + (xrefStream ? '1.5' : '1.4') + newline)];
  const offsets = [];
  const length = () => chunks.reduce((size, bytes) => size + bytes.length, 0);
  for (let index = 0; index < bodies.length; index++) {
    offsets.push(length()); chunks.push(Buffer.from((index + 1) + ' 0 obj' + newline + bodies[index] + newline + 'endobj' + newline));
  }
  offsets.push(length());
  chunks.push(Buffer.from('5 0 obj' + newline + '<< /Length ' + content.length + ' >>' + newline + 'stream' + newline),
    content, Buffer.from('endstream' + newline + 'endobj' + newline));
  const crossReference = length();
  if (xrefStream) {
    offsets.push(crossReference);
    const entries = Buffer.alloc(7 * 7);
    entries.writeUInt16BE(65535, 5);
    for (let index = 1; index < 7; index++) {
      entries[index * 7] = 1; entries.writeUInt32BE(offsets[index - 1], index * 7 + 1);
    }
    const compressed = deflateSync(entries);
    chunks.push(Buffer.from('6 0 obj' + newline + '<< /Type /XRef /Size 7 /Root 1 0 R /W [1 4 2] /Length ' + compressed.length +
      ' /Filter /FlateDecode >>' + newline + 'stream' + newline), compressed, Buffer.from(newline + 'endstream' + newline + 'endobj' + newline));
  } else {
    chunks.push(Buffer.from('xref' + newline + '0 6' + newline + '0000000000 65535 f ' + newline +
      offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n ' + newline).join('') +
      'trailer' + newline + '<< /Size 6 /Root 1 0 R >>' + newline));
  }
  chunks.push(Buffer.from('startxref' + newline + crossReference + newline + '%%EOF' + newline));
  return Buffer.concat(chunks);
}

async function child(changes = {}) {
  const response = await request(app).post('/api/children').send({ firstName: 'Synthetic', lastName: randomUUID(), dateOfBirth: '2022-01-15', ...changes });
  expect(response.status).toBe(201);
  return response.body;
}
async function create(childId, changes = {}) {
  const response = await request(app).post(url(childId)).send(upload(changes));
  expect(response.status).toBe(201);
  return response.body;
}
async function details(childId, documentId) {
  const response = await request(app).get(url(childId, documentId));
  expect(response.status).toBe(200);
  return response.body;
}
function binary(childId, documentId, revisionId, query = {}) {
  return request(app).get(url(childId, documentId, revisionId)).query(query).buffer(true).parse((response, done) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => done(null, Buffer.concat(chunks)));
  });
}
function expectPrivate(response) {
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}
function expectMetadataOnly(body) {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/dataBase64|"bytes"|"fileBytes"|"requestId"|"requestHash"|passwordHash|csrfToken/);
  expect(serialized).not.toContain(fixtures.pdf.toString('base64'));
}
const documentAudits = async () => (await db.listAudit({ limit: 1000 })).filter(event => /document/.test(event.action));

test.each(['pdf', 'png', 'jpg'])('a real %s document stays private and downloads byte for byte', async extension => {
  const savedChild = await child();
  const response = await request(app).post(url(savedChild.id)).send(upload({ file: file(extension) }));
  expect(response.status).toBe(201);
  const { document, revision } = response.body;
  expect(document).toMatchObject({ childId: savedChild.id, ...metadata, version: 1, currentRevisionId: revision.id });
  expect(revision).toMatchObject({ revision: 1, filename: file(extension).name, contentType: mime[extension], byteLength: fixtures[extension].length,
    sha256: digest(fixtures[extension]), current: true });
  expect(Number.isNaN(Date.parse(revision.uploadedAt))).toBe(false);
  expectMetadataOnly(response.body);
  const listing = await request(app).get(url(savedChild.id));
  expect(listing.status).toBe(200);
  expect(listing.body).toMatchObject({ total: 1, items: [expect.objectContaining({ id: document.id, currentRevisionId: revision.id })] });
  expectMetadataOnly(listing.body);
  expectMetadataOnly(await details(savedChild.id, document.id));
  for (const query of [{}, { download: '1' }]) {
    const content = await binary(savedChild.id, document.id, revision.id, query);
    expect(content.status).toBe(200);
    expect(content.body).toEqual(fixtures[extension]);
    expect(content.headers['content-type']).toContain(mime[extension]);
    expect(Number(content.headers['content-length'])).toBe(fixtures[extension].length);
    expectPrivate(content);
    expect(content.headers['content-disposition']).toMatch(query.download ? /^attachment;/ : /^inline;/);
    expect(content.headers['content-security-policy']).toMatch(/sandbox/);
  }
  const head = await request(app).head(url(savedChild.id, document.id, revision.id));
  expect(head.status).toBe(200);
  expectPrivate(head);
  expect(Number(head.headers['content-length'])).toBe(fixtures[extension].length);
  expect(head.text).toBeUndefined();
});

test('a child supports several document categories and optional date and notes', async () => {
  const savedChild = await child();
  for (const category of ['medical', 'contract', 'consent', 'other']) {
    const result = await create(savedChild.id, { title: '  Synthetic ' + category + '  ', category, documentDate: null, notes: '' });
    expect(result.document).toMatchObject({ title: 'Synthetic ' + category, category, documentDate: null, notes: '' });
  }
  const list = await request(app).get(url(savedChild.id)).query({ pageSize: 2, page: 2 });
  expect(list.status).toBe(200);
  expect(list.body.total).toBe(4);
  expect(list.body.items).toHaveLength(2);
  expect(new Set(list.body.items.map(item => item.id)).size).toBe(2);
  for (const query of [{ page: 0 }, { pageSize: 51 }, { page: 'bad' }, { pageSize: -1 }]) {
    expect((await request(app).get(url(savedChild.id)).query(query)).status).toBe(400);
  }
});

test('a scanner file named .jpeg is accepted using its verified JPEG encoding', async () => {
  const savedChild = await child();
  const saved = await create(savedChild.id, { file: { ...file('jpg'), name: 'Synthetic scanner.JPEG' } });
  expect(saved.revision.filename).toBe('Synthetic scanner.JPEG');
  expect((await binary(savedChild.id, saved.document.id, saved.revision.id)).body).toEqual(fixtures.jpg);
});

test.each([
  { xrefStream: false, newline: '\r\n' }, { xrefStream: true, newline: '\n' }, { xrefStream: true, newline: '\r\n' },
])('scanner PDF preserves bytes for cross-reference stream=$xrefStream and its line endings %#', async options => {
  const savedChild = await child();
  const bytes = scannerPdf(options);
  const saved = await create(savedChild.id, { file: { ...file(), dataBase64: bytes.toString('base64') } });
  expect((await binary(savedChild.id, saved.document.id, saved.revision.id)).body).toEqual(bytes);
});

test('an incremental PDF trailer can inherit the catalog from its previous cross-reference section', async () => {
  const savedChild = await child();
  const initial = fixtures.pdf;
  const previous = /startxref\n(\d+)/.exec(initial.toString('latin1'))[1];
  const bytes = Buffer.concat([initial, Buffer.from('xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 6 /Prev ' + previous +
    ' >>\nstartxref\n' + initial.length + '\n%%EOF\n')]);
  const saved = await create(savedChild.id, { file: { ...file(), dataBase64: bytes.toString('base64') } });
  expect((await binary(savedChild.id, saved.document.id, saved.revision.id)).body).toEqual(bytes);
});

test.each([
  ['header and EOF around plain text', Buffer.from('%PDF-1.7\nnot a PDF\n%%EOF\n')],
  ['offset outside the file', Buffer.from(fixtures.pdf.toString('latin1').replace(/startxref\n\d+/, 'startxref\n99999999'), 'latin1')],
  ['offset inside the xref keyword', Buffer.from(fixtures.pdf.toString('latin1').replace(/startxref\n(\d+)/, (_, offset) => 'startxref\n' + (Number(offset) + 1)), 'latin1')],
  ['trailer without a catalog reference', Buffer.from(fixtures.pdf.toString('latin1').replace('/Root', '/Fake'), 'latin1')],
  ['stream dictionary with the wrong object type', Buffer.from(scannerPdf({ xrefStream: true }).toString('latin1').replace('/Type /XRef', '/Type /Page'), 'latin1')],
  ['stream dictionary without its width layout', Buffer.from(scannerPdf({ xrefStream: true }).toString('latin1').replace('/W [', '/F ['), 'latin1')],
])('basic PDF integrity rejects %s without storing a record or success audit', async (_, bytes) => {
  const savedChild = await child();
  const response = await request(app).post(url(savedChild.id)).send(upload({ file: { ...file(), dataBase64: bytes.toString('base64') } }));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('DOCUMENT_INVALID');
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(0);
  expect(await documentAudits()).toEqual([]);
});

test('safe content disposition preserves a Unicode filename without allowing quoted header fields', async () => {
  const savedChild = await child();
  const filename = 'Synthetic "consent" été.pdf';
  const saved = await create(savedChild.id, { file: { ...file(), name: filename } });
  const downloaded = await binary(savedChild.id, saved.document.id, saved.revision.id, { download: '1' });
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers['content-disposition']).toContain('filename="Synthetic _consent_ _t_.pdf"');
  expect(downloaded.headers['content-disposition']).toContain("filename*=UTF-8''" + encodeURIComponent(filename));
  expect(downloaded.body).toEqual(fixtures.pdf);
});

test('an unpaired filename surrogate is rejected before a later preview could fail', async () => {
  const savedChild = await child();
  const response = await request(app).post(url(savedChild.id)).send(upload({ file: { ...file(), name: 'synthetic\ud800.pdf' } }));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('DOCUMENT_INVALID');
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(0);
});

test('empty JPEG scan data cannot pass as a usable document', async () => {
  const savedChild = await child();
  const scanMarker = fixtures.jpg.indexOf(Buffer.from([0xff, 0xda]));
  expect(scanMarker).toBeGreaterThan(0);
  const scanStart = scanMarker + 2 + fixtures.jpg.readUInt16BE(scanMarker + 2);
  const emptyScan = Buffer.concat([fixtures.jpg.subarray(0, scanStart), Buffer.from([0xff, 0xd9])]);
  const response = await request(app).post(url(savedChild.id)).send(upload({ file: { ...file('jpg'), dataBase64: emptyScan.toString('base64') } }));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('DOCUMENT_INVALID');
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(0);
});

test.each([[0, 1, 0], [0, 16, 0], [2, 16, 0], [3, 4, 0], [4, 16, 0], [6, 8, 1]])(
  'valid scanner PNG color=%i depth=%i interlace=%i stays byte exact', async (color, depth, interlace) => {
    const savedChild = await child();
    const bytes = pngFixture.minimal(color, depth, interlace);
    const saved = await create(savedChild.id, { file: { ...file('png'), dataBase64: bytes.toString('base64') } });
    const response = await binary(savedChild.id, saved.document.id, saved.revision.id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
  });

test('the documented 5 MB limit accepts a valid file at the boundary without a regex stack overflow', async () => {
  const savedChild = await child();
  const bytes = paddedPdf(5 * 1024 * 1024);
  expect(bytes.length).toBe(5 * 1024 * 1024);
  const response = await request(app).post(url(savedChild.id)).send(upload({ file: { ...file(), dataBase64: bytes.toString('base64') } }));
  expect(response.status).toBe(201);
  expect(response.body.revision).toMatchObject({ byteLength: bytes.length, sha256: digest(bytes) });
  const content = await binary(savedChild.id, response.body.document.id, response.body.revision.id);
  expect(content.status).toBe(200);
  expect(content.body.length).toBe(bytes.length);
  expect(digest(content.body)).toBe(digest(bytes));
}, 20000);

test('saved revisions preserve every original byte and actor, with only one current version', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const result = await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(),
    version: original.document.version, changeNote: 'Synthetic revised form.', file: file('png') });
  expect(result.status).toBe(201);
  expect(result.body.document).toMatchObject({ id: original.document.id, childId: savedChild.id, version: 2, currentRevisionId: result.body.revision.id });
  expect(result.body.revision).toMatchObject({ revision: 2, changeNote: 'Synthetic revised form.', sha256: digest(fixtures.png), current: true });
  const history = await details(savedChild.id, original.document.id);
  expect(history.total).toBe(2);
  expect(history.revisions).toHaveLength(2);
  expect(history.revisions.filter(row => row.current).map(row => row.id)).toEqual([result.body.revision.id]);
  expect(history.revisions.find(row => row.id === original.revision.id)).toMatchObject({ revision: 1, current: false, sha256: digest(fixtures.pdf) });
  for (const revision of history.revisions) {
    expect(revision.uploadedBy).toBe(request.credentials().account.username);
  }
  expect((await binary(savedChild.id, original.document.id, original.revision.id)).body).toEqual(fixtures.pdf);
  expect((await binary(savedChild.id, original.document.id, result.body.revision.id)).body).toEqual(fixtures.png);
  expectMetadataOnly(history);
  const events = await documentAudits();
  expect(events).toHaveLength(2);
  for (const event of events) expect(event).toMatchObject({ actorId: request.credentials().account.id, actorUsername: 'test-admin', entityId: original.document.id });
  expect(JSON.stringify(events)).not.toMatch(/Synthetic private notes|Synthetic revised form|dataBase64|sha256/);
});

test('revision attribution remains an immutable snapshot after an account is renamed', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  await db.updateAccount(request.credentials().account.id, { username: 'renamed-test-admin', displayName: 'Renamed synthetic administrator' });
  const next = await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') });
  expect(next.status).toBe(201);
  const history = await details(savedChild.id, original.document.id);
  expect(history.revisions.find(row => row.id === original.revision.id).uploadedBy).toBe('test-admin');
  expect(history.revisions.find(row => row.id === next.body.revision.id).uploadedBy).toBe('renamed-test-admin');
});

test('metadata edits keep child association, current bytes and history; stale edits are rejected', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const updated = { title: 'Synthetic updated contract', category: 'contract', documentDate: null, notes: 'Changed synthetic notes.' };
  const response = await request(app).put(url(savedChild.id, original.document.id)).send({ version: original.document.version, ...updated });
  expect(response.status).toBe(200);
  expect(response.body.document).toMatchObject({ id: original.document.id, childId: savedChild.id, ...updated, version: 2, currentRevisionId: original.revision.id });
  const stale = await request(app).put(url(savedChild.id, original.document.id)).send({ version: 1, ...metadata });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('DOCUMENT_CONFLICT');
  const history = await details(savedChild.id, original.document.id);
  expect(history.total).toBe(1);
  expect(history.document).toMatchObject(updated);
  expect((await binary(savedChild.id, original.document.id, original.revision.id)).body).toEqual(fixtures.pdf);
});

test('roster access never grants document access, including guessed history, content and HEAD URLs', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const { account } = request.credentials();
  await db.updateAccount(account.id, { role: 'editor', documentAccess: 'none' });
  expect((await request(app).get('/api/children/' + savedChild.id + '/profile')).status).toBe(200);
  for (const path of [url(savedChild.id), url(savedChild.id, original.document.id), url(savedChild.id, original.document.id, original.revision.id)]) {
    const denied = await request(app).get(path);
    expect(denied.status).toBe(403);
    expectMetadataOnly(denied.body);
    expect(JSON.stringify(denied.body)).not.toContain(metadata.title);
  }
  expect((await request(app).head(url(savedChild.id, original.document.id, original.revision.id))).status).toBe(403);
  expect((await request(app).post(url(savedChild.id)).send(upload())).status).toBe(403);
  expect((await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') })).status).toBe(403);
  expect((await request(app).put(url(savedChild.id, original.document.id)).send({ version: 1, ...metadata })).status).toBe(403);
});

test.each(['editor', 'viewer'])('%s with view permission can read all revisions but cannot modify them', async role => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  await db.updateAccount(request.credentials().account.id, { role, documentAccess: 'view' });
  expect((await request(app).get(url(savedChild.id))).status).toBe(200);
  expect((await request(app).get(url(savedChild.id, original.document.id))).status).toBe(200);
  expect((await binary(savedChild.id, original.document.id, original.revision.id)).body).toEqual(fixtures.pdf);
  expect((await request(app).post(url(savedChild.id)).send(upload())).status).toBe(403);
  expect((await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') })).status).toBe(403);
  expect((await request(app).put(url(savedChild.id, original.document.id)).send({ version: 1, ...metadata })).status).toBe(403);
});

test('an editor explicitly granted edit can upload and revise; viewer cannot write even with stored edit', async () => {
  const savedChild = await child();
  await db.updateAccount(request.credentials().account.id, { role: 'editor', documentAccess: 'edit' });
  const original = await create(savedChild.id);
  const revision = await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') });
  expect(revision.status).toBe(201);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer', documentAccess: 'edit' });
  expect((await request(app).get(url(savedChild.id))).status).toBe(200);
  expect((await request(app).post(url(savedChild.id)).send(upload())).status).toBe(403);
});

test('authentication, document permission, CSRF and origin reject malformed bodies before the larger parser', async () => {
  const savedChild = await child();
  const endpoint = url(savedChild.id);
  const malformed = '{ this must never be parsed';
  expect((await anonymous(app).post(endpoint).set('Origin', request.origin).set('Content-Type', 'application/json').send(malformed)).status).toBe(401);
  expect((await anonymous(app).get(endpoint)).status).toBe(401);
  const token = request.credentials();
  const missingCsrf = await anonymous(app).post(endpoint).set('Origin', request.origin).set('Cookie', token.cookie).set('Content-Type', 'application/json').send(malformed);
  expect(missingCsrf.status).toBe(403);
  expect(missingCsrf.body.error.code).toBe('CSRF_INVALID');
  expect((await request(app).post(endpoint).set('Origin', 'https://outside.example').send(malformed)).status).toBe(403);
  expect((await request(app).post(endpoint).set('Content-Type', 'text/plain').send(malformed)).status).toBe(415);
  await db.updateAccount(token.account.id, { role: 'editor', documentAccess: 'none' });
  const denied = await request(app).post(endpoint).send(malformed);
  expect(denied.status).toBe(403);
  expect((await request(app).post('/api/children').send({ firstName: 'x'.repeat(110000) })).status).toBe(413);
});

test('document and revision IDs are always scoped to their child and document', async () => {
  const firstChild = await child();
  const secondChild = await child();
  const first = await create(firstChild.id);
  const second = await create(secondChild.id);
  for (const endpoint of [url(secondChild.id, first.document.id), url(secondChild.id, first.document.id, first.revision.id),
    url(firstChild.id, first.document.id, second.revision.id)]) {
    const response = await request(app).get(endpoint);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('DOCUMENT_NOT_FOUND');
    expectMetadataOnly(response.body);
  }
  expect((await request(app).head(url(secondChild.id, first.document.id, first.revision.id))).status).toBe(404);
  expect((await request(app).put(url(secondChild.id, first.document.id)).send({ version: 1, ...metadata })).status).toBe(404);
  expect((await request(app).post(url(secondChild.id, first.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') })).status).toBe(404);
  expect((await request(app).post(url('child-never-saved')).send(upload())).status).toBe(404);
  expect((await request(app).get(url('child-never-saved'))).status).toBe(404);
  expect((await details(firstChild.id, first.document.id)).total).toBe(1);
  expect((await details(secondChild.id, second.document.id)).total).toBe(1);
});

test.each([
  { title: '' }, { title: '   ' }, { title: 'x'.repeat(161) }, { category: 'unknown' },
  { documentDate: '2026-02-30' }, { documentDate: '2026-10-01T12:00:00Z' }, { notes: 'x'.repeat(2001) },
  { requestId: 'not-a-uuid' }, { childId: 'other-child' }, { version: 9 },
  { file: { ...file(), name: 'synthetic.exe' } }, { file: { ...file(), contentType: 'text/html' } },
  { file: { ...file(), name: '../synthetic.pdf' } }, { file: { ...file(), name: 'synthetic\r\nX-Injected: true.pdf' } },
  { file: { ...file(), contentType: 'image/png', name: 'synthetic.png' } },
  { file: { ...file(), dataBase64: 'https://outside.example/private.pdf' } },
  { file: { ...file(), dataBase64: '/etc/passwd' } }, { file: { ...file(), dataBase64: '' } },
  { file: { ...file(), dataBase64: 'not base64!' } }, { file: { ...file(), dataBase64: '<script>alert(1)</script>' } },
  { file: { ...file('png'), dataBase64: fixtures.png.subarray(0, 25).toString('base64') } },
  { file: { ...file('jpg'), dataBase64: fixtures.jpg.subarray(0, fixtures.jpg.length - 2).toString('base64') } },
  { file: { ...file(), dataBase64: fixtures.pdf.subarray(0, 30).toString('base64') } },
])('invalid file or metadata input cannot create records or success audits %#', async changes => {
  const savedChild = await child();
  const response = await request(app).post(url(savedChild.id)).send(upload(changes));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('DOCUMENT_INVALID');
  const list = await request(app).get(url(savedChild.id));
  expect(list.body).toMatchObject({ total: 0, items: [] });
  expect(await documentAudits()).toEqual([]);
});

test('oversized files are rejected without disturbing another saved document', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
  const response = await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1,
    file: { ...file(), dataBase64: huge.toString('base64') } });
  expect(response.status).toBe(413);
  expect((await details(savedChild.id, original.document.id)).document.currentRevisionId).toBe(original.revision.id);
  expect((await binary(savedChild.id, original.document.id, original.revision.id)).body).toEqual(fixtures.pdf);
});

test.each([0, 1])('small-dimension PNG with excessive inflated image data is rejected for interlace=%i', async interlace => {
  const savedChild = await child();
  const chunks = pngFixture.chunks(pngFixture.minimal(6, 8, interlace));
  chunks.find(chunk => chunk.type === 'IDAT').data = deflateSync(Buffer.alloc(2 * 1024 * 1024));
  const compressed = pngFixture.assemble(chunks);
  expect(compressed.length).toBeLessThan(5000);
  const response = await request(app).post(url(savedChild.id)).send(upload({ file: { ...file('png'), dataBase64: compressed.toString('base64') } }));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('DOCUMENT_INVALID');
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(0);
  expect(await documentAudits()).toEqual([]);
});

test('a failed or conflicting revision leaves the old current version and audit count intact', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const endpoint = url(savedChild.id, original.document.id) + '/revisions';
  expect((await request(app).post(endpoint).send({ requestId: randomUUID(), version: 1, file: { ...file('png'), dataBase64: 'broken' } })).status).toBe(400);
  expect((await request(app).post(endpoint).send({ requestId: randomUUID(), version: 0, file: file('png') })).status).toBe(400);
  expect((await request(app).post(endpoint).send({ requestId: randomUUID(), version: 99, file: file('png') })).status).toBe(409);
  const history = await details(savedChild.id, original.document.id);
  expect(history).toMatchObject({ total: 1, document: { version: 1, currentRevisionId: original.revision.id } });
  expect(history.revisions[0]).toMatchObject({ id: original.revision.id, current: true });
  expect(await documentAudits()).toHaveLength(1);
});

test('retrying a creation acknowledges the original, including after it has been revised', async () => {
  const savedChild = await child();
  const payload = upload();
  const first = await request(app).post(url(savedChild.id)).send(payload);
  expect(first.status).toBe(201);
  const retry = await request(app).post(url(savedChild.id)).send(payload);
  expect(retry.status).toBe(201);
  expect(retry.body).toMatchObject({ replayed: true, document: { id: first.body.document.id }, revision: { id: first.body.revision.id } });
  await request(app).post(url(savedChild.id, first.body.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') });
  const lateRetry = await request(app).post(url(savedChild.id)).send(payload);
  expect(lateRetry.status).toBe(201);
  expect(lateRetry.body.revision.id).toBe(first.body.revision.id);
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(1);
  expect((await details(savedChild.id, first.body.document.id)).total).toBe(2);
  expect(await documentAudits()).toHaveLength(2);
  const changed = await request(app).post(url(savedChild.id)).send({ ...payload, title: 'A different synthetic record' });
  expect(changed.status).toBe(409);
  expect(changed.body.error.code).toBe('DOCUMENT_CONFLICT');
});

test('simultaneous retries of one upload keep one document, revision and successful audit', async () => {
  const savedChild = await child();
  const payload = upload();
  const results = await Promise.all([1, 2].map(() => request(app).post(url(savedChild.id)).send(payload)));
  expect(results.map(response => response.status)).toEqual([201, 201]);
  expect(results[0].body.document.id).toBe(results[1].body.document.id);
  expect(results[0].body.revision.id).toBe(results[1].body.revision.id);
  expect(results.filter(response => response.body.replayed)).toHaveLength(1);
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(1);
  expect(await documentAudits()).toHaveLength(1);
});

test('revision retry is checked before stale version rejection and never produces extra history or audits', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const endpoint = url(savedChild.id, original.document.id) + '/revisions';
  const payload = { requestId: randomUUID(), version: 1, changeNote: 'Synthetic corrected copy', file: file('png') };
  const first = await request(app).post(endpoint).send(payload);
  expect(first.status).toBe(201);
  const retry = await request(app).post(endpoint).send(payload);
  expect(retry.status).toBe(201);
  expect(retry.body).toMatchObject({ replayed: true, document: { id: original.document.id }, revision: { id: first.body.revision.id } });
  await request(app).post(endpoint).send({ requestId: randomUUID(), version: 2, file: file('jpg') });
  const oldRetry = await request(app).post(endpoint).send(payload);
  expect(oldRetry.status).toBe(201);
  expect(oldRetry.body.revision.id).toBe(first.body.revision.id);
  expect((await details(savedChild.id, original.document.id)).total).toBe(3);
  expect(await documentAudits()).toHaveLength(3);
  expect((await request(app).post(endpoint).send({ ...payload, file: file('jpg') })).status).toBe(409);
});

test('concurrent distinct revisions cannot overwrite each other from the same starting version', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const endpoint = url(savedChild.id, original.document.id) + '/revisions';
  const responses = await Promise.all(['png', 'jpg'].map(extension => request(app).post(endpoint).send({ requestId: randomUUID(), version: 1, file: file(extension) })));
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  expect((await details(savedChild.id, original.document.id)).total).toBe(2);
  expect(await documentAudits()).toHaveLength(2);
});

test('a permission removal that commits while a revision waits prevents the write', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  const { account } = request.credentials();
  await db.updateAccount(account.id, { role: 'editor', documentAccess: 'edit' });
  let release, entered, waiting;
  const reachedLock = new Promise(resolve => { entered = resolve; });
  const writeWaiting = new Promise(resolve => { waiting = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = db.withAuthLock(async () => {
    entered();
    await gate;
    await db.updateAccount(account.id, { documentAccess: 'none' });
  });
  await reachedLock;
  const originalLock = db.withAuthLock;
  const spy = jest.spyOn(db, 'withAuthLock').mockImplementation(callback => { waiting(); return originalLock(callback); });
  let timer;
  try {
    const pending = request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') }).then(response => response);
    await Promise.race([writeWaiting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The revision never reached its write lock.')), 10000); })]);
    release();
    await blocker;
    expect((await pending).status).toBe(403);
    await db.updateAccount(account.id, { documentAccess: 'edit' });
    expect((await details(savedChild.id, original.document.id)).total).toBe(1);
    expect(await documentAudits()).toHaveLength(1);
  } finally { clearTimeout(timer); release(); await blocker; spy.mockRestore(); }
});

test.each(['upload', 'revision', 'metadata'])('an audit failure rolls back %s with no private fields in diagnostics', async operation => {
  const savedChild = await child();
  const original = operation === 'upload' ? null : await create(savedChild.id);
  const beforeAudit = await documentAudits();
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic private disk path and document detail'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = operation === 'upload' ? await request(app).post(url(savedChild.id)).send(upload()) : operation === 'revision' ?
      await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') }) :
      await request(app).put(url(savedChild.id, original.document.id)).send({ version: 1, ...metadata, title: 'Must roll back' });
    expect(response.status).toBe(500);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ event: 'request_failed', requestId: response.headers['x-request-id'],
      method: operation === 'metadata' ? 'PUT' : 'POST', status: 500, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(response.body)).not.toMatch(/private disk path|Synthetic private notes|dataBase64/);
    expect(await documentAudits()).toEqual(beforeAudit);
    if (operation === 'upload') expect((await request(app).get(url(savedChild.id))).body.total).toBe(0);
    else {
      const current = await details(savedChild.id, original.document.id);
      expect(current).toMatchObject({ total: 1, document: { title: metadata.title, version: 1, currentRevisionId: original.revision.id } });
      expect((await binary(savedChild.id, original.document.id, original.revision.id)).body).toEqual(fixtures.pdf);
    }
  } finally { audit.mockRestore(); log.mockRestore(); }
});

test('ended enrollment retains documents and allows an authorized updated version', async () => {
  const savedChild = await child();
  const original = await create(savedChild.id);
  expect((await request(app).put('/api/children/' + savedChild.id + '/enrollment').send({ active: false })).status).toBe(200);
  expect((await request(app).get(url(savedChild.id))).body.total).toBe(1);
  expect((await binary(savedChild.id, original.document.id, original.revision.id)).body).toEqual(fixtures.pdf);
  const revised = await request(app).post(url(savedChild.id, original.document.id) + '/revisions').send({ requestId: randomUUID(), version: 1, file: file('png') });
  expect(revised.status).toBe(201);
  expect((await details(savedChild.id, original.document.id)).total).toBe(2);
  expect((await db.getChildById(savedChild.id)).active).toBe(false);
});
