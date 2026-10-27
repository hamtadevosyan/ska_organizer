const { createHash, randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const fixture = require('./helpers/authenticatedRequest');

function statement(content = Buffer.from('Synthetic private CCRC statement\n'), extra = {}) {
  return { id: randomUUID(), fingerprint: createHash('sha256').update(content).digest('hex'), filename: 'synthetic-statement.pdf',
    contentType: 'application/pdf', byteLength: content.length, content,
    data: { status: 'draft', extraction: { pages: [{ page: 1, text: 'Synthetic child; care October; paid November' }] },
      review: null, requests: [], history: [], postedPayments: [] }, version: 1, ...extra };
}

test('statement originals, nested review data and source fingerprints remain detached from caller mutations', async () => {
  const content = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
  const input = statement(content), originalData = structuredClone(input.data), originalContent = Buffer.from(content);
  expect(await db.getCcrcStatement(input.id)).toBeNull();
  const saved = await db.saveCcrcStatement(input);
  expect(saved).toMatchObject({ id: input.id, fingerprint: input.fingerprint, byteLength: 1024, version: 1, data: originalData });
  expect(Buffer.isBuffer(saved.content)).toBe(true); expect(saved.content.equals(originalContent)).toBe(true);
  input.content.fill(7); input.data.extraction.pages[0].text = 'Modified input';
  saved.content.fill(8); saved.data.extraction.pages[0].text = 'Modified output';
  const reopened = await db.getCcrcStatement(input.id);
  expect(reopened.data).toEqual(originalData); expect(reopened.content.equals(originalContent)).toBe(true);
  const matching = await db.getCcrcStatementByFingerprint(input.fingerprint);
  expect(matching.id).toBe(input.id); matching.content.fill(9);
  expect((await db.getCcrcStatement(input.id)).content.equals(originalContent)).toBe(true);
  const list = await db.listCcrcStatements();
  expect(list).toHaveLength(1); expect(list[0]).not.toHaveProperty('content');
  list[0].data.extraction.pages[0].text = 'Modified list';
  expect((await db.getCcrcStatement(input.id)).data).toEqual(originalData);
});

test('compare-and-swap serializes first creation and rejects stale edits without changing the saved original', async () => {
  const first = statement(), second = statement(Buffer.from('A different original'), { id: first.id });
  const result = await Promise.allSettled([db.saveCcrcStatement(first), db.saveCcrcStatement(second)]);
  expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(result.find(value => value.status === 'rejected').reason).toMatchObject({ status: 409, code: 'CCRC_STATEMENT_CONFLICT' });
  const before = await db.getCcrcStatement(first.id);
  const changed = await db.saveCcrcStatement({ id: before.id, data: { ...before.data, review: { totalCents: 100001 } }, version: 2 }, 1);
  expect(changed).toMatchObject({ id: before.id, fingerprint: before.fingerprint, filename: before.filename,
    byteLength: before.byteLength, createdAt: before.createdAt, version: 2 });
  expect(changed.content.equals(before.content)).toBe(true);
  await expect(db.saveCcrcStatement({ id: before.id, data: {}, version: 2 }, 1)).rejects.toMatchObject({ status: 409, code: 'CCRC_STATEMENT_CONFLICT' });
  expect(await db.getCcrcStatement(first.id)).toEqual(changed);
});

test('payment source verification projects only identity and status without returning the original or extracted text', async () => {
  const source = statement(Buffer.alloc(5 * 1024 * 1024, 65));
  expect(await db.getCcrcStatementIdentity(source.id)).toBeNull();
  await db.saveCcrcStatement(source);
  const identity = await db.getCcrcStatementIdentity(source.id);
  expect(identity).toEqual({ id: source.id, fingerprint: source.fingerprint, status: 'draft' });
  identity.fingerprint = 'mutated';
  expect((await db.getCcrcStatementIdentity(source.id)).fingerprint).toBe(source.fingerprint);
  await db.saveCcrcStatement({ id: source.id, data: { ...source.data, status: 'posted' }, version: 2 }, 1);
  expect(await db.getCcrcStatementIdentity(source.id)).toEqual({ id: source.id, fingerprint: source.fingerprint, status: 'posted' });
});

test('concurrent uploads of the same bytes produce one immutable source and identify its existing statement', async () => {
  const first = statement(), second = { ...first, id: randomUUID(), filename: 'renamed-original.pdf' };
  const results = await Promise.allSettled([db.saveCcrcStatement(first), db.saveCcrcStatement(second)]);
  const winner = results.find(value => value.status === 'fulfilled').value;
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(value => value.status === 'rejected').reason).toMatchObject({ status: 409, code: 'CCRC_STATEMENT_DUPLICATE', statementId: winner.id });
  expect((await db.listCcrcStatements()).map(row => row.id)).toEqual([winner.id]);
  expect((await db.getCcrcStatementByFingerprint(first.fingerprint)).content.equals(first.content)).toBe(true);
});

test.each(['fingerprint', 'filename', 'contentType', 'byteLength', 'content'])('later edits cannot replace the immutable original %s', async field => {
  const saved = await db.saveCcrcStatement(statement());
  const changed = { fingerprint: 'a'.repeat(64), filename: 'different.pdf', contentType: 'image/png', byteLength: saved.byteLength + 1, content: Buffer.from('Different bytes') };
  await expect(db.saveCcrcStatement({ id: saved.id, data: {}, version: 2, [field]: changed[field] }, 1))
    .rejects.toMatchObject({ status: 400, code: 'CCRC_STATEMENT_INVALID' });
  expect(await db.getCcrcStatement(saved.id)).toEqual(saved);
});

test('outer transaction failure rolls back originals, review versions and audit entries together, including binary recovery', async () => {
  const first = await db.saveCcrcStatement(statement()), second = statement(Buffer.from('Second source'));
  const events = await db.listAudit({ actions: ['ccrc.synthetic'] });
  await expect(db.withAuthLock(async () => {
    await db.saveCcrcStatement({ id: first.id, data: { status: 'posted' }, version: 2 }, 1);
    await db.saveCcrcStatement(second);
    await db.appendAudit({ id: randomUUID(), actorId: fixture.credentials().account.id, actorUsername: 'Synthetic administrator',
      action: 'ccrc.synthetic', entityId: first.id, occurredAt: new Date() });
    throw new Error('Synthetic statement transaction failure');
  })).rejects.toThrow('Synthetic statement transaction failure');
  expect(await db.getCcrcStatement(first.id)).toEqual(first);
  expect(Buffer.isBuffer((await db.getCcrcStatement(first.id)).content)).toBe(true);
  expect(await db.getCcrcStatement(second.id)).toBeNull();
  expect(await db.listAudit({ actions: ['ccrc.synthetic'] })).toEqual(events);
  const next = await db.saveCcrcStatement({ ...(await db.getCcrcStatement(first.id)), data: { status: 'draft', recovered: true }, version: 2 }, 1);
  expect(next.content.equals(first.content)).toBe(true);
});

test('all statements are scanned in stable order without source bytes or a fifty-item cap', async () => {
  const ids = [];
  for (let index = 60; index >= 0; index--) {
    const input = statement(Buffer.from('Synthetic statement ' + index)); ids.push(input.id);
    await db.saveCcrcStatement(input);
  }
  const rows = await db.listCcrcStatements();
  expect(rows.map(row => row.id)).toEqual(ids.sort()); expect(rows).toHaveLength(61);
  expect(rows.every(row => !Object.hasOwn(row, 'content'))).toBe(true);
});

test('storage rejects non-JSON data, invalid versions and inconsistent source metadata atomically', async () => {
  const source = statement();
  const cyclic = {}; cyclic.self = cyclic;
  const badRows = [
    { id: 'not-a-uuid' }, { data: null }, { data: [] }, { data: cyclic }, { data: { amount: 1n } },
    { version: 0 }, { version: 1.5 }, { version: 2147483648 },
    { fingerprint: 'A'.repeat(64) }, { fingerprint: '0'.repeat(64) }, { fingerprint: undefined },
    { filename: '' }, { filename: '../private.pdf' }, { filename: 'path\\private.pdf' },
    { filename: 'name\n.pdf' }, { filename: 'a'.repeat(201) }, { contentType: 'text/html' },
    { byteLength: source.byteLength + 1 }, { content: source.content.toString('base64') },
    { content: Buffer.alloc(0), byteLength: 0 }, { content: Buffer.alloc(5 * 1024 * 1024 + 1), byteLength: 5 * 1024 * 1024 + 1 },
  ];
  for (const changes of badRows) await expect(db.saveCcrcStatement({ ...source, ...changes }, 0))
    .rejects.toMatchObject({ status: 400, code: 'CCRC_STATEMENT_INVALID' });
  await expect(db.saveCcrcStatement(source, 1)).rejects.toMatchObject({ status: 400 });
  expect(await db.listCcrcStatements()).toEqual([]);
});
