// Deliberately conservative. These are review candidates from labelled text
// and tables with an explicit paid-amount header, not a CCRC form guarantee.
const { randomUUID } = require('node:crypto');
const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const clean = value => String(value || '').replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '').trim();
function money(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/^USD\s*/i, '').replace(/\s*USD$/i, '');
  const parentheses = /^\(.*\)$/.test(text);
  if (parentheses) text = text.slice(1, -1).trim();
  text = text.replace(/^\$\s*/, '');
  let negative = parentheses;
  if (/^-/.test(text)) { if (negative) return null; negative = true; text = text.slice(1).replace(/^\$\s*/, ''); }
  else if (/^\+/.test(text)) text = text.slice(1).replace(/^\$\s*/, '');
  if (!/^(?:\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 1000000000 ? (negative ? -cents : cents) : null;
}
function isoDate(year, month, day) {
  const value = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return value >= '1900-01-01' && value <= '9999-12-31' && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value ? value : null;
}
function calendarDate(value) {
  const text = clean(value);
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return isoDate(+match[1], +match[2], +match[3]);
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return isoDate(+match[3], +match[1], +match[2]);
  match = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
  if (match) {
    const index = monthNames.findIndex(name => name === match[1].toLowerCase() || name.slice(0, 3) === match[1].toLowerCase());
    if (index >= 0) return isoDate(+match[3], index + 1, +match[2]);
  }
  return null;
}
function serviceMonth(value) {
  const text = clean(value);
  if (/^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/.test(text)) return text;
  let match = /^(\d{1,2})\/(\d{4})$/.exec(text);
  if (match && +match[1] >= 1 && +match[1] <= 12) return match[2] + '-' + match[1].padStart(2, '0');
  match = /^([a-z]+)\.?\s+(\d{4})$/i.exec(text);
  if (match) {
    const index = monthNames.findIndex(name => name === match[1].toLowerCase() || name.slice(0, 3) === match[1].toLowerCase());
    if (index >= 0 && +match[2] >= 1900) return match[2] + '-' + String(index + 1).padStart(2, '0');
  }
  const single = calendarDate(text);
  if (single) return single.slice(0, 7);
  const range = text.split(/\s+(?:to|through|[-–—])\s+/i);
  if (range.length === 2) {
    const from = calendarDate(range[0]), to = calendarDate(range[1]);
    if (from && to && from <= to && from.slice(0, 7) === to.slice(0, 7)) return from.slice(0, 7);
  }
  return null;
}
const label = text => /^([a-z][a-z /#().-]{1,45}?)\s*:\s*(.*?)\s*$/i.exec(text);
const compact = value => value.toLowerCase().replace(/[^a-z]/g, '');
function field(name) {
  const key = compact(name);
  if (['child', 'childname', 'childsname'].includes(key)) return 'childName';
  if (['childid', 'childreference', 'childnumber', 'childidentifier'].includes(key)) return 'childReference';
  if (['servicemonth', 'monthofcare', 'caremonth', 'serviceperiod', 'careperiod', 'datesofservice'].includes(key)) return 'serviceMonth';
  if (['paid', 'amountpaid', 'paidamount', 'paymentamount', 'netpaid', 'netamountpaid', 'reimbursementpaid'].includes(key)) return 'amountCents';
  if (['adjustment', 'adjustments', 'adjustmentamount'].includes(key)) return 'adjustmentCents';
  if (['paymentdate', 'paiddate', 'datepaid', 'checkdate', 'issuedate'].includes(key)) return 'paymentDate';
  if (['statementreference', 'statementid', 'statementnumber', 'statement'].includes(key)) return 'statementReference';
  if (['paymentreference', 'paymentid', 'paymentnumber', 'checknumber', 'checkreference', 'transactionreference'].includes(key)) return 'paymentReference';
  if (['totalpaid', 'totalamountpaid', 'paymenttotal', 'statementtotal', 'grandtotal', 'netpaymenttotal'].includes(key)) return 'totalCents';
  return null;
}
function parseStatement(pages) {
  const result = { statementReference: null, paymentReference: null, paymentDate: null, totalCents: null, lines: [], warnings: [], format: 'unrecognized' };
  let block = null, columns = null;
  const headerValues = new Map(), ambiguousHeaders = new Set();
  const addWarning = message => { if (!result.warnings.includes(message)) result.warnings.push(message); };
  const header = (key, raw) => {
    const value = key === 'paymentDate' ? calendarDate(raw) : key === 'totalCents' ? money(raw) : clean(raw).slice(0, 160) || null;
    if (ambiguousHeaders.has(key) || headerValues.has(key) && headerValues.get(key) !== value) { ambiguousHeaders.add(key); result[key] = null; addWarning('Conflicting ' + key + ' values need review.'); return; }
    headerValues.set(key, value); result[key] = value;
    if (value === null) addWarning('The ' + key + ' could not be read reliably.');
  };
  const finish = () => {
    if (!block) return;
    const row = { id: randomUUID(), page: block.page, excerpt: block.parts.join('\n').slice(0, 2400), childName: block.childName || '', childReference: block.childReference || '', serviceMonth: serviceMonth(block.serviceMonth), paymentDate: calendarDate(block.paymentDate) || null,
      amountCents: money(block.amountCents), kind: 'payment', warnings: [] };
    if (!row.childName && !row.childReference) row.warnings.push('Choose the child after checking the source.');
    if (!row.serviceMonth) row.warnings.push('The service month is missing, invalid or crosses months.');
    if (row.amountCents === null) { row.kind = 'unknown'; row.warnings.push('A labelled paid amount could not be read. Authorized or expected amounts are not payments.'); }
    else if (row.amountCents <= 0) { row.kind = 'adjustment'; row.warnings.push('A zero or negative amount is an adjustment to review, not a positive receipt.'); }
    if (block.adjustmentCents !== undefined) { row.adjustmentCents = money(block.adjustmentCents); row.warnings.push('A separate adjustment is shown. Check whether the paid amount already includes it; it was not added or subtracted automatically.'); }
    if (block.pages.size > 1) row.warnings.push('This entry continues across pages; check every source page.');
    if (block.duplicateFields) row.warnings.push('Repeated entry fields need review; amounts were not combined.');
    if (block.ocr) row.warnings.push('OCR text must be checked against the original image.');
    result.lines.push(row); block = null;
  };
  for (const page of pages) {
    const number = page.number;
    const source = String(page.text || '').replace(/\r\n?/g, '\n').split('\n');
    for (const raw of source) {
      const text = clean(raw); if (!text) continue;
      const printed = /\bpage\s+(\d+)\s+(?:of|\/)\s*(\d+)\b/i.exec(text);
      if (printed && (+printed[2] !== pages.length || +printed[1] !== number)) addWarning('Printed page numbering does not match the uploaded file. Check for missing, duplicated or reordered pages.');
      if (/^(?:page\s+\d+|ccrc\b|synthetic\b|payment\s+statement\b|continued\b)/i.test(text) && !label(text)) continue;
      const match = label(text);
      if (match) {
        const key = field(match[1]);
        if (['statementReference', 'paymentReference', 'totalCents'].includes(key)) { finish(); header(key, match[2]); continue; }
        if (key === 'paymentDate' && !block) { header(key, match[2]); continue; }
        if (key === 'childName' || key === 'childReference' && block?.childReference !== undefined) { finish(); columns = null; }
        if (['childName', 'childReference', 'serviceMonth', 'amountCents', 'adjustmentCents', 'paymentDate'].includes(key)) {
          if (!block) block = { page: number, parts: [], pages: new Set(), ocr: false };
          if (block[key] !== undefined) { block.duplicateFields = true; finish(); block = { page: number, parts: [], pages: new Set(), ocr: false, duplicateFields: true }; }
          block[key] = match[2]; block.parts.push(text); block.pages.add(number); block.ocr ||= page.method === 'ocr';
          result.format = 'labelled'; continue;
        }
        if (/authorized|approved|expected|eligible/i.test(match[1]) && block) { block.parts.push(text); block.pages.add(number); continue; }
      }
      // A table is recognized only when its explicit header identifies both
      // the child and PAID amount; no guessing which numeric column was paid.
      const cells = raw.includes('|') ? raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean)
        : raw.includes('\t') ? raw.trim().split('\t').map(clean) : raw.trim().split(/ {2,}/).map(clean);
      const fields = cells.map(field);
      if (fields.includes('amountCents') && (fields.includes('childName') || fields.includes('childReference')) && fields.includes('serviceMonth')) {
        finish(); columns = fields; result.format = 'tabular'; continue;
      }
      if (columns && cells.length === columns.length && !/^(?:total|subtotal|balance|page|statement|payment\s+date)\b/i.test(text)) {
        finish(); block = { page: number, parts: [text], pages: new Set([number]), ocr: page.method === 'ocr' };
        columns.forEach((key, index) => { if (key) block[key] = cells[index]; }); finish(); continue;
      }
      if (columns && !/^(?:total|subtotal|balance|page|statement|payment\s+date)\b/i.test(text) && !/^(?:[-_=]\s*){3,}$/.test(text)) {
        finish(); result.lines.push({ id: randomUUID(), page: number, excerpt: text.slice(0, 2400), childName: '', childReference: '', serviceMonth: null, paymentDate: null, amountCents: null, kind: 'unknown',
          warnings: ['This table row did not match the header. Check for a wrapped or missing final row and enter its paid details manually.'] });
        addWarning('Some table rows could not be mapped. They remain visible as unknown rows and need manual review.');
        continue;
      }
      if (block) { block.parts.push(text); block.pages.add(number); }
    }
  }
  finish();
  if (!result.lines.length) addWarning('This layout was not recognized. Review all pages and enter the paid lines manually.');
  if (result.totalCents === null) addWarning('A statement paid total is missing or ambiguous; enter and review it against the source.');
  if (!result.paymentDate) addWarning('The payment date needs review; it is separate from the service month.');
  if (!result.statementReference && !result.paymentReference) addWarning('Enter a statement or payment reference to help prevent duplicate receipts.');
  return result;
}
module.exports = { parseStatement, money, calendarDate, serviceMonth };
