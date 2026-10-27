import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Billing from './Billing';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import { AuthContext } from '../auth/context';
import { getBillingChild, getBillingSummary, saveBillingChange } from '../api/billing';
import type { BillingDetail, BillingSummary, BillingTotals } from '../api/billing';

const fixtures = vi.hoisted(() => ({ report: vi.fn(), expired: new Set<() => void>() }));
vi.mock('../components/UnsavedChangesContext', () => ({ useUnsavedChanges: () => fixtures.report }));
vi.mock('../auth/transport', () => ({ authError: (_failure: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { fixtures.expired.add(callback); return () => fixtures.expired.delete(callback); } }));
vi.mock('../api/billing', async original => ({ ...await original<typeof import('../api/billing')>(), getBillingChild: vi.fn(), getBillingSummary: vi.fn(), saveBillingChange: vi.fn() }));
const totals = (overrides: Partial<BillingTotals> = {}): BillingTotals => ({ chargedCents: 150000, paidCents: 0, receivedCents: 0, outstandingCents: 150000, creditCents: 0, familyOutstandingCents: 50000, ccrcOutstandingCents: 100000, familyCreditCents: 0, ccrcCreditCents: 0, overdueCents: 50000, ...overrides });
const detail = (): BillingDetail => ({ child: { id: 'child/a', name: 'Maya Example', active: true }, version: 2, today: '2026-10-06', timeZone: 'America/Los_Angeles',
  profile: { enabled: true, billingStart: '2026-10-01', billingEnd: null, registrationCents: 20000, effectiveMonth: '2026-10', familyCents: 50000, ccrcCents: 100000, familyDueDay: 1, ccrcDueDay: 15, rates: [] },
  charges: [{ id: 'charge-1', kind: 'monthly', month: '2026-10', title: 'October tuition', createdAt: '2026-10-01T12:00:00Z', amountCents: 150000, paidCents: 0, outstandingCents: 150000, status: 'unpaid', adjustments: [],
    payers: { family: { amountCents: 50000, paidCents: 0, outstandingCents: 50000, dueDate: '2026-10-01', daysOverdue: 5, overdue: true }, ccrc: { amountCents: 100000, paidCents: 0, outstandingCents: 100000, dueDate: '2026-10-15', daysOverdue: 0, overdue: false } } }],
  payments: [], history: [], totals: totals() });
const summary = (value = detail()): BillingSummary => ({ today: value.today, timeZone: value.timeZone, totals: value.totals, children: [{ child: value.child, version: value.version, profile: value.profile, totals: value.totals, overdueCount: 1 }] });
function show(role: 'admin' | 'editor' | 'viewer' | 'teacher' = 'admin', path = '/billing?child=child%2Fa') {
  return render(<SignedIn account={{ ...testAccount, role }}><MemoryRouter initialEntries={[path]}><Billing /></MemoryRouter></SignedIn>);
}
async function loaded() { await screen.findByRole('heading', { name: 'Maya Example' }); }
function fill(label: string, value: string, scope: Pick<typeof screen, 'getByLabelText'> = screen) { fireEvent.change(scope.getByLabelText(label, { exact: true }), { target: { value } }); }
async function payment() {
  await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
  const form = within(screen.getByRole('form', { name: 'Record payment' }));
  fill('Amount received ($)', '125.25', form); fill('Reference (optional)', 'Synthetic receipt 1', form);
  return form;
}
beforeEach(() => {
  vi.clearAllMocks(); fixtures.expired.clear();
  vi.mocked(getBillingSummary).mockResolvedValue(summary()); vi.mocked(getBillingChild).mockResolvedValue(detail()); vi.mocked(saveBillingChange).mockResolvedValue({ ...detail(), version: 3 });
});

test('imported payments link to their retained original statement while manual payments have no invented source', async () => {
  const value = detail(), payment = { id: 'payment-imported', payer: 'ccrc' as const, amountCents: 10000, date: '2026-10-05', method: 'ccrc', reference: 'SYN-CHECK', allocatedCents: 10000, creditCents: 0, reversed: false, allocations: [], at: '2026-10-05T18:00:00Z', actorId: 'admin' };
  value.payments = [{ ...payment, source: { statementId: 'source/a', page: 2 } }, { ...payment, id: 'payment-manual' }];
  vi.mocked(getBillingChild).mockResolvedValue(value); show(); await loaded();
  expect(screen.getAllByRole('link', { name: 'Open source statement' })).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Open source statement' })).toHaveAttribute('href', '/billing/ccrc-statements?statement=source%2Fa'); expect(screen.getByText('· Page 2')).toBeVisible();
});

test.each(['editor', 'viewer', 'teacher'] as const)('%s cannot load private billing records or controls', role => {
  show(role);
  expect(screen.getByRole('alert')).toHaveTextContent('Administrator access is required');
  expect(getBillingSummary).not.toHaveBeenCalled(); expect(getBillingChild).not.toHaveBeenCalled(); expect(saveBillingChange).not.toHaveBeenCalled();
});

test('child ledger keeps family and CCRC responsibility, dates and overdue status separate', async () => {
  show(); await loaded();
  const charge = within(screen.getByRole('article', { name: 'Charge October tuition' }));
  expect(charge.getByText('5 days overdue')).toBeVisible();
  expect(charge.getByText('2026-10-01')).toBeVisible(); expect(charge.getByText('2026-10-15')).toBeVisible();
  expect(charge.getAllByText('$500.00')).toHaveLength(2); expect(charge.getAllByText('$1,000.00')).toHaveLength(2);
  expect(getBillingChild).toHaveBeenCalledWith('child/a', expect.any(AbortSignal));
  expect(screen.queryByText('Tax identifier')).not.toBeInTheDocument();
});

test('payment waits for its result, preserves exact cents and enables navigation only after saved state settles', async () => {
  let finish!: (value: BillingDetail) => void;
  vi.mocked(saveBillingChange).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  show(); const form = await payment();
  fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalledTimes(1));
  expect(saveBillingChange).toHaveBeenCalledWith('child/a', 'payments', { payer: 'family', amountCents: 12525, date: '2026-10-06', method: 'cash', reference: 'Synthetic receipt 1', chargeId: 'charge-1', version: 2, requestId: expect.any(String) }, expect.any(AbortSignal));
  expect(fixtures.report).toHaveBeenLastCalledWith(true, true);
  expect(form.getByRole('button', { name: 'Save payment' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('form', { name: 'Record payment' })); expect(saveBillingChange).toHaveBeenCalledTimes(1);
  const saved = detail(); saved.version = 3; saved.charges[0].payers.family.outstandingCents = 37475;
  await act(async () => finish(saved));
  await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Saved. Balances and reminders are up to date.'); expect(fixtures.report).toHaveBeenLastCalledWith(false, false); });
  expect(screen.queryByRole('form', { name: 'Record payment' })).not.toBeInTheDocument();
});

test('an uncertain payment keeps its request identity and entries for a safe same-save retry', async () => {
  vi.mocked(saveBillingChange).mockRejectedValueOnce(new Error('Disconnected'));
  show(); const form = await payment(); fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await screen.findByRole('button', { name: 'Retry same save' });
  expect(form.getByLabelText('Reference (optional)')).toHaveValue('Synthetic receipt 1');
  expect(form.getByLabelText('Amount received ($)')).toBeDisabled();
  const first = vi.mocked(saveBillingChange).mock.calls[0][2];
  fireEvent.click(screen.getByRole('button', { name: 'Retry same save' }));
  await screen.findByText('Saved. Balances and reminders are up to date.');
  expect(vi.mocked(saveBillingChange).mock.calls[1][2]).toEqual(first);
});

test('a connection warning keeps an uncertain payment and its idempotent retry mounted', async () => {
  const auth = { account: { ...testAccount, role: 'admin' as const }, ready: true, notice: '', serverUnavailable: false, signIn: async () => {}, signOut: async () => {}, changePassword: async () => {}, retry: async () => {} };
  const view = () => <AuthContext.Provider value={auth}><MemoryRouter initialEntries={['/billing?child=child%2Fa']}><Billing /></MemoryRouter></AuthContext.Provider>;
  const shown = render(view()); const form = await payment();
  vi.mocked(saveBillingChange).mockRejectedValueOnce(new Error('Disconnected'));
  fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await screen.findByRole('button', { name: 'Retry same save' });
  const first = vi.mocked(saveBillingChange).mock.calls[0][2];
  auth.serverUnavailable = true; shown.rerender(view());
  expect(screen.getByText('Connection interrupted. Your unsaved billing entry is kept here; reconnect before saving.')).toBeVisible();
  expect(screen.getByLabelText('Reference (optional)')).toHaveValue('Synthetic receipt 1');
  expect(getBillingChild).toHaveBeenCalledTimes(1);
  auth.serverUnavailable = false; shown.rerender(view());
  fireEvent.click(screen.getByRole('button', { name: 'Retry same save' }));
  await screen.findByText('Saved. Balances and reminders are up to date.');
  expect(vi.mocked(saveBillingChange).mock.calls[1][2]).toEqual(first);
});

test('a conflict preserves the draft while refresh loads the new version before resubmission', async () => {
  vi.mocked(saveBillingChange).mockRejectedValueOnce(Object.assign(new Error('Conflict'), { isAxiosError: true, response: { status: 409 } }));
  show(); const form = await payment(); fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await screen.findByRole('alert'); expect(form.getByLabelText('Amount received ($)')).toHaveValue(125.25);
  vi.mocked(getBillingChild).mockResolvedValue({ ...detail(), version: 7 });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh child billing' }));
  await waitFor(() => expect(getBillingChild).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(form.getByRole('button', { name: 'Save payment' })).toBeEnabled());
  fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await screen.findByText('Saved. Balances and reminders are up to date.');
  expect(vi.mocked(saveBillingChange).mock.calls[1][2]).toMatchObject({ version: 7, amountCents: 12525, reference: 'Synthetic receipt 1' });
});

test('overpayment is visibly kept as payer-specific credit and is never silently assigned to CCRC', async () => {
  show(); const form = await payment(); fill('Amount received ($)', '600.00', form);
  expect(form.getByText('$500.00 will apply to the selected charge. $100.00 will remain as Family credit.')).toBeVisible();
  fill('Paid by', 'ccrc', form);
  expect(form.getByText('$600.00 will apply to the selected charge. $0.00 will remain as CCRC credit.')).toBeVisible();
});

test('new profile starts its first rate at the chosen billing month and uses explicit registration creation', async () => {
  const value = detail(); value.profile = null; value.charges = [];
  vi.mocked(getBillingChild).mockResolvedValue(value); show(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Set up tuition' }));
  const form = within(screen.getByRole('form', { name: 'Billing setup' }));
  fill('Billing starts', '2026-09-10', form); fill('Monthly tuition ($)', '1000.50', form); fill('Registration fee ($)', '250.00', form);
  expect(form.getByLabelText('Applies from month')).toHaveValue('2026-09');
  fireEvent.click(form.getByRole('button', { name: 'Save tuition setup' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][1]).toBe('profile');
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ billingStart: '2026-09-10', effectiveMonth: '2026-09', monthlyCents: 100050, ccrcManaged: false, registrationCents: 25000 });
  expect(saveBillingChange).toHaveBeenCalledTimes(1);
});

test('an enrollment pause requires a reviewed new billing period before explicit resumption', async () => {
  const value = detail(); value.profile = { ...value.profile!, enabled: false, pausedForEnrollment: true, pausedOn: '2026-09-15' };
  vi.mocked(getBillingChild).mockResolvedValue(value); show(); await loaded();
  expect(screen.getByText(/Reactivating the child does not restart billing/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Edit tuition setup' }));
  const form = within(screen.getByRole('form', { name: 'Billing setup' }));
  expect(form.getByLabelText('Billing starts')).toHaveValue('2026-10-06');
  expect(form.getByText(/Monthly charging will stay paused/)).toBeVisible();
  fireEvent.click(form.getByRole('checkbox', { name: 'Create monthly tuition charges' }));
  expect(form.getByText(/Saving creates any missing monthly charges from 2026-10-06 through 2026-10-06/)).toBeVisible();
  fireEvent.click(form.getByRole('button', { name: 'Save tuition setup' }));
  expect(saveBillingChange).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole('checkbox', { name: 'I reviewed the new billing start and end dates before resuming tuition.' }));
  fireEvent.click(form.getByRole('button', { name: 'Save tuition setup' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ enabled: true, billingStart: '2026-10-06' });
});

test('session loss clears private records and drafts and ignores a late payment response', async () => {
  let finish!: (value: BillingDetail) => void;
  vi.mocked(saveBillingChange).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  show(); const form = await payment(); fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  const signal = vi.mocked(saveBillingChange).mock.calls[0][3]!;
  act(() => fixtures.expired.forEach(callback => callback()));
  expect(signal.aborted).toBe(true); expect(screen.queryByText('Maya Example')).not.toBeInTheDocument(); expect(screen.queryByDisplayValue('Synthetic receipt 1')).not.toBeInTheDocument();
  await act(async () => finish(detail()));
  expect(screen.queryByText('Maya Example')).not.toBeInTheDocument(); expect(screen.queryByText('Saved. Balances and reminders are up to date.')).not.toBeInTheDocument();
});

test('summary filters find overdue and expected CCRC balances without calling individual ledgers', async () => {
  show('admin', '/billing?status=overdue');
  await screen.findByRole('article', { name: 'Maya Example billing' });
  expect(screen.getByLabelText('Payment status')).toHaveValue('overdue');
  expect(getBillingChild).not.toHaveBeenCalled();
  fill('Search billing children', 'Nobody'); expect(screen.getByText('No children match these filters.')).toBeVisible();
});

test('registration is a separate explicit fee with the chosen payer amounts and due dates', async () => {
  show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Add registration fee' }));
  const form = within(screen.getByRole('form', { name: 'Add registration fee' }));
  fill('Family amount ($)', '75.50', form); fill('CCRC amount ($)', '0.00', form); fill('Family due date', '2026-10-10', form); fill('Reason', 'Initial registration', form);
  fireEvent.click(form.getByRole('button', { name: 'Save registration fee' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0]).toEqual(['child/a', 'charges', { version: 2, requestId: expect.any(String), kind: 'registration', title: 'Registration fee', familyCents: 7550, ccrcCents: 0, familyDueDate: '2026-10-10', ccrcDueDate: '2026-10-06', reason: 'Initial registration' }, expect.any(AbortSignal)]);
});

test('waiving an unpaid family balance is an attributed adjustment rather than a fabricated payment', async () => {
  show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Adjust October tuition' }));
  const form = within(screen.getByRole('form', { name: 'Adjust a charge' }));
  fill('Adjustment action', 'waive', form); fill('Reason', 'Approved family waiver', form);
  fireEvent.click(form.getByRole('button', { name: 'Save charge adjustment' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][1]).toBe('charges/charge-1/adjustments');
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ payer: 'family', amountCents: -50000, reason: 'Approved family waiver' });
});

test('credit allocation and payment reversal use the selected retained payment with a correction reason', async () => {
  const value = detail(); value.payments = [{ id: 'payment/a', payer: 'family', amountCents: 60000, date: '2026-10-05', method: 'check', reference: 'Check 123', allocatedCents: 50000, creditCents: 10000, reversed: false, allocations: [], at: '2026-10-05T12:00:00Z', actorId: 'admin' }];
  vi.mocked(getBillingChild).mockResolvedValue(value); vi.mocked(saveBillingChange).mockResolvedValue(value);
  show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Apply this payment credit' }));
  const credit = within(screen.getByRole('form', { name: 'Apply credit' }));
  fill('Credit amount ($)', '25.25', credit); fireEvent.click(credit.getByRole('button', { name: 'Save credit allocation' }));
  await screen.findByText('Saved. Balances and reminders are up to date.');
  expect(vi.mocked(saveBillingChange).mock.calls[0][1]).toBe('credits');
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ paymentId: 'payment/a', chargeId: 'charge-1', amountCents: 2525 });
  fireEvent.click(screen.getByRole('button', { name: 'Reverse this payment' }));
  const reverse = within(screen.getByRole('form', { name: 'Reverse payment' }));
  fill('Reason', 'Payment entered against the wrong child', reverse); fireEvent.click(reverse.getByRole('button', { name: 'Confirm payment reversal' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalledTimes(2));
  expect(vi.mocked(saveBillingChange).mock.calls[1][1]).toBe('payments/payment%2Fa/reverse');
  expect(vi.mocked(saveBillingChange).mock.calls[1][2]).toMatchObject({ reason: 'Payment entered against the wrong child' });
});

const variableDetail = (pending = true): BillingDetail => {
  const value = detail();
  value.today = '2026-11-21';
  value.profile = { enabled: true, billingStart: '2026-10-01', billingEnd: null, registrationCents: 0, effectiveMonth: '2026-10', monthlyCents: 120000, ccrcManaged: true, familyDueDay: 1, rates: [] };
  value.charges = [{ id: 'monthly:2026-10', kind: 'monthly', month: '2026-10', title: 'Tuition · 2026-10', createdAt: '2026-10-01T12:00:00Z', amountCents: 120000, tuitionCents: 120000, paidCents: 100000, outstandingCents: 20000, status: pending ? 'awaiting_ccrc' : 'partial', settlementMode: 'ccrc_actual', pendingCcrc: pending, ccrcReview: pending ? null : { familyDueDate: '2026-11-28', reason: 'October statement checked', at: '2026-11-21T12:00:00Z', actorId: 'admin' }, allocationCapacityCents: { family: 20000, ccrc: 20000 }, adjustments: [], payers: {
    family: { amountCents: 20000, paidCents: 0, outstandingCents: 20000, dueDate: pending ? null : '2026-11-28', daysOverdue: 0, overdue: false },
    ccrc: { amountCents: 100000, paidCents: 100000, outstandingCents: 0, dueDate: null, daysOverdue: 0, overdue: false },
  } }];
  value.totals = totals({ chargedCents: 120000, paidCents: 100000, receivedCents: 100000, outstandingCents: 20000, familyOutstandingCents: pending ? 0 : 20000, ccrcOutstandingCents: 0, overdueCents: 0, awaitingCcrcCents: pending ? 20000 : 0, awaitingCcrcCount: pending ? 1 : 0 });
  return value;
};

test('CCRC setup asks for the total monthly fee without a fixed subsidy estimate', async () => {
  const value = variableDetail(); vi.mocked(getBillingChild).mockResolvedValue(value);
  show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Edit tuition setup' }));
  const form = within(screen.getByRole('form', { name: 'Billing setup' }));
  expect(form.getByLabelText('Monthly tuition ($)')).toHaveValue(1200);
  expect(form.getByRole('checkbox', { name: 'CCRC helps pay this child’s tuition' })).toBeChecked();
  expect(form.queryByLabelText('CCRC monthly amount ($)')).not.toBeInTheDocument();
  expect(form.queryByLabelText('Parent due day')).not.toBeInTheDocument();
  fill('Monthly tuition ($)', '1250.25', form); fireEvent.click(form.getByRole('button', { name: 'Save tuition setup' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toEqual({ version: 2, requestId: expect.any(String), billingStart: '2026-10-01', billingEnd: null, effectiveMonth: '2026-11', monthlyCents: 125025, ccrcManaged: true, familyDueDay: 1, registrationCents: 0, enabled: true, reason: '' });
});

test('an October CCRC balance remains provisional in November without a parent overdue label', async () => {
  vi.mocked(getBillingChild).mockResolvedValue(variableDetail()); show(); await loaded();
  const charge = within(screen.getByRole('article', { name: 'Charge Tuition · 2026-10' }));
  expect(charge.getByText('Awaiting CCRC')).toBeVisible();
  expect(charge.getByText('Remaining tuition · pending CCRC review')).toBeVisible();
  expect(charge.getByText('$200.00')).toBeVisible(); expect(charge.getByText('Set after CCRC review')).toBeVisible();
  expect(charge.queryByText(/days overdue/)).not.toBeInTheDocument();
  expect(screen.getByText('1 service month awaits CCRC review.')).toBeVisible();
});

test('an actual CCRC receipt targets its service month even with no fixed CCRC receivable', async () => {
  vi.mocked(getBillingChild).mockResolvedValue(variableDetail()); show(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Record payment for Tuition · 2026-10' }));
  const form = within(screen.getByRole('form', { name: 'Record payment' }));
  expect(form.getByLabelText('Paid by')).toHaveValue('ccrc');
  expect(form.getByLabelText('Payment date')).toHaveValue('2026-11-21');
  expect(form.getByRole('option', { name: 'Tuition · 2026-10 · Service month 2026-10 · $200.00 remaining' })).toBeInTheDocument();
  fill('Amount received ($)', '250.25', form);
  expect(form.getByText('$200.00 will apply to the selected charge. $50.25 will remain as CCRC credit.')).toBeVisible();
  fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ payer: 'ccrc', amountCents: 25025, date: '2026-11-21', chargeId: 'monthly:2026-10', method: 'ccrc' });
});

test('finishing CCRC review requires confirmation and sets the parent due date from today rather than October', async () => {
  vi.mocked(getBillingChild).mockResolvedValue(variableDetail()); vi.mocked(saveBillingChange).mockResolvedValue(variableDetail(false));
  show(); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Finish CCRC review for Tuition · 2026-10' }));
  const form = within(screen.getByRole('form', { name: 'Finish CCRC review' }));
  expect(form.getByLabelText('Parent due date')).toHaveValue('2026-11-21');
  expect(form.getByLabelText('Parent due date')).toHaveAttribute('min', '2026-11-21');
  fill('Review note', 'All October receipts checked', form); fill('Parent due date', '2026-11-28', form);
  fireEvent.click(form.getByRole('button', { name: 'Confirm parent balance' })); expect(saveBillingChange).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole('checkbox', { name: 'I checked the CCRC payments for this service month.' }));
  fireEvent.click(form.getByRole('button', { name: 'Confirm parent balance' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][1]).toBe('charges/monthly%3A2026-10/ccrc-review');
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ version: 2, familyDueDate: '2026-11-28', reason: 'All October receipts checked' });
  await screen.findByText('Saved. Balances and reminders are up to date.');
  expect(screen.getByText('Parents still owe')).toBeVisible();
  expect(screen.queryByText('Awaiting CCRC', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Record payment for Tuition · 2026-10' }));
  expect(screen.getByLabelText('Paid by')).toHaveValue('family');
});

test('converting an earlier fixed split is explicit and records a reason before parent reminders pause', async () => {
  vi.mocked(saveBillingChange).mockResolvedValue(variableDetail()); show(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Use actual CCRC payments for October tuition' }));
  const form = within(screen.getByRole('form', { name: 'Review earlier CCRC charge' }));
  expect(form.getByText(/earlier fixed split stays in history/)).toBeVisible();
  fill('Reason', 'CCRC pays the actual amount after the month of care', form);
  fireEvent.click(form.getByRole('button', { name: 'Use actual CCRC payments' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][1]).toBe('charges/charge-1/ccrc-mode');
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ reason: 'CCRC pays the actual amount after the month of care' });
});

test('adjusting variable tuition changes the total without silently changing the parent due date', async () => {
  vi.mocked(getBillingChild).mockResolvedValue(variableDetail()); show(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Adjust Tuition · 2026-10' }));
  const form = within(screen.getByRole('form', { name: 'Adjust a charge' }));
  expect(form.queryByLabelText('Responsible payer')).not.toBeInTheDocument();
  expect(form.queryByLabelText('New due date (optional)')).not.toBeInTheDocument();
  fill('Adjustment amount ($)', '50.25', form); fill('Reason', 'Corrected October fee', form);
  fireEvent.click(form.getByRole('button', { name: 'Save charge adjustment' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toEqual({ version: 2, requestId: expect.any(String), payer: 'family', amountCents: -5025, reason: 'Corrected October fee' });
});

test('fully parent-paid tuition still accepts a service-month CCRC receipt as explicit unapplied credit', async () => {
  const value = variableDetail();
  Object.assign(value.charges[0], { paidCents: 120000, outstandingCents: 0, ccrcReceivedCents: 0, ccrcUnappliedCents: 0, allocationCapacityCents: { family: 0, ccrc: 0 } });
  Object.assign(value.charges[0].payers.family, { amountCents: 120000, paidCents: 120000, outstandingCents: 0 });
  Object.assign(value.charges[0].payers.ccrc, { amountCents: 0, paidCents: 0 });
  vi.mocked(getBillingChild).mockResolvedValue(value); show(); await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Record payment for Tuition · 2026-10' }));
  const form = within(screen.getByRole('form', { name: 'Record payment' }));
  expect(form.getByLabelText('Apply payment to')).toHaveValue('monthly:2026-10');
  expect(form.getByRole('option', { name: 'Tuition · 2026-10 · Service month 2026-10 · $0.00 remaining' })).toBeInTheDocument();
  fill('Amount received ($)', '1000.00', form);
  expect(form.getByText('$0.00 will apply to the selected charge. $1,000.00 will remain as CCRC credit.')).toBeVisible();
  fireEvent.click(form.getByRole('button', { name: 'Save payment' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ payer: 'ccrc', chargeId: 'monthly:2026-10', amountCents: 100000 });
});

test('unapplied CCRC receipts stay visible and require a distinct credit review before confirming parents owe zero', async () => {
  const value = variableDetail();
  Object.assign(value.charges[0], { paidCents: 120000, outstandingCents: 0, ccrcReceivedCents: 100000, ccrcUnappliedCents: 100000, allocationCapacityCents: { family: 0, ccrc: 0 } });
  Object.assign(value.charges[0].payers.family, { amountCents: 120000, paidCents: 120000, outstandingCents: 0 });
  Object.assign(value.charges[0].payers.ccrc, { amountCents: 0, paidCents: 0 });
  vi.mocked(getBillingChild).mockResolvedValue(value); show(); await loaded();
  const charge = within(screen.getByRole('article', { name: 'Charge Tuition · 2026-10' }));
  expect(charge.getByText('CCRC received')).toBeVisible(); expect(charge.getByText('CCRC applied to tuition')).toBeVisible(); expect(charge.getByText('CCRC unapplied credit')).toBeVisible();
  expect(charge.getByText(/unapplied credit needs review/)).toBeVisible();
  fireEvent.click(charge.getByRole('button', { name: 'Finish CCRC review for Tuition · 2026-10' }));
  const form = within(screen.getByRole('form', { name: 'Finish CCRC review' }));
  fill('Review note', 'Parent prepaid; review excess subsidy credit', form);
  fireEvent.click(form.getByRole('checkbox', { name: 'I checked the CCRC payments for this service month.' }));
  fireEvent.click(form.getByRole('button', { name: 'Confirm parent balance' })); expect(saveBillingChange).not.toHaveBeenCalled();
  fireEvent.click(form.getByRole('checkbox', { name: 'I reviewed the unapplied CCRC credit for this service month.' }));
  fireEvent.click(form.getByRole('button', { name: 'Confirm parent balance' }));
  await waitFor(() => expect(saveBillingChange).toHaveBeenCalled());
  expect(vi.mocked(saveBillingChange).mock.calls[0][2]).toMatchObject({ familyDueDate: '2026-11-21', acknowledgeUnappliedCredit: true });
});

test('a fully paid but unreviewed CCRC month is in awaiting review and is excluded from the paid filter', async () => {
  const value = variableDetail(); value.totals = { ...value.totals, outstandingCents: 0, awaitingCcrcCents: 0, awaitingCcrcCount: 1 };
  const list = summary(value); list.children[0].overdueCount = 0;
  vi.mocked(getBillingSummary).mockResolvedValue(list);
  show('admin', '/billing?status=paid'); await screen.findByText('No children match these filters.');
  expect(screen.queryByRole('article', { name: 'Maya Example billing' })).not.toBeInTheDocument();
  fill('Payment status', 'ccrc'); expect(screen.getByRole('article', { name: 'Maya Example billing' })).toBeVisible();
  expect(screen.getByRole('article', { name: 'Maya Example billing' })).toHaveTextContent('Parents owe: $0.00 · 1 month awaits CCRC review');
});


test('payment history distinguishes the original CCRC service month from an explicitly chosen credit allocation month', async () => {
  const value = variableDetail();
  value.charges.push({ ...value.charges[0], id: 'monthly:2026-11', month: '2026-11', title: 'Tuition · 2026-11' });
  value.payments = [{ id: 'ccrc-october', payer: 'ccrc', amountCents: 60000, date: '2026-11-21', method: 'ccrc', reference: 'October receipt', serviceChargeId: 'monthly:2026-10', serviceMonth: '2026-10', allocatedCents: 50000, creditCents: 10000, reversed: false, allocations: [{ chargeId: 'monthly:2026-11', amountCents: 50000, at: '2026-11-21T12:00:00Z', actorId: 'admin' }], at: '2026-11-21T12:00:00Z', actorId: 'admin' }];
  vi.mocked(getBillingChild).mockResolvedValue(value); show(); await loaded();
  const payment = within(screen.getByRole('article', { name: 'CCRC payment 2026-11-21' }));
  expect(payment.getByText('CCRC service month: 2026-10')).toBeVisible();
  expect(payment.getByRole('list', { name: 'Payment allocations' })).toHaveTextContent('Tuition · 2026-11 · $500.00');
  expect(payment.getByText('Applied to charges: $500.00 · Available credit: $100.00')).toBeVisible();
});
