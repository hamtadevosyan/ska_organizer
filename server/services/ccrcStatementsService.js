const { randomUUID, createHash } = require('node:crypto');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const time = require('./facilityTime');
const math = require('./billingMath');
const billing = require('./billingService');
const v = require('./childDocumentValidation');
const extractionService = require('./ccrcStatementExtraction');

const invalid = (message, field = 'statement', status = 400, code = 'CCRC_STATEMENT_INVALID') => Object.assign(auth.problem(message, status, code), { fields: { [field]: message } });
const text = (value, field, max = 1000, required = false) => v.text(value, field, max, { required });
const stamp = actor => ({ actorId: actor.id, actorName: actor.displayName || actor.username, at: new Date().toISOString() });
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
const name = child => [child.firstName, child.lastName].filter(Boolean).join(' ') || child.name || child.id;
const uuid = (value, field = 'id') => { try { return v.requestId(value); } catch { throw invalid('Choose a valid statement or line identifier.', field); } };
const date = (value, field = 'paymentDate') => { try { return time.validateDate(value); } catch { throw invalid('Enter a real calendar date.', field); } };
const clone = value => JSON.parse(JSON.stringify(value));
async function administrator(token) {
  const actor = await auth.sessionAccount(token, { touch: true });
  auth.operationalPermission(actor, false);
  if (actor.role !== 'admin') throw auth.problem('Administrator billing access is required.', 403, 'FORBIDDEN');
  return actor;
}
async function rowById(id) {
  const row = await db.getCcrcStatement(uuid(id));
  if (!row) throw auth.problem('CCRC statement not found.', 404, 'CCRC_STATEMENT_NOT_FOUND');
  return row;
}
function summary(row) {
  return { id: row.id, version: row.version, status: row.data.status, filename: row.filename, contentType: row.contentType,
    byteLength: row.byteLength, createdAt: row.createdAt, updatedAt: row.updatedAt, statementReference: row.data.review?.statementReference || '',
    paymentDate: row.data.review?.paymentDate || null, totalCents: row.data.review?.totalCents ?? null, lineCount: row.data.review?.lines.length || 0 };
}
async function children() {
  const records = new Map((await db.listChildBillingRecords()).map(row => [row.childId, row]));
  const result = [];
  for (let page = 1;; page++) {
    const batch = await db.listChildren({ page, pageSize: 100 });
    for (const child of batch) {
      const row = records.get(child.id);
      result.push({ id: child.id, name: name(child), active: child.active !== false, billingVersion: row?.version || 0,
        charges: (row?.data.charges || []).filter(charge => charge.kind === 'monthly').map(charge => {
          const view = math.chargeView(charge, row.data.payments, time.dateAt());
          return { id: view.id, month: view.month, settlementMode: view.settlementMode || null, amountCents: view.amountCents, outstandingCents: view.outstandingCents };
        }) });
    }
    if (batch.length < 100) break;
  }
  return result;
}
const paymentRows = review => (review?.lines || []).filter(line => line.action === 'payment' && line.childId && line.serviceMonth);
const identity = (reference, paymentDate, childId, month, entryReference = '') => hash([normalize(reference), paymentDate, childId, month, normalize(entryReference)]);
function identities(review) {
  return paymentRows(review).map(line => ({ key: identity(line.paymentReference || review.paymentReference, line.paymentDate || review.paymentDate, line.childId, line.serviceMonth, line.entryReference), lineId: line.id,
    childId: line.childId, serviceMonth: line.serviceMonth, amountCents: line.amountCents, paymentDate: line.paymentDate || review.paymentDate,
    paymentReference: normalize(line.paymentReference || review.paymentReference), entryReference: normalize(line.entryReference) }));
}
async function duplicateWarnings(row) {
  const warnings = [], review = row.data.review;
  const own = identities(review);
  if (!own.length) return warnings;
  for (const other of await db.listCcrcStatements()) {
    if (other.id === row.id || other.data.status !== 'posted') continue;
    const prior = other.data.postedIdentities || identities(other.data.review);
    const exact = own.some(line => prior.some(old => line.key === old.key));
    const possible = own.some(line => prior.some(old => old.paymentReference === line.paymentReference && old.paymentDate === line.paymentDate ||
      old.childId === line.childId && old.serviceMonth === line.serviceMonth && old.paymentDate === line.paymentDate && old.amountCents === line.amountCents));
    if (exact || possible) warnings.push({ kind: exact ? 'exact' : 'possible', statementId: other.id,
      message: exact ? 'A payment line with this payment reference, date, child and service month was already registered. Exclude the earlier line; do not register it again.' : 'This statement may overlap an earlier payment. Check the original and explain any separate payment before registering.' });
  }
  // Existing manual CCRC receipts are also financial history. An import must
  // not silently repeat a receipt that was entered before statement importing.
  for (const childId of new Set(own.map(line => line.childId))) {
    const ledger = await db.getChildBillingRecord(childId);
    for (const payment of ledger?.data.payments || []) {
      if (payment.payer !== 'ccrc' || payment.source?.statementId === row.id) continue;
      if (payment.source?.statementId) continue; // Already covered by durable posted import identities above.
      const months = new Set([payment.serviceMonth, ...payment.allocations.map(allocation => ledger.data.charges.find(charge => charge.id === allocation.chargeId)?.month)].filter(Boolean));
      for (const line of own.filter(value => value.childId === childId)) {
        if (!months.has(line.serviceMonth) || payment.date !== line.paymentDate) continue;
        const knownReference = normalize(payment.reference), exact = knownReference && knownReference === line.paymentReference;
        if (exact || payment.amountCents === line.amountCents) warnings.push({ kind: exact ? 'exact' : 'possible', statementId: null,
          childId, paymentId: payment.id, message: exact ? 'An existing CCRC ledger receipt uses this payment reference, date, child and service month. Review or reverse the existing receipt rather than importing it twice.' : 'An existing CCRC receipt has the same child, service month, date and amount. Check whether this is a separate payment and explain your decision.' });
      }
    }
  }
  const groups = new Map();
  for (const line of paymentRows(review)) {
    const key = JSON.stringify([line.childId, line.serviceMonth, line.amountCents]);
    const group = groups.get(key) || []; group.push(line); groups.set(key, group);
  }
  if ([...groups.values()].some(group => group.length > 1)) warnings.push({ kind: 'possible', statementId: row.id,
    message: 'More than one row has the same child, service month and amount. Verify distinct vouchers or source occurrences and explain them in each row note.' });
  return warnings;
}
async function detail(row) {
  return { ...summary(row), today: time.dateAt(), timeZone: time.timeZone(), fingerprint: row.fingerprint,
    extraction: row.data.extraction, review: row.data.review, children: await children(), duplicateWarnings: await duplicateWarnings(row),
    postedPayments: row.data.postedPayments || [], history: row.data.history || [] };
}
function initialReview(extraction) {
  let shortened = false;
  const bounded = (value, maximum) => {
    const original = String(value || '');
    // Preserve full source text separately. Only the editable suggestion is
    // bounded, and never split a UTF-16 surrogate pair at the field boundary.
    const result = original.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, maximum).replace(/[\ud800-\udbff]$/, '');
    if (result !== original) shortened = true;
    return result;
  };
  const review = { statementReference: bounded(extraction.statementReference, 160), paymentReference: bounded(extraction.paymentReference || extraction.statementReference, 160),
    paymentDate: extraction.paymentDate || '', totalCents: extraction.totalCents ?? null, pageCount: extraction.pageCount || null,
    pagesReviewed: [], sourceReviewed: false, reconciliationReason: '', duplicateReason: '', lines: (extraction.lines || []).map(line => ({
      id: uuid(line.id), page: line.page, excerpt: bounded(line.excerpt, 2000), childId: '', childName: bounded(line.childName, 255), serviceMonth: line.serviceMonth || '',
      amountCents: line.amountCents ?? null, action: line.kind === 'payment' && line.amountCents > 0 ? 'payment' : 'exclude', note: '', reviewed: false,
      billingVersion: null, entryReference: bounded(line.entryReference, 160), paymentDate: line.paymentDate || '', paymentReference: bounded(line.paymentReference, 160), allowUnappliedCredit: false,
    })) };
  if (shortened) {
    extraction.warnings = [...new Set([...(extraction.warnings || []), 'Some text suggestions were shortened to fit the review fields. Check the full original page text and explain any corrected references or rows before registering.'])];
  }
  return review;
}
function event(data, actor, type, extra = {}) { data.history.push({ id: randomUUID(), type, ...stamp(actor), ...extra }); }
async function save(row, actor, action) {
  if (row.data.requests.length > 1000 || row.data.history.length > 5000) throw invalid('This statement has too many revisions. Retain it and contact the administrator.', 'statement', 409);
  const saved = await db.saveCcrcStatement({ ...row, version: row.version + 1 }, row.version);
  await auth.audit(actor, 'ccrc_statement.' + action, row.id);
  return saved;
}
async function recoverUpload(row, actor, requestId) {
  const fingerprint = hash(['upload', row.fingerprint]);
  const prior = row.data.requests.find(request => request.id === requestId);
  if (prior && prior.fingerprint !== fingerprint) throw invalid('This request identifier was already used for a different operation.', 'requestId', 409, 'CCRC_STATEMENT_REQUEST_CONFLICT');
  if (!prior) {
    row.data.requests.push({ id: requestId, fingerprint });
    event(row.data, actor, 'duplicate_upload');
    row = await save(row, actor, 'duplicate_upload');
  } else await auth.audit(actor, 'ccrc_statement.duplicate_upload', row.id);
  return detail(row);
}
exports.upload = async (token, payload, { signal } = {}) => {
  v.object(payload, ['requestId', 'file'], 'statement'); const requestId = uuid(payload.requestId, 'requestId');
  await db.withAuthLock(() => administrator(token));
  const file = extractionService.validateStatementFile(payload.file);
  const existing = await db.withAuthLock(async () => {
    const actor = await administrator(token);
    const previous = (await db.listCcrcStatements()).find(row => row.data.requests.some(request => request.id === requestId));
    if (previous && previous.data.requests.find(request => request.id === requestId).fingerprint !== hash(['upload', file.sha256])) throw invalid('This upload request was already used for a different file.', 'requestId', 409, 'CCRC_STATEMENT_REQUEST_CONFLICT');
    const found = await db.getCcrcStatementByFingerprint(file.sha256);
    if (found) return recoverUpload(found, actor, requestId);
    return null;
  });
  if (existing) return existing;
  let extraction;
  try { extraction = await extractionService.extractStatement(file, { signal }); }
  catch (error) {
    if (signal?.aborted || error.status === 400 || error.status === 413 || error.status === 429) throw error;
    extraction = { pageCount: file.contentType === 'application/pdf' ? null : 1, pages: [], lines: [], statementReference: null, paymentReference: null,
      paymentDate: null, totalCents: null, incomplete: true, warnings: ['Automatic reading was unavailable. Open the original, enter every payment and verify all pages before registering.'] };
  }
  if (signal?.aborted) throw invalid('Statement reading was cancelled.', 'file');
  if ((extraction.lines || []).length > 200) throw invalid('This statement contains more than 200 candidate rows. Split it into complete, clearly identified source parts; no rows were imported or silently omitted.', 'file', 413, 'CCRC_STATEMENT_TOO_MANY_ROWS');
  return db.withAuthLock(async () => {
    const actor = await administrator(token);
    if (signal?.aborted) throw invalid('Statement reading was cancelled.', 'file');
    // Another worker may have completed this request while local extraction
    // ran outside the authorization lock. Recheck its identity before writing.
    const priorUpload = (await db.listCcrcStatements()).find(row => row.data.requests.some(request => request.id === requestId));
    if (priorUpload && priorUpload.data.requests.find(request => request.id === requestId).fingerprint !== hash(['upload', file.sha256])) throw invalid('This upload request was already used for a different file.', 'requestId', 409, 'CCRC_STATEMENT_REQUEST_CONFLICT');
    const found = await db.getCcrcStatementByFingerprint(file.sha256);
    if (found) return recoverUpload(found, actor, requestId);
    const data = { status: 'draft', extraction, review: initialReview(extraction), requests: [{ id: requestId, fingerprint: hash(['upload', file.sha256]) }],
      history: [], postedPayments: [] };
    event(data, actor, 'uploaded', { fingerprint: file.sha256 });
    const row = await db.saveCcrcStatement({ id: randomUUID(), fingerprint: file.sha256, filename: file.name, contentType: file.contentType,
      byteLength: file.byteLength, content: file.buffer, data, version: 1 }, 0);
    await auth.audit(actor, 'ccrc_statement.upload', row.id);
    return detail(row);
  });
};
exports.list = token => db.withAuthLock(async () => {
  const actor = await administrator(token); await auth.audit(actor, 'ccrc_statement.list');
  const rows = await db.listCcrcStatements();
  return { items: rows.map(summary).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id)), total: rows.length, today: time.dateAt(), timeZone: time.timeZone() };
});
exports.get = (token, id) => db.withAuthLock(async () => { const actor = await administrator(token), row = await rowById(id); await auth.audit(actor, 'ccrc_statement.view', row.id); return detail(row); });
exports.content = (token, id) => db.withAuthLock(async () => { const actor = await administrator(token), row = await rowById(id); await auth.audit(actor, 'ccrc_statement.content', row.id); return { filename: row.filename, contentType: row.contentType, content: row.content }; });
async function mutate(token, id, type, payload, keys, change) {
  return db.withAuthLock(async () => {
    const actor = await administrator(token), row = await rowById(id);
    v.object(payload, ['version', 'requestId', ...keys], 'statement');
    const requestId = uuid(payload.requestId, 'requestId'), fingerprint = hash([type, Object.fromEntries(Object.entries(payload).filter(([key]) => !['version', 'requestId'].includes(key)))]);
    const prior = row.data.requests.find(request => request.id === requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw invalid('This request identifier was already used for different statement details.', 'requestId', 409, 'CCRC_STATEMENT_REQUEST_CONFLICT');
      return detail(row);
    }
    if (payload.version !== row.version) throw invalid('This statement changed. Refresh before saving.', 'version', 409, 'CCRC_STATEMENT_CONFLICT');
    await change(row, actor);
    row.data.requests.push({ id: requestId, fingerprint });
    return detail(await save(row, actor, type));
  });
}
function reviewShape(value) {
  v.object(value, ['statementReference', 'paymentReference', 'paymentDate', 'totalCents', 'pageCount', 'pagesReviewed', 'sourceReviewed', 'reconciliationReason', 'duplicateReason', 'lines'], 'review');
  const review = { statementReference: text(value.statementReference, 'statementReference', 160), paymentReference: text(value.paymentReference, 'paymentReference', 160),
    paymentDate: text(value.paymentDate, 'paymentDate', 10), totalCents: value.totalCents ?? null, pageCount: value.pageCount ?? null,
    sourceReviewed: value.sourceReviewed === true, reconciliationReason: text(value.reconciliationReason, 'reconciliationReason', 2000), duplicateReason: text(value.duplicateReason, 'duplicateReason', 2000) };
  if (review.paymentDate) date(review.paymentDate);
  if (review.totalCents !== null && (!Number.isSafeInteger(review.totalCents) || review.totalCents < 0 || review.totalCents > 100000000000)) throw invalid('Enter an exact statement total in cents.', 'totalCents');
  if (review.pageCount !== null && (!Number.isSafeInteger(review.pageCount) || review.pageCount < 1 || review.pageCount > 12)) throw invalid('Review a statement with 1 to 12 pages.', 'pageCount');
  if (!Array.isArray(value.pagesReviewed) || value.pagesReviewed.length > 12 || value.pagesReviewed.some(page => !Number.isInteger(page) || page < 1 || page > 12) || new Set(value.pagesReviewed).size !== value.pagesReviewed.length) throw invalid('Select each reviewed source page once.', 'pagesReviewed');
  review.pagesReviewed = [...value.pagesReviewed].sort((a, b) => a - b);
  if (!Array.isArray(value.lines) || value.lines.length > 200) throw invalid('Review no more than 200 statement rows.', 'lines');
  const ids = new Set();
  review.lines = value.lines.map((line, index) => {
    v.object(line, ['id', 'page', 'excerpt', 'childId', 'childName', 'serviceMonth', 'amountCents', 'action', 'note', 'reviewed', 'billingVersion', 'entryReference', 'paymentDate', 'paymentReference', 'allowUnappliedCredit'], 'line');
    const id = uuid(line.id, 'lineId'); if (ids.has(id)) throw invalid('Each source row must appear only once.', 'lines'); ids.add(id);
    if (!Number.isSafeInteger(line.page) || line.page < 1 || line.page > 12) throw invalid('Choose the source page for row ' + (index + 1) + '.', 'page');
    if (!['payment', 'exclude'].includes(line.action)) throw invalid('Choose whether this row is a payment or is excluded.', 'action');
    if (line.amountCents != null && (!Number.isSafeInteger(line.amountCents) || Math.abs(line.amountCents) > 1000000000)) throw invalid('Enter an exact amount for each row.', 'amountCents');
    if (line.billingVersion != null && (!Number.isSafeInteger(line.billingVersion) || line.billingVersion < 0)) throw invalid('Refresh the selected child billing version.', 'billingVersion');
    return { id, page: line.page, excerpt: text(line.excerpt, 'excerpt', 2000), childId: text(line.childId, 'childId', 255), childName: text(line.childName, 'childName', 255),
      serviceMonth: text(line.serviceMonth, 'serviceMonth', 7), amountCents: line.amountCents ?? null, action: line.action, note: text(line.note, 'note', 2000),
      reviewed: line.reviewed === true, billingVersion: line.billingVersion ?? null, entryReference: text(line.entryReference, 'entryReference', 160), paymentDate: text(line.paymentDate, 'paymentDate', 10), paymentReference: text(line.paymentReference, 'paymentReference', 160), allowUnappliedCredit: line.allowUnappliedCredit === true };
  });
  return review;
}
exports.review = (token, id, payload) => mutate(token, id, 'review', payload, ['review'], async (row, actor) => {
  if (row.data.status !== 'draft') throw invalid('Only a draft statement can be edited.', 'statement', 409);
  const review = reviewShape(payload.review), ids = new Set(review.lines.map(line => line.id));
  if (row.data.extraction.lines.some(line => !ids.has(line.id))) throw invalid('Keep every extracted source row. Exclude an unwanted row with a note instead of deleting it.', 'lines');
  row.data.review = review;
  event(row.data, actor, 'review_saved', { lineCount: review.lines.length });
});
function validation(row) {
  const review = row.data.review, extraction = row.data.extraction;
  if (!review.statementReference || !normalize(review.statementReference) || !review.paymentReference || !normalize(review.paymentReference)) throw invalid('Enter the statement and payment reference printed on the source.', 'paymentReference');
  if (!review.paymentDate || date(review.paymentDate) > time.dateAt()) throw invalid('Choose the actual payment date, no later than today.', 'paymentDate');
  if (!review.sourceReviewed || !review.pageCount || review.pagesReviewed.length !== review.pageCount || Array.from({ length: review.pageCount }, (_, index) => index + 1).some(page => !review.pagesReviewed.includes(page))) throw invalid('Check the original and confirm every source page before registering payments.', 'pagesReviewed');
  if (extraction.pageCount && extraction.pageCount !== review.pageCount) throw invalid('The reviewed page count must match the uploaded source.', 'pageCount');
  if (!review.lines.length || review.lines.some(line => !line.reviewed || line.page > review.pageCount || !line.excerpt)) throw invalid('Review every row and its source page/excerpt.', 'lines');
  let total = 0, requiresReason = extraction.incomplete || !extraction.lines.length || (extraction.warnings || []).length > 0 || extraction.totalCents !== review.totalCents || extraction.paymentDate !== review.paymentDate || extraction.statementReference !== review.statementReference || (extraction.paymentReference && extraction.paymentReference !== review.paymentReference);
  const sourceById = new Map(extraction.lines.map(line => [line.id, line]));
  for (const line of review.lines) {
    const original = sourceById.get(line.id);
    if (line.paymentDate && date(line.paymentDate) > time.dateAt()) throw invalid('Each receipt date must be no later than today.', 'paymentDate');
    if (original?.paymentDate && original.paymentDate !== (line.paymentDate || review.paymentDate)) requiresReason = true;
    if (original?.paymentReference && original.paymentReference !== (line.paymentReference || review.paymentReference)) requiresReason = true;
    if (!original || original.amountCents !== line.amountCents || original.serviceMonth !== line.serviceMonth || original.page !== line.page || original.excerpt !== line.excerpt || original.kind !== 'payment') requiresReason = true;
    if (line.action === 'exclude') { if (!line.note) throw invalid('Explain why every excluded row is not a received payment.', 'note'); requiresReason = true; continue; }
    if (!line.childId || !line.serviceMonth || !Number.isSafeInteger(line.amountCents) || line.amountCents <= 0 || line.billingVersion === null) throw invalid('Choose the child, service month, positive payment amount and current billing version for every payment.', 'lines');
    math.month(line.serviceMonth, 'serviceMonth');
    total += line.amountCents;
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total !== review.totalCents) throw invalid('The included received payments must add up exactly to the reviewed statement total. Correct missing rows or net amounts before registering.', 'totalCents');
  if (requiresReason && !review.reconciliationReason) throw invalid('Explain the manual entries, extraction issues, excluded rows or corrected source values before registering.', 'reconciliationReason');
  const groups = new Map();
  for (const line of paymentRows(review)) {
    const key = JSON.stringify([line.childId, line.serviceMonth, line.amountCents]); const group = groups.get(key) || []; group.push(line); groups.set(key, group);
  }
  for (const group of groups.values()) if (group.length > 1) {
    const entries = group.map(line => normalize(line.entryReference));
    const distinctEntries = entries.every(Boolean) && new Set(entries).size === entries.length;
    if (!distinctEntries && (!review.duplicateReason || group.some(line => !line.note) || new Set(group.map(line => normalize(line.note))).size !== group.length)) throw invalid('Verify each repeated amount using distinct voucher references, or distinct source notes and an overall duplicate-review reason.', 'duplicateReason');
  }
}
const paymentRequestId = (statementId, lineId) => {
  const bytes = createHash('sha256').update(statementId + ':' + lineId).digest().subarray(0, 16); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.toString('hex'); return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
};
exports.post = (token, id, payload) => mutate(token, id, 'post', payload, [], async (row, actor) => {
  if (row.data.status !== 'draft') throw invalid('This statement has already been registered or cancelled.', 'statement', 409);
  validation(row);
  const warnings = await duplicateWarnings(row);
  if (warnings.some(warning => warning.kind === 'exact')) throw invalid('An included payment line was already registered. Exclude the duplicate row with a reason rather than registering it again.', 'duplicates', 409, 'CCRC_STATEMENT_DUPLICATE_PAYMENT');
  if (warnings.length && !row.data.review.duplicateReason) throw invalid('Check the possible duplicate payments and record why these are separate receipts.', 'duplicateReason');
  const lines = paymentRows(row.data.review), ledgers = new Map(), versions = new Map();
  for (const line of lines) {
    const child = await db.getChildById(line.childId); if (!child) throw invalid('Choose an existing child for every payment.', 'childId');
    if (!ledgers.has(child.id)) { const ledger = await db.getChildBillingRecord(child.id); ledgers.set(child.id, ledger); versions.set(child.id, ledger?.version || 0); }
    if (line.billingVersion !== versions.get(child.id)) throw invalid('A selected child billing record changed. Refresh the statement and review the child balances before registering.', 'billingVersion', 409, 'BILLING_CONFLICT');
    const target = ledgers.get(child.id)?.data.charges.find(charge => charge.kind === 'monthly' && charge.month === line.serviceMonth && charge.settlementMode === 'ccrc_actual');
    if (!target && (!line.allowUnappliedCredit || !line.note)) throw invalid('No actual-CCRC tuition charge exists for this service month. Set up the charge first, or explicitly record this as unapplied CCRC credit with a note.', 'allowUnappliedCredit');
  }
  const posted = [];
  for (const line of lines) {
    const ledger = await db.getChildBillingRecord(line.childId);
    const target = ledger?.data.charges.find(charge => charge.kind === 'monthly' && charge.month === line.serviceMonth && charge.settlementMode === 'ccrc_actual');
    const source = { statementId: row.id, statementLineId: line.id, page: line.page, excerpt: line.excerpt, fingerprint: row.fingerprint,
      statementReference: row.data.review.statementReference, paymentReference: line.paymentReference || row.data.review.paymentReference, entryReference: line.entryReference,
      serviceMonth: line.serviceMonth, statementReported: true };
    const result = await billing.importPayment(token, line.childId, { version: ledger?.version || 0, requestId: paymentRequestId(row.id, line.id), payer: 'ccrc',
      amountCents: line.amountCents, date: line.paymentDate || row.data.review.paymentDate, method: 'ccrc-statement', reference: line.paymentReference || row.data.review.paymentReference, chargeId: target?.id || null, source });
    const payment = result.payments.find(value => value.source?.statementLineId === line.id && value.source?.statementId === row.id);
    if (!payment) throw new Error('Statement payment provenance was not persisted.');
    const charge = target ? result.charges.find(value => value.id === target.id) : null;
    posted.push({ childId: line.childId, childName: result.child.name, serviceMonth: line.serviceMonth, amountCents: line.amountCents, paymentId: payment.id,
      statementLineId: line.id, page: line.page, billingVersion: result.version, remainingCents: charge?.outstandingCents ?? null,
      awaitingCcrc: charge ? charge.pendingCcrc === true : true, allocation: payment.allocatedCents === 0 ? 'unapplied' : payment.creditCents > 0 ? 'partial_credit' : 'applied' });
  }
  // Report the final atomic balance for every row, including multiple
  // receipts for the same child/month within one import.
  const finalLedgers = new Map();
  for (const item of posted) {
    if (!finalLedgers.has(item.childId)) finalLedgers.set(item.childId, await db.getChildBillingRecord(item.childId));
    const ledger = finalLedgers.get(item.childId);
    const target = ledger.data.charges.find(charge => charge.kind === 'monthly' && charge.month === item.serviceMonth && charge.settlementMode === 'ccrc_actual');
    const current = target ? math.chargeView(target, ledger.data.payments, time.dateAt()) : null;
    item.billingVersion = ledger.version; item.remainingCents = current?.outstandingCents ?? null; item.awaitingCcrc = current ? current.pendingCcrc : true;
  }
  row.data.status = 'posted'; row.data.postedPayments = posted; row.data.postedIdentities = identities(row.data.review); row.data.postedAt = new Date().toISOString(); row.data.postedBy = actor.id;
  event(row.data, actor, 'registered', { paymentCount: posted.length, totalCents: row.data.review.totalCents, reconciliationReason: row.data.review.reconciliationReason, duplicateReason: row.data.review.duplicateReason });
});
exports.cancel = (token, id, payload) => mutate(token, id, 'cancel', payload, ['reason'], async (row, actor) => {
  if (row.data.status !== 'draft') throw invalid('Only an unregistered draft can be cancelled.', 'statement', 409);
  row.data.status = 'cancelled'; event(row.data, actor, 'cancelled', { reason: text(payload.reason, 'reason', 1000, true) });
});
exports.reopen = (token, id, payload) => mutate(token, id, 'reopen', payload, [], async (row, actor) => {
  if (row.data.status !== 'cancelled') throw invalid('Only a cancelled draft can be reopened.', 'statement', 409);
  row.data.status = 'draft'; event(row.data, actor, 'reopened');
});
