import type { CcrcStatement } from '../api/ccrcStatements';

export function ccrcStatementFixture(): CcrcStatement {
  const firstId = '00000000-0000-4000-8000-000000000001', secondId = '00000000-0000-4000-8000-000000000002';
  return {
    id: 'source/a', version: 3, status: 'draft', filename: 'Synthetic-CCRC.pdf', contentType: 'application/pdf', byteLength: 2500, createdAt: '2026-11-20T18:00:00Z', updatedAt: '2026-11-20T18:00:00Z', lineCount: 2,
    today: '2026-11-20', timeZone: 'America/Los_Angeles', fingerprint: 'synthetic-fingerprint',
    extraction: { pageCount: 2, pages: [{ number: 1, text: 'Maya Example | 2026-10 | $600.25', method: 'text', warnings: [] }, { number: 2, text: 'Liam Example | 2026-10 | $399.75', method: 'ocr', warnings: [] }],
      statementReference: 'SYN-STATEMENT', paymentReference: 'SYN-PAYMENT', paymentDate: '2026-11-15', totalCents: 100000, incomplete: false, warnings: [],
      lines: [{ id: firstId, page: 1, excerpt: 'Maya Example | 2026-10 | $600.25', childName: 'Maya Example', serviceMonth: '2026-10', amountCents: 60025, kind: 'payment', warnings: [] },
        { id: secondId, page: 2, excerpt: 'Liam Example | 2026-10 | $399.75', childName: 'Liam Example', serviceMonth: '2026-10', amountCents: 39975, kind: 'payment', warnings: [] }] },
    review: { statementReference: 'SYN-STATEMENT', paymentReference: 'SYN-PAYMENT', paymentDate: '2026-11-15', totalCents: 100000, pageCount: 2, pagesReviewed: [], sourceReviewed: false, reconciliationReason: '', duplicateReason: '',
      lines: [{ id: firstId, page: 1, excerpt: 'Maya Example | 2026-10 | $600.25', childId: '', childName: 'Maya Example', serviceMonth: '2026-10', amountCents: 60025, action: 'payment', note: '', reviewed: false, billingVersion: 0, entryReference: '', paymentDate: '', paymentReference: '', allowUnappliedCredit: false },
        { id: secondId, page: 2, excerpt: 'Liam Example | 2026-10 | $399.75', childId: '', childName: 'Liam Example', serviceMonth: '2026-10', amountCents: 39975, action: 'payment', note: '', reviewed: false, billingVersion: 0, entryReference: '', paymentDate: '', paymentReference: '', allowUnappliedCredit: false }] },
    children: [{ id: 'child-maya', name: 'Maya Example', active: true, billingVersion: 4, charges: [{ id: 'monthly:2026-10', month: '2026-10', settlementMode: 'ccrc_actual', amountCents: 120000, outstandingCents: 120000 }] },
      { id: 'child-liam', name: 'Liam Example', active: false, billingVersion: 2, charges: [{ id: 'monthly:2026-10', month: '2026-10', settlementMode: 'ccrc_actual', amountCents: 100000, outstandingCents: 100000 }] }], duplicateWarnings: [], postedPayments: [], history: [],
  };
}
export function readyCcrcStatementFixture(): CcrcStatement {
  const value = ccrcStatementFixture();
  value.review.sourceReviewed = true; value.review.pagesReviewed = [1, 2];
  value.review.lines.forEach((line, index) => { line.childId = value.children[index].id; line.billingVersion = value.children[index].billingVersion; line.reviewed = true; });
  return value;
}
