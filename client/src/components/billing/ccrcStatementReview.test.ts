import { expect, test } from 'vitest';
import { ccrcStatementFixture, readyCcrcStatementFixture } from '../../tests/ccrcStatementFixture';
import { signedStatementCents, statementChildSuggestions, statementIncludedCents, statementReviewDraft, statementReviewIssues, statementReviewPayload } from './ccrcStatementReview';

test('keeps exact cents, separate service months and receipt dates through an editable review', () => {
  const data = readyCcrcStatementFixture(), draft = statementReviewDraft(data.review);
  expect(statementIncludedCents(draft)).toBe(100000); expect(statementReviewIssues(draft, data)).toEqual([]);
  expect(statementReviewPayload(draft)).toEqual(data.review);
  draft.lines[0].paymentDate = '2026-11-10'; draft.lines[0].paymentReference = 'OTHER-CHECK';
  const result = statementReviewPayload(draft); expect(result.lines[0]).toMatchObject({ serviceMonth: '2026-10', paymentDate: '2026-11-10', paymentReference: 'OTHER-CHECK', amountCents: 60025 });
});
test('missing last-page confirmation, unmatched children and unreviewed rows block registration', () => {
  const data = ccrcStatementFixture(), draft = statementReviewDraft(data.review), issues = statementReviewIssues(draft, data);
  expect(issues).toContain('Check every page of the original statement, including its last page.');
  expect(issues).toContain('Line 1: choose an existing child.'); expect(issues).toContain('Line 2: check the line against the original.');
});
test('missing tuition requires an explicit unapplied-credit choice and an explanation', () => {
  const data = readyCcrcStatementFixture(); data.children[0].charges = [];
  const draft = statementReviewDraft(data.review);
  expect(statementReviewIssues(draft, data)).toContain('Line 1: set up the tuition charge, or explicitly keep this receipt as unapplied CCRC credit with a note.');
  draft.lines[0].allowUnappliedCredit = true; draft.lines[0].note = 'October tuition setup is still pending.';
  expect(statementReviewIssues(draft, data)).toEqual([]);
});
test('corrections and manual entries require a reconciliation note while excluded source rows remain', () => {
  const data = readyCcrcStatementFixture(), draft = statementReviewDraft(data.review);
  draft.lines[0].amount = '600.24';
  expect(statementReviewIssues(draft, data)).toContain('The included payment lines must add up to the statement total exactly.');
  expect(statementReviewIssues(draft, data)).toContain('Add a reconciliation note explaining manual entries, corrections or excluded lines.');
  draft.lines[0].action = 'exclude'; draft.lines[0].note = 'Already represented by another reviewed net payment.'; draft.total = '399.75'; draft.reconciliationReason = 'The included total is the unrepeated payment shown on page 2.';
  expect(statementReviewPayload(draft).lines).toHaveLength(2); expect(statementIncludedCents(draft)).toBe(39975); expect(statementReviewIssues(draft, data)).toEqual([]);
});
test('manual page count cannot silently substitute for a known multi-page source', () => {
  const data = readyCcrcStatementFixture(), draft = statementReviewDraft(data.review); draft.pageCount = '1';
  expect(statementReviewIssues(draft, data)).toContain('Check the original statement page count.');
});
test('duplicate warnings require review and exact duplicates cannot be bypassed by a note', () => {
  const data = readyCcrcStatementFixture(), draft = statementReviewDraft(data.review); data.duplicateWarnings = [{ kind: 'possible', statementId: 'earlier', message: 'Possible duplicate' }];
  expect(statementReviewIssues(draft, data)).toContain('Explain why the possible duplicate is a separate payment.');
  draft.duplicateReason = 'Separate voucher documented on the original.'; expect(statementReviewIssues(draft, data)).toEqual([]);
  data.duplicateWarnings[0].kind = 'exact'; expect(statementReviewIssues(draft, data)).toContain('A matching child payment has already been registered. Review the existing payment record.');
});
test.each(['-0.10', '0.10', '999.99', '1.001', '1e3'])('preserves signed evidence without float rounding or guessing: %s', value => {
  expect(signedStatementCents(value)).toBe({ '-0.10': -10, '0.10': 10, '999.99': 99999, '1.001': null, '1e3': null }[value]);
});
test('future or impossible receipt dates cannot become a ready payment', () => {
  const data = readyCcrcStatementFixture(), draft = statementReviewDraft(data.review);
  draft.paymentDate = '2026-11-21'; expect(statementReviewIssues(draft, data)).toContain('The payment date cannot be in the future.');
  draft.paymentDate = '2026-02-31'; expect(statementReviewIssues(draft, data)).toContain('Enter the actual payment date.');
});

test('name suggestions are exact normalized hints and preserve ambiguity', () => {
  const data = ccrcStatementFixture(), candidate = { ...data.extraction.lines[0], childName: '  MAYA   EXAMPLE ' };
  expect(statementChildSuggestions(candidate, data.children).map(child => child.id)).toEqual(['child-maya']);
  data.children.push({ ...data.children[0], id: 'another-maya' });
  expect(statementChildSuggestions(candidate, data.children).map(child => child.id)).toEqual(['child-maya', 'another-maya']);
  candidate.childName = 'Maya'; expect(statementChildSuggestions(candidate, data.children)).toEqual([]);
});
test('an unknown CCRC identifier does not silently map to an unrelated internal child ID', () => {
  const data = ccrcStatementFixture(), candidate = { ...data.extraction.lines[0], childName: '', childReference: 'external-CCRC-id' };
  expect(statementChildSuggestions(candidate, data.children)).toEqual([]);
  candidate.childReference = 'child-liam'; expect(statementChildSuggestions(candidate, data.children).map(child => child.id)).toEqual(['child-liam']);
});
