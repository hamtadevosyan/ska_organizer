import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CCRCStatements from './CCRCStatements';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import { AuthContext } from '../auth/context';
import { ccrcStatementFixture, readyCcrcStatementFixture } from '../tests/ccrcStatementFixture';
import type { CcrcReview, CcrcStatement } from '../api/ccrcStatements';
import { cancelCcrcStatement, getCcrcStatement, getCcrcStatementContent, listCcrcStatements, postCcrcStatement, reopenCcrcStatement, saveCcrcReview, uploadCcrcStatement } from '../api/ccrcStatements';
import { readDocumentFile } from '../api/childDocuments';

const fixture = vi.hoisted(() => ({ report: vi.fn(), expired: new Set<() => void>(), denied: new Set<() => void>(), created: vi.fn(), revoked: vi.fn() }));
vi.mock('../components/UnsavedChangesContext', () => ({ useUnsavedChanges: () => fixture.report }));
vi.mock('../auth/transport', () => ({ authError: (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback, onSessionExpired: (callback: () => void) => { fixture.expired.add(callback); return () => fixture.expired.delete(callback); }, onWorkAccessRequired: (callback: () => void) => { fixture.denied.add(callback); return () => fixture.denied.delete(callback); } }));
vi.mock('../api/ccrcStatements', () => ({ cancelCcrcStatement: vi.fn(), getCcrcStatement: vi.fn(), getCcrcStatementContent: vi.fn(), listCcrcStatements: vi.fn(), postCcrcStatement: vi.fn(), reopenCcrcStatement: vi.fn(), saveCcrcReview: vi.fn(), uploadCcrcStatement: vi.fn() }));
vi.mock('../api/childDocuments', async original => ({ ...await original<typeof import('../api/childDocuments')>(), readDocumentFile: vi.fn() }));
vi.mock('../components/children/PdfDocumentPreview', () => ({ default: () => <p>Private canvas PDF preview</p> }));

const filePayload = { name: 'Synthetic-CCRC.pdf', contentType: 'application/pdf', dataBase64: 'c3ludGhldGlj' };
const show = (role: 'admin' | 'editor' | 'viewer' | 'teacher' = 'admin', path = '/billing/ccrc-statements?statement=source%2Fa') => render(<SignedIn account={{ ...testAccount, role }}><MemoryRouter initialEntries={[path]}><CCRCStatements /></MemoryRouter></SignedIn>);
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const loaded = () => screen.findByRole('form', { name: 'Review CCRC statement' });
function check(name: string) { const input = screen.getByRole('checkbox', { name }); if (!(input as HTMLInputElement).checked) fireEvent.click(input); }
function chooseAndCheckRows() {
  fill('Line 1 child', 'child-maya'); fill('Line 2 child', 'child-liam');
  check('I checked page 1 of the original statement.'); check('I checked page 2 of the original statement.');
  check('I checked line 1 against the original.'); check('I checked line 2 against the original.');
  check('I compared all payment lines and totals with the original statement.');
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.expired.clear(); fixture.denied.clear(); fixture.created.mockReturnValue('blob:private-statement');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: fixture.created }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: fixture.revoked });
  const data = ccrcStatementFixture();
  vi.mocked(listCcrcStatements).mockResolvedValue({ items: [data], total: 1, today: data.today, timeZone: data.timeZone });
  vi.mocked(getCcrcStatement).mockResolvedValue(data); vi.mocked(uploadCcrcStatement).mockResolvedValue(data);
  vi.mocked(saveCcrcReview).mockImplementation(async (_id, body) => ({ ...ccrcStatementFixture(), version: 4, review: body.review as CcrcReview }));
  vi.mocked(postCcrcStatement).mockResolvedValue({ ...readyCcrcStatementFixture(), version: 5, status: 'posted', postedPayments: [{ childId: 'child-maya', childName: 'Maya Example', paymentId: 'payment1', statementLineId: 'line1', page: 1, serviceMonth: '2026-10', billingVersion: 5, amountCents: 60025, remainingCents: 59975, awaitingCcrc: true, allocation: 'applied' }] });
  vi.mocked(cancelCcrcStatement).mockResolvedValue({ ...data, status: 'cancelled', version: 4 }); vi.mocked(reopenCcrcStatement).mockResolvedValue({ ...data, version: 5 });
  vi.mocked(getCcrcStatementContent).mockResolvedValue(new Blob(['private original'], { type: 'application/pdf' })); vi.mocked(readDocumentFile).mockResolvedValue(filePayload);
});

test.each(['editor', 'teacher', 'viewer'] as const)('%s never loads private statements or originals', role => {
  show(role); expect(screen.getByRole('alert')).toHaveTextContent('Administrator access is required');
  expect(listCcrcStatements).not.toHaveBeenCalled(); expect(getCcrcStatement).not.toHaveBeenCalled(); expect(getCcrcStatementContent).not.toHaveBeenCalled();
});
test('recognized names do not silently choose children and the last page stays explicitly reviewable', async () => {
  show(); await loaded(); expect(screen.getByLabelText('Line 1 child')).toHaveValue(''); expect(screen.getByLabelText('Line 2 child')).toHaveValue('');
  expect(screen.getByText('Recognized child: Maya Example')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'I checked page 2 of the original statement.' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Confirm and register payments' })).toBeDisabled(); expect(postCcrcStatement).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Payment date')).toHaveValue('2026-11-15'); expect(screen.getByLabelText('Line 1 service month')).toHaveValue('2026-10');
});
test('a unique exact name is a suggestion without preselecting or approving a child', async () => {
  show(); await loaded();
  const row = within(screen.getByRole('article', { name: 'Statement payment line 1' }));
  expect(row.getByText(/Suggested match:/)).toHaveTextContent('Maya Example');
  expect(row.getByRole('option', { name: 'Suggested · Maya Example' })).toHaveValue('child-maya');
  expect(row.getByLabelText('Line 1 child')).toHaveValue(''); expect(row.getByRole('checkbox')).not.toBeChecked();
});
test('duplicate child names remain ambiguous and display stable IDs for administrator selection', async () => {
  const data = ccrcStatementFixture(); data.children.push({ ...data.children[0], id: 'other-maya' }); vi.mocked(getCcrcStatement).mockResolvedValue(data); show(); await loaded();
  const row = within(screen.getByRole('article', { name: 'Statement payment line 1' }));
  expect(row.getByText('2 children match this name. Check the source and child ID before selecting.')).toBeVisible();
  expect(row.getByRole('option', { name: 'Suggested · Maya Example · ID child-maya' })).toHaveValue('child-maya');
  expect(row.getByRole('option', { name: 'Suggested · Maya Example · ID other-maya' })).toHaveValue('other-maya'); expect(row.getByLabelText('Line 1 child')).toHaveValue('');
});
test('upload preserves exact original bytes, creates only a draft and keeps retry identity after a lost response', async () => {
  vi.mocked(uploadCcrcStatement).mockRejectedValueOnce(new Error('Disconnected'));
  show('admin', '/billing/ccrc-statements');
  const file = new File(['synthetic'], filePayload.name, { type: filePayload.contentType });
  fireEvent.change(screen.getByLabelText('Choose statement file'), { target: { files: [file] } }); fireEvent.click(screen.getByRole('button', { name: 'Read statement' }));
  await screen.findByRole('button', { name: 'Retry same upload' });
  expect(readDocumentFile).toHaveBeenCalledWith(file, expect.any(AbortSignal)); expect(uploadCcrcStatement).toHaveBeenCalledWith(filePayload, expect.any(String), expect.any(AbortSignal)); expect(postCcrcStatement).not.toHaveBeenCalled();
  const first = vi.mocked(uploadCcrcStatement).mock.calls[0]; fireEvent.click(screen.getByRole('button', { name: 'Retry same upload' })); await loaded();
  expect(vi.mocked(uploadCcrcStatement).mock.calls[1].slice(0, 2)).toEqual(first.slice(0, 2));
});
test('a valid original followed by an invalid choice cannot upload the previous hidden file', async () => {
  show('admin', '/billing/ccrc-statements');
  fireEvent.change(screen.getByLabelText('Choose statement file'), { target: { files: [new File(['valid'], 'original.pdf', { type: 'application/pdf' })] } });
  expect(screen.getByRole('button', { name: 'Read statement' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Choose statement file'), { target: { files: [new File(['<svg/>'], 'wrong.svg', { type: 'image/svg+xml' })] } });
  expect(screen.getByRole('button', { name: 'Read statement' })).toBeDisabled(); expect(screen.queryByText('original.pdf')).not.toBeInTheDocument(); expect(uploadCcrcStatement).not.toHaveBeenCalled();
});
test('a camera JPEG is read without client cropping, resizing or replacement', async () => {
  show('admin', '/billing/ccrc-statements');
  const original = new File([new Uint8Array([255, 216, 255, 192, 0, 17, 8, 11, 208, 15, 192, 255, 217])], 'camera-4032x3024.jpg', { type: 'image/jpeg' });
  const exact = { name: original.name, contentType: original.type, dataBase64: '/9j/wAARCAvQD8D/2Q==' }; vi.mocked(readDocumentFile).mockResolvedValueOnce(exact);
  fireEvent.change(screen.getByLabelText('Take statement photo'), { target: { files: [original] } }); fireEvent.click(screen.getByRole('button', { name: 'Read statement' }));
  await waitFor(() => expect(uploadCcrcStatement).toHaveBeenCalled()); expect(readDocumentFile).toHaveBeenCalledWith(original, expect.any(AbortSignal)); expect(uploadCcrcStatement).toHaveBeenCalledWith(exact, expect.any(String), expect.any(AbortSignal)); expect(fixture.created).not.toHaveBeenCalled();
});
test('save review keeps exact cents and service month separate, and posting is a second explicit action', async () => {
  show(); await loaded(); chooseAndCheckRows(); fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
  await screen.findByText('Review saved. No payments have been registered.');
  const body = vi.mocked(saveCcrcReview).mock.calls[0][1]; expect(body).toMatchObject({ version: 3, requestId: expect.any(String), review: { totalCents: 100000, paymentDate: '2026-11-15', pagesReviewed: [1, 2], sourceReviewed: true, lines: [{ childId: 'child-maya', amountCents: 60025, serviceMonth: '2026-10', billingVersion: 4 }, { childId: 'child-liam', amountCents: 39975, serviceMonth: '2026-10', billingVersion: 2 }] } });
  expect(postCcrcStatement).not.toHaveBeenCalled(); check('I want to register these reviewed payments.'); fireEvent.click(screen.getByRole('button', { name: 'Confirm and register payments' }));
  await screen.findByText('Payments registered. The child ledgers are updated.'); expect(postCcrcStatement).toHaveBeenCalledWith('source/a', { version: 4, requestId: expect.any(String) }, expect.any(AbortSignal));
  expect(screen.getByText('Remaining tuition after this import: $599.75 · Awaiting CCRC review')).toBeVisible();
});
test('saving an incomplete review is allowed but registration remains blocked for missing pages and totals', async () => {
  show(); await loaded(); fill('Statement total ($)', '1000.01'); fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
  await screen.findByText('Review saved. No payments have been registered.');
  expect(screen.getByText('Check every page of the original statement, including its last page.')).toBeVisible(); expect(screen.getByText('The included payment lines must add up to the statement total exactly.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm and register payments' })).toBeDisabled();
});
test('editing a checked row clears its prior review and preserves each source row when excluded', async () => {
  vi.mocked(getCcrcStatement).mockResolvedValue(readyCcrcStatementFixture()); show(); await loaded();
  fill('Line 2 action', 'exclude');
  expect(screen.getByRole('checkbox', { name: 'I checked line 2 against the original.' })).not.toBeChecked(); expect(screen.getByRole('checkbox', { name: 'I compared all payment lines and totals with the original statement.' })).not.toBeChecked();
  fill('Line 2 note (required)', 'This row is an authorization, not a receipt.'); fill('Statement total ($)', '600.25'); fill('Reconciliation note', 'Only the received amount is included.');
  check('I checked line 2 against the original.'); check('I compared all payment lines and totals with the original statement.'); fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await screen.findByText('Review saved. No payments have been registered.');
  const body = vi.mocked(saveCcrcReview).mock.calls[0][1]; expect((body.review as CcrcReview).lines).toHaveLength(2); expect((body.review as CcrcReview).lines[1]).toMatchObject({ action: 'exclude', note: 'This row is an authorization, not a receipt.', amountCents: 39975 });
});
test('a missing tuition charge requires an explicit unapplied-credit choice and leaves parent balance unknown', async () => {
  const value = readyCcrcStatementFixture(); value.children[0].charges = []; vi.mocked(getCcrcStatement).mockResolvedValue(value); show(); await loaded();
  expect(screen.getByRole('checkbox', { name: 'Record line 1 as unapplied CCRC credit.' })).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Confirm and register payments' })).toBeDisabled();
  check('Record line 1 as unapplied CCRC credit.'); fill('Line 1 note (required)', 'The child’s tuition setup is pending.'); check('I checked line 1 against the original.'); check('I compared all payment lines and totals with the original statement.');
  fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await screen.findByText('Review saved. No payments have been registered.');
  expect((vi.mocked(saveCcrcReview).mock.calls[0][1].review as CcrcReview).lines[0]).toMatchObject({ allowUnappliedCredit: true, note: 'The child’s tuition setup is pending.' });
});
test('different checks keep their line-specific payment dates and references', async () => {
  show(); await loaded(); fill('Line 2 payment date (optional)', '2026-11-10'); fill('Line 2 payment reference (optional)', 'SYN-OTHER-CHECK'); expect(screen.getByText('Different receipt for this line: 2026-11-10 · SYN-OTHER-CHECK')).toBeVisible(); fill('Reconciliation note', 'The second child appears under a separate check.'); fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await screen.findByText('Review saved. No payments have been registered.');
  expect((vi.mocked(saveCcrcReview).mock.calls[0][1].review as CcrcReview).lines[1]).toMatchObject({ serviceMonth: '2026-10', paymentDate: '2026-11-10', paymentReference: 'SYN-OTHER-CHECK' });
});
test('an uncertain post blocks edits and duplicate clicks, then retries exactly the same request', async () => {
  vi.mocked(getCcrcStatement).mockResolvedValue(readyCcrcStatementFixture()); vi.mocked(postCcrcStatement).mockRejectedValueOnce(new Error('Disconnected')); show(); await loaded();
  check('I want to register these reviewed payments.'); fireEvent.click(screen.getByRole('button', { name: 'Confirm and register payments' })); await screen.findByRole('button', { name: 'Retry same save' });
  expect(screen.getByLabelText('Statement total ($)')).toBeDisabled(); expect(screen.getByRole('button', { name: 'Confirm and register payments' })).toBeDisabled();
  const first = vi.mocked(postCcrcStatement).mock.calls[0][1]; fireEvent.click(screen.getByRole('button', { name: 'Retry same save' })); await screen.findByText('Payments registered. The child ledgers are updated.'); expect(vi.mocked(postCcrcStatement).mock.calls[1][1]).toEqual(first);
});
test('a conflict preserves corrected values while explicit balance refresh updates versions and requires fresh review', async () => {
  show(); await loaded(); fill('Line 1 amount paid ($)', '601.25');
  vi.mocked(saveCcrcReview).mockRejectedValueOnce(Object.assign(new Error('This statement changed.'), { isAxiosError: true, response: { status: 409 } })); fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await screen.findByText('This statement changed.');
  const fresh = ccrcStatementFixture(); fresh.version = 8; fresh.children[0].billingVersion = 9; vi.mocked(getCcrcStatement).mockResolvedValue(fresh);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh balances for review' })); await screen.findByText('Balances refreshed. Check the payment lines again, then save the review.');
  expect(screen.getByLabelText('Line 1 amount paid ($)')).toHaveValue('601.25'); expect(screen.getByRole('checkbox', { name: 'I checked line 1 against the original.' })).not.toBeChecked();
  fill('Line 1 child', 'child-maya'); fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await screen.findByText('Review saved. No payments have been registered.'); expect(vi.mocked(saveCcrcReview).mock.calls[1][1]).toMatchObject({ version: 8, review: { lines: [expect.objectContaining({ amountCents: 60125, billingVersion: 9 }), expect.anything()] } });
});
test('cancel and reopen retain the original and never post payments', async () => {
  show(); await loaded(); fill('Cancellation reason', 'Need to check a missing source page.'); fireEvent.click(screen.getByRole('button', { name: 'Cancel draft without payments' })); await screen.findByText('Draft cancelled. No payments were registered.'); expect(postCcrcStatement).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download original' })).toBeEnabled(); fireEvent.click(screen.getByRole('button', { name: 'Reopen draft' })); await screen.findByText('Draft reopened for review.'); expect(reopenCcrcStatement).toHaveBeenCalledWith('source/a', { version: 4, requestId: expect.any(String) }, expect.any(AbortSignal));
});
test.each(['expired', 'denied'] as const)('%s access clears protected values and aborts an in-flight save', async event => {
  let finish!: (value: CcrcStatement) => void; vi.mocked(saveCcrcReview).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  show(); await loaded(); fill('Reconciliation note', 'Sensitive private draft'); fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await waitFor(() => expect(saveCcrcReview).toHaveBeenCalled());
  const signal = vi.mocked(saveCcrcReview).mock.calls[0][2]!;
  act(() => fixture[event].forEach(callback => callback())); expect(signal.aborted).toBe(true); expect(screen.queryByDisplayValue('Sensitive private draft')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic-CCRC.pdf')).not.toBeInTheDocument();
  await act(async () => finish(readyCcrcStatementFixture())); expect(screen.queryByText('Review saved. No payments have been registered.')).not.toBeInTheDocument();
});
test.each(['expired', 'denied'] as const)('%s access ignores a late file reader before restoring private bytes or starting upload', async event => {
  let finish!: (value: typeof filePayload) => void; vi.mocked(readDocumentFile).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  show('admin', '/billing/ccrc-statements'); fireEvent.change(screen.getByLabelText('Choose statement file'), { target: { files: [new File(['synthetic'], 'private-original.pdf', { type: 'application/pdf' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Read statement' }));
  await waitFor(() => expect(readDocumentFile).toHaveBeenCalled()); const signal = vi.mocked(readDocumentFile).mock.calls[0][1];
  act(() => fixture[event].forEach(callback => callback())); expect(signal.aborted).toBe(true);
  await act(async () => finish(filePayload)); expect(uploadCcrcStatement).not.toHaveBeenCalled(); expect(screen.queryByText('private-original.pdf')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Retry same upload' })).not.toBeInTheDocument();
  await waitFor(() => expect(fixture.report).toHaveBeenLastCalledWith(false, false));
});
test('connection warnings keep an uncertain review and its request identity mounted', async () => {
  const auth = { account: { ...testAccount, role: 'admin' as const }, ready: true, notice: '', serverUnavailable: false, signIn: async () => {}, signOut: async () => {}, changePassword: async () => {}, retry: async () => {} };
  const view = () => <AuthContext.Provider value={auth}><MemoryRouter initialEntries={['/billing/ccrc-statements?statement=source%2Fa']}><CCRCStatements /></MemoryRouter></AuthContext.Provider>;
  const rendered = render(view()); await loaded(); fill('Reconciliation note', 'Keep this review.'); vi.mocked(saveCcrcReview).mockRejectedValueOnce(new Error('Disconnected')); fireEvent.click(screen.getByRole('button', { name: 'Save review' })); await screen.findByRole('button', { name: 'Retry same save' });
  const body = vi.mocked(saveCcrcReview).mock.calls[0][1]; auth.serverUnavailable = true; rendered.rerender(view()); expect(screen.getByLabelText('Reconciliation note')).toHaveValue('Keep this review.'); expect(getCcrcStatement).toHaveBeenCalledTimes(1);
  auth.serverUnavailable = false; rendered.rerender(view()); fireEvent.click(screen.getByRole('button', { name: 'Retry same save' })); await screen.findByText('Review saved. No payments have been registered.'); expect(vi.mocked(saveCcrcReview).mock.calls[1][1]).toEqual(body);
});
test('private originals render only after an authenticated fetch and object URLs are revoked on access loss', async () => {
  const data = ccrcStatementFixture(); data.filename = 'private.jpg'; data.contentType = 'image/jpeg'; vi.mocked(getCcrcStatement).mockResolvedValue(data); show(); await loaded();
  expect(getCcrcStatementContent).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Preview original statement' })); await screen.findByRole('img', { name: 'Original CCRC payment statement' });
  expect(getCcrcStatementContent).toHaveBeenCalledWith('source/a', expect.any(AbortSignal)); expect(fixture.created).toHaveBeenCalledTimes(1);
  act(() => fixture.expired.forEach(callback => callback())); expect(fixture.revoked).toHaveBeenCalledWith('blob:private-statement'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
test('a duplicate originating from a manual payment links to billing rather than a nonexistent statement', async () => {
  const data = readyCcrcStatementFixture(); data.duplicateWarnings = [{ kind: 'exact', statementId: null, message: 'Already recorded in a child ledger.' }]; vi.mocked(getCcrcStatement).mockResolvedValue(data); show(); await loaded();
  const warnings = within(screen.getByRole('region', { name: 'Duplicate payment checks' })); expect(warnings.getByRole('link', { name: 'Review existing child payments' })).toHaveAttribute('href', '/billing'); expect(warnings.queryByRole('link', { name: 'Open earlier statement' })).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Confirm and register payments' })).toBeDisabled();
});
test('refreshing a registered statement keeps it read only without creating a false unsaved draft', async () => {
  const data = readyCcrcStatementFixture(); data.status = 'posted'; vi.mocked(getCcrcStatement).mockResolvedValue(data); show(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh statement' })); await waitFor(() => expect(getCcrcStatement).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Statement total ($)')).toBeDisabled(); expect(screen.getByRole('checkbox', { name: 'I compared all payment lines and totals with the original statement.' })).toBeChecked();
  await waitFor(() => expect(fixture.report).toHaveBeenLastCalledWith(false, false)); expect(screen.queryByText('Save your latest review before registering payments.')).not.toBeInTheDocument();
});
