import { billingCents, billingDollars } from '../../api/billing';
import type { CcrcCandidate, CcrcLine, CcrcReview, CcrcStatement } from '../../api/ccrcStatements';

export type StatementLineDraft = Omit<CcrcLine, 'amountCents'> & { amount: string };
export type StatementReviewDraft = Omit<CcrcReview, 'totalCents' | 'pageCount' | 'lines'> & { total: string; pageCount: string; lines: StatementLineDraft[] };
export function statementReviewDraft(review: CcrcReview): StatementReviewDraft {
  const { totalCents, pageCount, lines, ...rest } = review;
  return { ...rest, pagesReviewed: [...review.pagesReviewed], total: totalCents == null ? '' : billingDollars(totalCents), pageCount: pageCount == null ? '' : String(pageCount), lines: lines.map(({ amountCents, ...line }) => ({ ...line, amount: amountCents == null ? '' : billingDollars(amountCents) })) };
}
export function signedStatementCents(value: string): number | null {
  const negative = value.startsWith('-');
  const number = billingCents(negative ? value.slice(1) : value);
  return number === null ? null : number * (negative ? -1 : 1);
}
export function statementReviewPayload(draft: StatementReviewDraft): CcrcReview {
  const { total, pageCount, lines, ...rest } = draft;
  return { ...rest, totalCents: billingCents(total), pageCount: /^\d+$/.test(pageCount) ? Number(pageCount) : null, lines: lines.map(({ amount, ...line }) => ({ ...line, amountCents: signedStatementCents(amount) })) };
}
export function statementIncludedCents(draft: StatementReviewDraft): number {
  return draft.lines.filter(line => line.action === 'payment').reduce((sum, line) => sum + (signedStatementCents(line.amount) || 0), 0);
}
export function statementReviewIssues(draft: StatementReviewDraft, data: CcrcStatement): string[] {
  const issues: string[] = [], review = statementReviewPayload(draft);
  if (!review.statementReference.trim()) issues.push('Enter the statement reference.');
  if (!review.paymentReference.trim()) issues.push('Enter the payment reference from the statement.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(review.paymentDate) || !Number.isFinite(Date.parse(review.paymentDate + 'T12:00:00Z')) || new Date(review.paymentDate + 'T12:00:00Z').toISOString().slice(0, 10) !== review.paymentDate) issues.push('Enter the actual payment date.');
  else if (review.paymentDate > data.today) issues.push('The payment date cannot be in the future.');
  if (!review.totalCents || review.totalCents > 100000000000) issues.push('Enter the positive payment total shown on the statement.');
  const pageCount = review.pageCount || 0;
  if (pageCount < 1 || pageCount > 12 || data.extraction.pageCount !== null && pageCount !== data.extraction.pageCount) issues.push('Check the original statement page count.');
  else if (Array.from({ length: pageCount }, (_, index) => index + 1).some(page => !review.pagesReviewed.includes(page))) issues.push('Check every page of the original statement, including its last page.');
  if (!review.sourceReviewed) issues.push('Confirm that the review matches the original statement.');
  const included = review.lines.filter(line => line.action === 'payment');
  if (!included.length) issues.push('Add at least one payment to register.');
  for (const [index, line] of review.lines.entries()) {
    const label = 'Line ' + (index + 1) + ': ';
    if (line.paymentDate && (!/^\d{4}-\d{2}-\d{2}$/.test(line.paymentDate) || !Number.isFinite(Date.parse(line.paymentDate + 'T12:00:00Z')) || new Date(line.paymentDate + 'T12:00:00Z').toISOString().slice(0, 10) !== line.paymentDate || line.paymentDate > data.today)) issues.push(label + 'choose a real payment date, no later than today.');
    if (!line.excerpt.trim()) issues.push(label + 'enter the source excerpt from the statement.');
    if (!line.reviewed) issues.push(label + 'check the line against the original.');
    if (line.page < 1 || line.page > pageCount) issues.push(label + 'choose its source page.');
    if (line.action === 'exclude') { if (!line.note.trim()) issues.push(label + 'explain why it is excluded.'); continue; }
    const child = data.children.find(child => child.id === line.childId);
    if (!child) issues.push(label + 'choose an existing child.');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(line.serviceMonth)) issues.push(label + 'choose the month of care.');
    else if (child && !child.charges.some(charge => charge.month === line.serviceMonth && charge.settlementMode === 'ccrc_actual') && (!line.allowUnappliedCredit || !line.note.trim())) issues.push(label + 'set up the tuition charge, or explicitly keep this receipt as unapplied CCRC credit with a note.');
    if (!line.amountCents || line.amountCents < 0 || line.amountCents > 1000000000) issues.push(label + 'enter the positive amount actually paid.');
  }
  if (review.totalCents !== null && statementIncludedCents(draft) !== review.totalCents) issues.push('The included payment lines must add up to the statement total exactly.');
  if (!review.reconciliationReason.trim() && (data.extraction.incomplete || data.extraction.warnings.length || review.lines.some(line => line.action === 'exclude') || review.lines.some(line => {
    const candidate = data.extraction.lines.find(candidate => candidate.id === line.id);
    return !candidate || candidate.kind !== 'payment' || candidate.amountCents !== line.amountCents || candidate.serviceMonth !== line.serviceMonth || candidate.page !== line.page || candidate.excerpt !== line.excerpt || !!candidate.paymentDate && candidate.paymentDate !== (line.paymentDate || review.paymentDate) || !!candidate.paymentReference && candidate.paymentReference !== (line.paymentReference || review.paymentReference);
  }) || data.extraction.totalCents !== review.totalCents || data.extraction.paymentDate !== review.paymentDate || data.extraction.statementReference !== review.statementReference)) issues.push('Add a reconciliation note explaining manual entries, corrections or excluded lines.');
  if (data.duplicateWarnings.some(warning => warning.kind === 'exact')) issues.push('A matching child payment has already been registered. Review the existing payment record.');
  if (data.duplicateWarnings.some(warning => warning.kind === 'possible') && !review.duplicateReason.trim()) issues.push('Explain why the possible duplicate is a separate payment.');
  return issues;
}

export function statementChildSuggestions(candidate: CcrcCandidate | undefined, children: CcrcStatement['children']) {
  if (!candidate) return [];
  const byId = candidate.childReference ? children.filter(child => child.id === candidate.childReference) : [];
  if (byId.length) return byId;
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const name = normalize(candidate.childName || '');
  return name ? children.filter(child => normalize(child.name) === name) : [];
}
