const { parseStatement, money, calendarDate, serviceMonth } = require('../services/ccrcStatementParser');
const page = (text, number = 1, method = 'text') => ({ number, text, method, warnings: [] });

test.each([['$1,234.56', 123456], ['USD 0.01', 1], ['$0.1', 10], ['$9', 900], ['($12.50)', -1250], ['-$12.50', -1250], ['$-12.50', -1250], ['+12.50', 1250]])('currency preserves exact cents and signs: %s', (input, expected) => {
  expect(money(input)).toBe(expected);
});
test.each(['1O0.00', '$1.005', '$1,00.00', '1/2', '(--1.00)', '$10000000.01', '1e3', '100 paid', '', null])('uncertain or unsafe currency is never guessed: %s', input => {
  expect(money(input)).toBeNull();
});
test.each([['2026-11-20', '2026-11-20'], ['11/20/2026', '2026-11-20'], ['November 20, 2026', '2026-11-20'], ['Nov 20 2026', '2026-11-20'], ['02/30/2026', null], ['11/20/26', null]])('calendar date parsing remains explicit: %s', (input, expected) => {
  expect(calendarDate(input)).toBe(expected);
});
test.each([['October 2026', '2026-10'], ['10/2026', '2026-10'], ['2026-10', '2026-10'], ['10/01/2026 - 10/31/2026', '2026-10'], ['10/15/2026 - 11/15/2026', null], ['2026-13', null]])('service months never merge care across months: %s', (input, expected) => {
  expect(serviceMonth(input)).toBe(expected);
});

test('multi-page labelled suggestions retain the last paid row, source pages and separate service/payment months', () => {
  const result = parseStatement([
    page('Statement reference: SYN-01\nPayment date: November 20, 2026\nChild name: Ada Synthetic\nChild ID: CCRC-A\nService month: October 2026\nAmount paid: $600.00\nPage 1 of 2'),
    page('Child name: Ben Synthetic\nChild ID: CCRC-B\nService period: 10/01/2026 - 10/31/2026\nAmount paid: $400.00\nTotal paid: $1,000.00\nPage 2 of 2', 2),
  ]);
  expect(result).toMatchObject({ statementReference: 'SYN-01', paymentDate: '2026-11-20', totalCents: 100000, format: 'labelled', lines: [
    { page: 1, childName: 'Ada Synthetic', childReference: 'CCRC-A', serviceMonth: '2026-10', amountCents: 60000, kind: 'payment' },
    { page: 2, childName: 'Ben Synthetic', childReference: 'CCRC-B', serviceMonth: '2026-10', amountCents: 40000, kind: 'payment' },
  ] });
  expect(result.lines.at(-1).excerpt).toContain('Amount paid: $400.00');
  expect(result.lines.every(row => /^[0-9a-f-]{36}$/.test(row.id))).toBe(true);
  expect(result.warnings).toEqual([]);
});

test('authorized or expected amounts cannot become received payments', () => {
  const result = parseStatement([page('Child name: Ada Synthetic\nService month: 2026-10\nAmount authorized: $1,200.00\nExpected amount: $1,100.00\nTotal paid: $0.00')]);
  expect(result.lines).toMatchObject([{ amountCents: null, kind: 'unknown' }]);
  expect(result.lines[0].warnings.join(' ')).toMatch(/Authorized or expected amounts are not payments/);
  expect(result.lines[0].excerpt).toContain('Amount authorized: $1,200.00');
});

test('negative payments and separate adjustments remain visible without applying an invented net amount', () => {
  const result = parseStatement([page('Child: Ada Synthetic\nService month: 2026-10\nAmount paid: ($50.25)\nAdjustment: -$10.00\nTotal paid: ($50.25)')]);
  expect(result.lines).toMatchObject([{ amountCents: -5025, adjustmentCents: -1000, kind: 'adjustment' }]);
  expect(result.lines[0].warnings.join(' ')).toMatch(/not added or subtracted automatically/);
});

test('a cross-page labelled entry is retained and explicitly needs all-source-page review', () => {
  const result = parseStatement([page('Child name: Ada Synthetic\nService month: 2026-10'), page('Amount paid: $100.00\nTotal paid: $100.00', 2, 'ocr')]);
  expect(result.lines).toMatchObject([{ page: 1, childName: 'Ada Synthetic', amountCents: 10000 }]);
  expect(result.lines[0].warnings.join(' ')).toMatch(/continues across pages/);
  expect(result.lines[0].warnings.join(' ')).toMatch(/OCR/);
});

test('a paid table keeps internal blank columns rather than shifting the paid amount into the month', () => {
  const result = parseStatement([page('Child name | Service month | Amount paid\nAda Synthetic | 2026-10 | $100.00\nBen Synthetic | | $200.00\nTotal paid: $300.00')]);
  expect(result.lines).toMatchObject([{ childName: 'Ada Synthetic', serviceMonth: '2026-10', amountCents: 10000 }, { childName: 'Ben Synthetic', serviceMonth: null, amountCents: 20000 }]);
  expect(result.lines[1].warnings.join(' ')).toMatch(/service month is missing/);
});

test('tab-delimited blank columns remain in their original positions', () => {
  const result = parseStatement([page('Child name\tService month\tAmount paid\nAda Synthetic\t\t$100.00\nTotal paid: $100.00')]);
  expect(result.lines).toMatchObject([{ childName: 'Ada Synthetic', serviceMonth: null, amountCents: 10000 }]);
});

test('a wrapped or unmatched last table row becomes an unknown review row rather than disappearing', () => {
  const result = parseStatement([page('Child name | Service month | Amount paid\nAda Synthetic | 2026-10 | $100.00\nBen Synthetic | 2026-10\n$200.00\nTotal paid: $300.00')]);
  expect(result.lines).toHaveLength(3);
  expect(result.lines.slice(1)).toMatchObject([{ excerpt: 'Ben Synthetic | 2026-10', kind: 'unknown', amountCents: null }, { excerpt: '$200.00', kind: 'unknown', amountCents: null }]);
  expect(result.warnings.join(' ')).toMatch(/Some table rows could not be mapped/);
});

test('conflicting repeated totals remain ambiguous even if a later page repeats the first value', () => {
  const result = parseStatement([page('Total paid: $100.00\nTotal paid: $200.00\nTotal paid: $100.00')]);
  expect(result.totalCents).toBeNull();
  expect(result.warnings.join(' ')).toMatch(/Conflicting totalCents/);
});

test('printed page counts expose a missing, reordered or duplicated page', () => {
  const result = parseStatement([page('Child: Ada Synthetic\nAmount paid: $100.00\nPage 1 of 3'), page('Total paid: $100.00\nPage 3 of 3', 2)]);
  expect(result.warnings.join(' ')).toMatch(/missing, duplicated or reordered pages/);
});

test('an unsupported layout preserves a clear manual-review warning instead of claiming an empty successful import', () => {
  const result = parseStatement([page('A photograph of an unusual statement layout.\nAmounts are in an unlabeled column: 1200 1000 200')]);
  expect(result).toMatchObject({ format: 'unrecognized', lines: [], totalCents: null });
  expect(result.warnings.join(' ')).toMatch(/enter the paid lines manually/);
});
