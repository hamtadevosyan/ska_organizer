import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import { api } from './auth-helpers';
import { billingData, ccrcBillingChild } from './billing-fixtures';
import type { BillingDetail, BillingHttp } from './billing-fixtures';
import type { CcrcStatement, CcrcReview } from '../../src/api/ccrcStatements';

export const statementApi = api + '/billing/statements';
export const statementPage = '/billing/ccrc-statements';

export async function statementData(response: APIResponse, status = 200): Promise<CcrcStatement> {
  expect(response.status(), 'The statement fixture must use an authorized real API response').toBe(status);
  return (await response.json()).data as CcrcStatement;
}

// Preserve the PDF's xref offsets and stream lengths while creating a unique
// synthetic source/reference for each real browser scenario. The fixture is
// deliberately uncompressed and has this fixed-width ASCII reference.
export async function statementFile() {
  const payload = JSON.parse(await readFile(new URL('../../../server/tests/fixtures/ccrc-statements/synthetic-labelled-pdf.json', import.meta.url), 'utf8')) as { dataBase64: string };
  const buffer = Buffer.from(payload.dataBase64, 'base64');
  const original = Buffer.from('SYN-CCRC-2026-11');
  const reference = 'TEST-' + randomUUID().replaceAll('-', '').slice(0, original.length - 5);
  const replacement = Buffer.from(reference);
  expect(replacement.length).toBe(original.length);
  let replaced = 0;
  for (let index = buffer.indexOf(original); index !== -1; index = buffer.indexOf(original, index + replacement.length)) {
    buffer.set(replacement, index); replaced++;
  }
  expect(replaced, 'The synthetic source must have an intact replaceable statement reference').toBeGreaterThan(0);
  return { buffer, name: reference + '.pdf', mimeType: 'application/pdf', reference };
}

export async function statementFixture(http: BillingHttp) {
  const children = [await ccrcBillingChild(http), await ccrcBillingChild(http)];
  const file = await statementFile();
  return { children, file, today: children[0].detail.today, serviceMonth: children[0].serviceMonth };
}

export function reviewedStatement(statement: CcrcStatement, fixture: Awaited<ReturnType<typeof statementFixture>>): CcrcReview {
  expect(statement.extraction.pageCount).toBe(2);
  expect(statement.extraction.lines).toHaveLength(2);
  return {
    ...statement.review,
    statementReference: fixture.file.reference,
    paymentReference: fixture.file.reference,
    paymentDate: fixture.today,
    totalCents: 100000,
    pageCount: 2,
    pagesReviewed: [1, 2],
    sourceReviewed: true,
    reconciliationReason: 'Synthetic fixture: administrator checked both pages and corrected the service month and receipt date.',
    duplicateReason: '',
    lines: statement.extraction.lines.map((line, index) => ({
      id: line.id, page: line.page, excerpt: line.excerpt,
      childId: fixture.children[index].child.id,
      childName: [fixture.children[index].child.firstName, fixture.children[index].child.lastName].join(' '),
      serviceMonth: fixture.serviceMonth, amountCents: index === 0 ? 60000 : 40000,
      action: 'payment', note: 'Checked against synthetic source page ' + line.page, reviewed: true,
      billingVersion: statement.children.find(child => child.id === fixture.children[index].child.id)!.billingVersion,
      allowUnappliedCredit: false, entryReference: '', paymentDate: '', paymentReference: '',
    })),
  };
}

export async function childLedger(http: BillingHttp, childId: string) {
  return billingData<BillingDetail>(await http.get(api + '/billing/children/' + childId));
}
