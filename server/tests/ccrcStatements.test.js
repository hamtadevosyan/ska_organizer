const { randomUUID, randomBytes } = require('node:crypto');
const { PNG } = require('pngjs');
const supertest = require('supertest');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const config = require('../auth/config');
const app = require('../index');
const service = require('../services/ccrcStatementsService');
const extraction = require('../services/ccrcStatementExtraction');
const billing = require('../services/billingService');
const time = require('../services/facilityTime');
const fixture = require('./helpers/authenticatedRequest');
const request = fixture(app), base = '/api/billing/statements';
const token = () => fixture.credentials().cookie.split('=')[1];
const payload = (version, values = {}) => ({ version, requestId: randomUUID(), ...values });
const plain = value => JSON.parse(JSON.stringify(value));
let child, month, today, sample, serial;
function file() {
  const image = new PNG({ width: 2, height: 2 }); image.data.fill(++serial);
  return { name: 'Synthetic CCRC.png', contentType: 'image/png', dataBase64: PNG.sync.write(image).toString('base64') };
}
async function api(method, path, body, status = 200) {
  const response = await request[method](path).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status >= 400 ? expect.anything() : undefined });
  return response.body.data;
}
async function newChild(firstName = 'Synthetic') {
  const entity = await db.createChild({ id: randomUUID(), firstName, lastName: 'CCRC child', dateOfBirth: '2022-05-06', active: true, roomId: null });
  await billing.profile(token(), entity.id, payload(0, { billingStart: month + '-01', billingEnd: null, effectiveMonth: month,
    monthlyCents: 120000, ccrcManaged: true, familyDueDay: 1, registrationCents: 0, enabled: true }));
  return entity;
}
async function upload(values = {}) { return api('post', base, { requestId: randomUUID(), file: file(), ...values }, 201); }
async function reviewed(detail, changes = {}, rowChanges = {}) {
  const option = detail.children.find(value => value.id === child.id);
  const review = { ...plain(detail.review), statementReference: detail.review.statementReference || 'STMT-' + serial, paymentReference: detail.review.paymentReference || 'CHECK-' + serial,
    paymentDate: today, pageCount: detail.extraction.pageCount || 1, pagesReviewed: [1], sourceReviewed: true,
    reconciliationReason: 'Administrator checked every synthetic source value.', duplicateReason: '',
    lines: detail.review.lines.map(line => ({ ...line, childId: child.id, childName: 'Synthetic CCRC child', serviceMonth: month,
      billingVersion: option.billingVersion, reviewed: true, ...rowChanges })), ...changes };
  return api('put', base + '/' + detail.id + '/review', payload(detail.version, { review }));
}
beforeEach(async () => {
  today = time.dateAt(); month = today.slice(0, 7); serial = 0; child = await newChild();
  sample = { pageCount: 1, pages: [{ number: 1, text: 'Synthetic statement for local review only.', method: 'text', warnings: [] }],
    statementReference: 'SYNTHETIC-STMT', paymentReference: 'SYNTHETIC-CHECK', paymentDate: today, totalCents: 100000,
    lines: [{ id: randomUUID(), page: 1, excerpt: 'Synthetic CCRC child | ' + month + ' | $1000.00', childName: 'Synthetic CCRC child',
      serviceMonth: month, paymentDate: today, amountCents: 100000, kind: 'payment', warnings: [] }], warnings: [], incomplete: false };
  jest.spyOn(extraction, 'extractStatement').mockImplementation(async () => plain(sample));
});
afterEach(() => jest.restoreAllMocks());

test('upload and partial review never change tuition; private source bytes round-trip exactly', async () => {
  const before = await db.getChildBillingRecord(child.id), original = file(), saved = await upload({ file: original });
  expect(saved).toMatchObject({ status: 'draft', version: 1, filename: original.name, totalCents: 100000, today });
  expect(saved.review.lines[0]).toMatchObject({ childId: '', reviewed: false }); expect(saved).not.toHaveProperty('content');
  const source = await request.get(base + '/' + saved.id + '/content');
  expect(source.status).toBe(200); expect(source.body).toEqual(Buffer.from(original.dataBase64, 'base64'));
  expect(source.headers['cache-control']).toContain('no-store'); expect(source.headers['content-disposition']).toContain('attachment');
  expect(source.headers['content-security-policy']).toContain('sandbox'); expect(source.headers['x-content-type-options']).toBe('nosniff');
  await api('put', base + '/' + saved.id + '/review', payload(saved.version, { review: saved.review }));
  expect(await db.getChildBillingRecord(child.id)).toEqual(before);
  const list = await api('get', base); expect(list.total).toBe(1); expect(list.items[0]).not.toHaveProperty('extraction'); expect(list.items[0]).not.toHaveProperty('content');
});
test('registration persists provenance and a pending parent remainder exactly once', async () => {
  const draft = await reviewed(await upload()), body = payload(draft.version), saved = await api('post', base + '/' + draft.id + '/post', body);
  expect(saved).toMatchObject({ status: 'posted', postedPayments: [{ childId: child.id, serviceMonth: month, amountCents: 100000, remainingCents: 20000, awaitingCcrc: true, allocation: 'applied' }] });
  const ledger = await billing.get(token(), child.id);
  expect(ledger.payments[0]).toMatchObject({ payer: 'ccrc', amountCents: 100000, date: today, serviceMonth: month,
    source: { statementId: saved.id, statementLineId: draft.review.lines[0].id, page: 1, fingerprint: saved.fingerprint, statementReported: true } });
  expect(ledger.charges.find(charge => charge.month === month)).toMatchObject({ status: 'awaiting_ccrc', outstandingCents: 20000, ccrcReview: null });
  expect((await api('post', base + '/' + draft.id + '/post', body)).version).toBe(saved.version);
  expect((await billing.get(token(), child.id)).payments).toHaveLength(1);
  expect((await db.listAudit({ actions: ['ccrc_statement.post'] })).length).toBe(1);
  await api('put', base + '/' + draft.id + '/review', payload(saved.version, { review: draft.review }), 409);
  await api('post', base + '/' + draft.id + '/cancel', payload(saved.version, { reason: 'Cannot remove posted source' }), 409);
});
test('service month and different row dates/references persist; all result rows show final atomic balances', async () => {
  const previous = time.addDays(month + '-01', -1).slice(0, 7), previousDay = time.addDays(today, -1);
  await billing.profile(token(), child.id, payload(1, { billingStart: previous + '-01', effectiveMonth: previous, billingEnd: null, monthlyCents: 120000, ccrcManaged: true, familyDueDay: 1, registrationCents: 0, enabled: true }));
  Object.assign(sample.lines[0], { serviceMonth: previous, paymentDate: previousDay, paymentReference: 'ROW-CHECK-1', amountCents: 60000 });
  sample.lines.push({ ...plain(sample.lines[0]), id: randomUUID(), amountCents: 40000, paymentDate: today, paymentReference: 'ROW-CHECK-2' });
  let draft = await reviewed(await upload(), {}, { serviceMonth: previous });
  const saved = await api('post', base + '/' + draft.id + '/post', payload(draft.version)), ledger = await billing.get(token(), child.id);
  expect(ledger.payments.map(payment => ({ date: payment.date, reference: payment.reference, serviceMonth: payment.serviceMonth })))
    .toEqual([{ date: previousDay, reference: 'ROW-CHECK-1', serviceMonth: previous }, { date: today, reference: 'ROW-CHECK-2', serviceMonth: previous }]);
  expect(saved.postedPayments.map(row => row.remainingCents)).toEqual([20000, 20000]); expect(new Set(saved.postedPayments.map(row => row.billingVersion)).size).toBe(1);
});
test('same source recovers a cancelled draft, which can reopen without a ledger write', async () => {
  const original = file(), requestId = randomUUID(); let first = await upload({ file: original, requestId });
  const recovered = await upload({ file: original }); expect(recovered.id).toBe(first.id); first = recovered; await api('post', base, { requestId, file: file() }, 409);
  const cancelled = await api('post', base + '/' + first.id + '/cancel', payload(first.version, { reason: 'Review later' }));
  const recoveredCancelled = await upload({ file: original }); expect(recoveredCancelled.status).toBe('cancelled'); expect((await api('post', base + '/' + first.id + '/reopen', payload(recoveredCancelled.version))).status).toBe('draft');
  expect((await billing.get(token(), child.id)).payments).toEqual([]);
});
test('changed request payloads and stale draft versions never overwrite prior work', async () => {
  const first = await upload(), body = payload(first.version, { review: first.review }), saved = await api('put', base + '/' + first.id + '/review', body);
  expect((await api('put', base + '/' + first.id + '/review', body)).version).toBe(saved.version);
  await api('put', base + '/' + first.id + '/review', { ...body, review: { ...body.review, duplicateReason: 'Changed content' } }, 409);
  await api('put', base + '/' + first.id + '/review', payload(first.version, { review: first.review }), 409);
});
test('omitted extracted rows, duplicate identities, unresolved pages, totals and future dates block posting', async () => {
  const first = await upload();
  await api('put', base + '/' + first.id + '/review', payload(first.version, { review: { ...first.review, lines: [] } }), 400);
  await api('put', base + '/' + first.id + '/review', payload(first.version, { review: { ...first.review, lines: [first.review.lines[0], first.review.lines[0]] } }), 400);
  for (const changes of [{ sourceReviewed: false }, { pagesReviewed: [] }, { totalCents: 99999 }, { paymentDate: time.addDays(today, 1) }]) {
    const current = await api('get', base + '/' + first.id), draft = await reviewed(current, changes);
    await api('post', base + '/' + first.id + '/post', payload(draft.version), 400);
  }
  expect((await billing.get(token(), child.id)).payments).toEqual([]);
});
test('negative adjustments are never coerced into payments; reviewed exclusions and net amounts reconcile exactly', async () => {
  sample.lines.push({ ...plain(sample.lines[0]), id: randomUUID(), kind: 'adjustment', amountCents: -5000, excerpt: 'Adjustment -$50.00' }); sample.totalCents = 95000;
  let draft = await upload(); const option = draft.children.find(row => row.id === child.id);
  const review = { ...draft.review, sourceReviewed: true, pagesReviewed: [1], reconciliationReason: 'Net paid amount checked against the source.',
    lines: draft.review.lines.map((line, index) => ({ ...line, childId: child.id, serviceMonth: month, billingVersion: option.billingVersion, reviewed: true,
      amountCents: index === 0 ? 95000 : -5000, action: index === 0 ? 'payment' : 'exclude', note: index ? 'Adjustment already reflected in net paid row.' : 'Net actual receipt after stated adjustment.' })) };
  draft = await api('put', base + '/' + draft.id + '/review', payload(draft.version, { review }));
  expect((await api('post', base + '/' + draft.id + '/post', payload(draft.version))).postedPayments).toHaveLength(1);
  expect((await billing.get(token(), child.id)).payments[0].amountCents).toBe(95000);
});
test('an audit failure rolls back every child ledger, source status and idempotency identity atomically', async () => {
  const other = await newChild('Other'); sample.lines[0].amountCents = 60000; sample.lines.push({ ...plain(sample.lines[0]), id: randomUUID(), amountCents: 40000 });
  let draft = await upload(); const review = { ...draft.review, sourceReviewed: true, pagesReviewed: [1], reconciliationReason: 'Checked source.',
    lines: draft.review.lines.map((line, index) => { const entity = index ? other : child; return { ...line, childId: entity.id, billingVersion: draft.children.find(row => row.id === entity.id).billingVersion, reviewed: true }; }) };
  draft = await api('put', base + '/' + draft.id + '/review', payload(draft.version, { review }));
  const snapshot = () => Promise.all([db.getChildBillingRecord(child.id), db.getChildBillingRecord(other.id), db.getCcrcStatement(draft.id)]), before = await snapshot(), original = db.appendAudit;
  const audit = jest.spyOn(db, 'appendAudit').mockImplementation(async event => { if (event.action === 'ccrc_statement.post') throw new Error('Synthetic audit storage failure'); return original(event); });
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {}), body = payload(draft.version);
  try { await api('post', base + '/' + draft.id + '/post', body, 500); } finally { audit.mockRestore(); logging.mockRestore(); }
  expect(await snapshot()).toEqual(before); expect((await api('post', base + '/' + draft.id + '/post', body)).postedPayments).toHaveLength(2);
});
test('a changed child billing snapshot rejects the whole saved review', async () => {
  const draft = await reviewed(await upload()), ledger = await billing.get(token(), child.id);
  await billing.payment(token(), child.id, payload(ledger.version, { payer: 'family', amountCents: 1, date: today, chargeId: ledger.charges[0].id }));
  await api('post', base + '/' + draft.id + '/post', payload(draft.version), 409);
  expect((await billing.get(token(), child.id)).payments).toHaveLength(1); expect((await api('get', base + '/' + draft.id)).status).toBe('draft');
});
test('alternate scan of the same referenced payment is blocked even if OCR changed the amount', async () => {
  const first = await reviewed(await upload()); await api('post', base + '/' + first.id + '/post', payload(first.version));
  sample.lines[0].amountCents = 90000; sample.totalCents = 90000; const second = await reviewed(await upload());
  expect(second.duplicateWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'exact', statementId: first.id })]));
  await api('post', base + '/' + second.id + '/post', payload(second.version), 409); expect((await billing.get(token(), child.id)).payments).toHaveLength(1);
});
test('same check with a nonoverlapping child line needs an attributed review instead of a blanket rejection', async () => {
  const first = await reviewed(await upload()); await api('post', base + '/' + first.id + '/post', payload(first.version)); const other = await newChild('Other');
  let next = await upload(); const option = next.children.find(row => row.id === other.id);
  next = await reviewed(next, { duplicateReason: 'Another source page contains a different child on the same check.' }, { childId: other.id, billingVersion: option.billingVersion });
  expect(next.duplicateWarnings[0].kind).toBe('possible'); expect((await api('post', base + '/' + next.id + '/post', payload(next.version))).status).toBe('posted');
});
test('manual receipts entered before statement importing are duplicate checked too', async () => {
  const ledger = await billing.get(token(), child.id);
  await billing.payment(token(), child.id, payload(ledger.version, { payer: 'ccrc', amountCents: 100000, date: today, reference: 'SYNTHETIC-CHECK', chargeId: ledger.charges[0].id }));
  const draft = await reviewed(await upload()); expect(draft.duplicateWarnings[0].kind).toBe('exact'); await api('post', base + '/' + draft.id + '/post', payload(draft.version), 409);
});
test('equal amount vouchers need distinct source evidence and an overall duplicate review reason', async () => {
  sample.lines[0].amountCents = 50000; sample.lines.push({ ...plain(sample.lines[0]), id: randomUUID(), excerpt: 'Second voucher $500.00' });
  let draft = await reviewed(await upload()); await api('post', base + '/' + draft.id + '/post', payload(draft.version), 400);
  draft = await reviewed(draft, { duplicateReason: 'Two separate vouchers printed on this statement.', lines: draft.review.lines.map((line, index) => ({ ...line, note: 'Verified voucher occurrence ' + (index + 1) })) });
  expect((await api('post', base + '/' + draft.id + '/post', payload(draft.version))).postedPayments).toHaveLength(2);
});
test('missing tuition needs explicit unapplied-credit consent and preserves service month provenance', async () => {
  const period = time.addDays(month + '-01', -1).slice(0, 7); let draft = await reviewed(await upload(), {}, { serviceMonth: period });
  await api('post', base + '/' + draft.id + '/post', payload(draft.version), 400);
  draft = await reviewed(draft, {}, { serviceMonth: period, allowUnappliedCredit: true, note: 'Received before tuition is entered.' });
  const saved = await api('post', base + '/' + draft.id + '/post', payload(draft.version));
  expect(saved.postedPayments[0]).toMatchObject({ allocation: 'unapplied', remainingCents: null, serviceMonth: period });
  expect((await billing.get(token(), child.id)).payments[0]).toMatchObject({ creditCents: 100000, serviceMonth: period, source: { serviceMonth: period } });
});
test('unavailable extraction leaves a manual draft without inventing amounts', async () => {
  extraction.extractStatement.mockRejectedValue(Object.assign(new Error('Synthetic missing tool'), { status: 503 }));
  expect(await upload()).toMatchObject({ status: 'draft', extraction: { incomplete: true, lines: [], totalCents: null }, review: { sourceReviewed: false, totalCents: null } });
  expect((await billing.get(token(), child.id)).payments).toEqual([]);
});
test('administrator access is rechecked after local extraction before source persistence', async () => {
  extraction.extractStatement.mockImplementation(async () => { await db.updateAccount(fixture.credentials().account.id, { role: 'editor' }); return plain(sample); });
  await api('post', base, { requestId: randomUUID(), file: file() }, 403); expect(await db.listCcrcStatements()).toEqual([]);
});
test.each(['editor', 'teacher', 'viewer'])('%s cannot read imports or parse their protected uploads', async role => {
  const draft = await upload(), sessionToken = randomBytes(32).toString('hex'), id = randomUUID(), root = await db.getAccount(fixture.credentials().account.id);
  await db.createAccount({ id, username: 'ccrc-' + role, displayName: 'Synthetic role', passwordHash: root.passwordHash, role, disabled: false, mustChangePassword: false, roomId: null, staffMemberId: null });
  await db.createSession({ id: auth.digest(sessionToken), accountId: id, createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + config.absoluteMs) });
  for (const path of [base, base + '/' + draft.id, base + '/' + draft.id + '/content']) expect((await supertest(app).get(path).set('Cookie', 'skao_session=' + sessionToken)).status).toBe(403);
  const before = extraction.extractStatement.mock.calls.length;
  expect((await supertest(app).post(base).set('Origin', fixture.origin).set('Cookie', 'skao_session=' + sessionToken).set('X-CSRF-Token', auth.csrfToken(sessionToken)).send({ malformed: true })).status).toBe(403);
  expect(extraction.extractStatement.mock.calls.length).toBe(before);
});
test('CSRF and origin are checked before body extraction and normal billing cannot spoof statement provenance', async () => {
  expect((await supertest(app).get(base)).status).toBe(401);
  expect((await supertest(app).post(base).set('Origin', fixture.origin).set('Cookie', fixture.credentials().cookie).send({})).status).toBe(403);
  expect((await supertest(app).post(base).set('Origin', 'http://untrusted.invalid').set('Cookie', fixture.credentials().cookie).set('X-CSRF-Token', fixture.credentials().csrf).send({})).status).toBe(403);
  expect((await request.post('/api/billing/children/' + child.id + '/payments').send(payload(1, { payer: 'ccrc', amountCents: 1, date: today, source: { statementId: randomUUID() } }))).status).toBe(400);
  expect(extraction.extractStatement).not.toHaveBeenCalled();
});
test('the same upload UUID cannot race different source bytes across the extraction gap', async () => {
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  extraction.extractStatement.mockImplementation(async () => { entered++; if (entered === 1) await gate; return plain(sample); });
  const requestId = randomUUID(), first = service.upload(token(), { requestId, file: file() });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  const second = await service.upload(token(), { requestId, file: file() }); release();
  await expect(first).rejects.toMatchObject({ status: 409, code: 'CCRC_STATEMENT_REQUEST_CONFLICT' });
  expect((await db.listCcrcStatements()).map(row => row.id)).toEqual([second.id]);
});
test('a cancelled read never retains source bytes or touches tuition', async () => {
  const controller = new AbortController(); extraction.extractStatement.mockImplementation(async () => { controller.abort(); return plain(sample); });
  await expect(service.upload(token(), { requestId: randomUUID(), file: file() }, { signal: controller.signal })).rejects.toMatchObject({ status: 400 });
  expect(await db.listCcrcStatements()).toEqual([]);
});

test('a new upload UUID recovered by source hash is reserved against later different bytes', async () => {
  const original = file(); await upload({ file: original });
  const requestId = randomUUID(), recovered = await upload({ file: original, requestId });
  await api('post', base, { requestId, file: file() }, 409);
  expect((await db.listCcrcStatements()).map(row => row.id)).toEqual([recovered.id]);
});

test('an extraction over the bounded row capacity is rejected wholly rather than dropping the last rows', async () => {
  sample.lines = Array.from({ length: 201 }, () => ({ ...plain(sample.lines[0]), id: randomUUID() }));
  await api('post', base, { requestId: randomUUID(), file: file() }, 413);
  expect(await db.listCcrcStatements()).toEqual([]); expect((await billing.get(token(), child.id)).payments).toEqual([]);
});

test('long extracted suggestions remain fully retained while their bounded review draft is immediately savable', async () => {
  sample.statementReference = 'S'.repeat(220); sample.paymentReference = 'P'.repeat(220);
  Object.assign(sample.lines[0], { excerpt: 'X'.repeat(2400), childName: 'N'.repeat(500), entryReference: 'E'.repeat(200), paymentReference: 'R'.repeat(200) });
  const draft = await upload();
  expect(draft.extraction.lines[0].excerpt).toHaveLength(2400); expect(draft.extraction.lines[0].childName).toHaveLength(500);
  expect(draft.extraction.warnings.join(' ')).toContain('shortened');
  expect(draft.review.statementReference).toHaveLength(160); expect(draft.review.paymentReference).toHaveLength(160);
  expect(draft.review.lines[0]).toMatchObject({ excerpt: 'X'.repeat(2000), childName: 'N'.repeat(255), entryReference: 'E'.repeat(160), paymentReference: 'R'.repeat(160) });
  const saved = await api('put', base + '/' + draft.id + '/review', payload(draft.version, { review: draft.review }));
  expect(saved.status).toBe('draft'); expect((await billing.get(token(), child.id)).payments).toEqual([]);
});
test('the bounded protected review parser accepts valid 200-row Unicode drafts larger than 600 KB', async () => {
  const draft = await upload(), prototype = draft.review.lines[0];
  const review = { ...draft.review, lines: Array.from({ length: 200 }, (_, index) => ({ ...prototype,
    id: index ? randomUUID() : prototype.id, excerpt: 'é'.repeat(2000), note: 'é'.repeat(2000) })) };
  const body = payload(draft.version, { review }); expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(600 * 1024);
  const saved = await api('put', base + '/' + draft.id + '/review', body);
  expect(saved.review.lines).toHaveLength(200); expect(saved.review.lines.at(-1).note).toBe('é'.repeat(2000));
  expect((await billing.get(token(), child.id)).payments).toEqual([]);
});
