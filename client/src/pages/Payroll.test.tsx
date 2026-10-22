import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Payroll from './Payroll';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../auth/context';
import { testAccount } from '../tests/authAccount';
import type { Role } from '../auth/context';
import type { Details } from '../components/payroll/types';
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });
const detail: Details = { staff: { id: 'a', name: 'Ari Employee', active: true }, profile: { version: 2, legalName: 'Ari', paymentMethod: 'provider', payFrequency: 'biweekly', providerReference: '', instructions: '', taxId: '••••1234', bankAccount: '', routingNumber: '', requiredDocuments: ['W-4'], rates: [], rules: { mode: 'ca-standard', workweekStart: 1, confirmed: false, reference: '', dailyScheduledMinutes: 480 } }, ledger: { version: 1, timeZone: 'America/Los_Angeles', sessions: [], days: [], history: [] }, documents: [], snapshots: [], missingDocuments: ['W-4'] };
function view(role: Role = 'admin') { return <AuthContext.Provider value={{ account: { ...testAccount, role }, ready: true, notice: '', serverUnavailable: false, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><MemoryRouter><Payroll /></MemoryRouter></AuthContext.Provider>; }
let currentDetail: Details;
beforeEach(() => { currentDetail = structuredClone(detail); vi.resetAllMocks(); vi.mocked(axios.get).mockImplementation(async url => ({ data: { data: String(url).endsWith('/a') || String(url).endsWith('/b') ? currentDetail : [{ id: 'a', name: 'Ari Employee', active: true }, { id: 'b', name: 'Bea Employee', active: true }] } })); vi.mocked(axios.post).mockResolvedValue({ data: { data: {} } }); });
async function employee(profile = false) { render(view()); await screen.findByRole('option', { name: 'Ari Employee' }); fireEvent.change(screen.getByLabelText('Payroll employee'), { target: { value: 'a' } }); await screen.findByRole('heading', { name: '1. Choose pay dates' }); if (profile) { fireEvent.click(screen.getByText('Employee setup & records')); fireEvent.click(screen.getByRole('button', { name: 'Private profile' })); } }
test.each(['editor', 'viewer', 'teacher'] as const)('%s cannot load any private payroll records', role => { render(view(role)); expect(screen.getByRole('alert')).toHaveTextContent('Administrator payroll access'); expect(axios.get).not.toHaveBeenCalled(); });
test('masked secrets are not submitted as replacements and missing required files are visible', async () => {
  await employee(true); expect(screen.getByText('Missing payroll documents: W-4')).toBeVisible(); expect(screen.getByLabelText('Employee SSN (optional)')).toHaveAttribute('placeholder', '••••1234');
  fireEvent.change(screen.getByLabelText('Reason for profile change'), { target: { value: 'Verified employee record' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private profile' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1)); const body = vi.mocked(axios.post).mock.calls[0][1]; expect(body).not.toHaveProperty('taxId'); expect(body).not.toHaveProperty('bankAccount'); expect(body).toMatchObject({ version: 2, reason: 'Verified employee record' });
});
test('employee and section changes confirm discarding unsaved private form entries', async () => {
  await employee(true); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('Legal employee name'), { target: { value: 'Unsaved private name' } });
  fireEvent.change(screen.getByLabelText('Payroll employee'), { target: { value: 'b' } }); expect(screen.getByLabelText('Payroll employee')).toHaveValue('a');
  fireEvent.click(screen.getByRole('button', { name: 'Hourly rates' })); expect(screen.getByLabelText('Legal employee name')).toHaveValue('Unsaved private name');
  expect(confirm).toHaveBeenCalledTimes(2); confirm.mockRestore();
});
test('a blocked preview cannot be finalized and describes taxes and payment explicitly', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')]; await employee(); period('2026-10-19');
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { start: '2026-10-19', end: '2026-10-25', timeZone: 'America/Los_Angeles', workedDays: 1, approvedMillis: 0, grossCents: 0, currency: 'USD', blockers: ['Missing checkout.'], rows: [], canFinalize: false } } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate gross pay' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Missing checkout.'); expect(screen.getByRole('button', { name: 'Save calculation' })).toBeDisabled();
  expect(screen.getByText('Gross only. Payment has not been executed. Taxes and withholding are not calculated.')).toBeVisible();
});
test('a saved mutation with a failed refresh cannot be accidentally submitted again as an unsaved change', async () => {
  await employee(true); vi.mocked(axios.get).mockRejectedValueOnce(new Error('Synthetic refresh failure'));
  fireEvent.change(screen.getByLabelText('Reason for profile change'), { target: { value: 'Synthetic reviewed change' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private profile' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The change was saved, but the latest record could not be loaded.');
  expect(screen.queryByRole('button', { name: 'Save private profile' })).not.toBeInTheDocument(); expect(axios.post).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Retry payroll' })).toBeEnabled();
});

function configured() {
  currentDetail.profile.rules = { ...currentDetail.profile.rules, confirmed: true, reference: 'Synthetic policy reviewer' };
  currentDetail.profile.rates = [{ id: 'rate-a', effectiveOn: '2026-01-01', cents: 2000, currency: 'USD', reason: 'Synthetic rate', sequence: 1 }];
}
function recordedDay(date: string, paidMillis = 8 * 3600000) {
  return { date, rawMillis: paidMillis, unpaidMillis: 0, paidMillis, incomplete: false, approval: null };
}
function period(start: string, end = start) {
  fireEvent.change(screen.getByLabelText('Pay period start'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('Pay period end'), { target: { value: end } });
}
test('choosing an employee opens a guided calculation without requiring private identifiers', async () => {
  configured(); currentDetail.profile.taxId = ''; currentDetail.profile.bankAccount = '';
  await employee();
  expect(screen.getByRole('heading', { name: '2. Review hours' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '3. Calculate gross pay' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Calculate pay' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByLabelText('Employee SSN (optional)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Bank account')).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});
test('recorded-hours approval is explicit, retains the selected dates and preserves exact recorded milliseconds', async () => {
  configured(); const exactMillis = 7.5 * 3600000 + 123;
  currentDetail.ledger.days = [recordedDay('2026-10-19', exactMillis)];
  await employee(); period('2026-10-19');
  expect(axios.post).not.toHaveBeenCalled();
  const approve = screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' });
  fireEvent.click(approve); expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('I checked the hours and overtime for 2026-10-19.'));
  vi.mocked(axios.post).mockImplementationOnce(async (_url, body) => {
    currentDetail.ledger = { ...currentDetail.ledger, version: 2, days: [{ ...currentDetail.ledger.days[0], approval: body as Details['ledger']['days'][number]['approval'] }] };
    return { data: { data: {} } };
  });
  fireEvent.click(approve);
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][0]).toMatch(/\/a\/approvals$/);
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ version: 1, date: '2026-10-19', status: 'approved', regularMillis: exactMillis, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, rulesReviewed: true });
  await screen.findByText('Saved.');
  expect(screen.getByLabelText('Pay period start')).toHaveValue('2026-10-19');
  expect(screen.getByLabelText('Pay period end')).toHaveValue('2026-10-19');
});
test('hour review includes recorded days outside the selected period when they share its overtime workweek', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19'), recordedDay('2026-10-20')];
  await employee(); period('2026-10-20');
  fireEvent.click(screen.getByText('Related workweek days'));
  expect(screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-20' })).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});

const detailedCases: { label: string; days: Details['ledger']['days'] }[] = [
  { label: 'daily overtime', days: [recordedDay('2026-10-19', 9 * 3600000)] },
  { label: 'weekly overtime despite eight-hour days', days: Array.from({ length: 6 }, (_, index) => recordedDay('2026-10-' + String(19 + index))) },
  { label: 'seven worked days despite short shifts', days: Array.from({ length: 7 }, (_, index) => recordedDay('2026-10-' + String(19 + index), 3600000)) },
  { label: 'an existing approved premium', days: [{ ...recordedDay('2026-10-19'), approval: { status: 'approved', regularMillis: 8 * 3600000, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 100, reason: 'Existing reviewed premium', rulesReviewed: true } }] },
];
test.each(detailedCases)('$label requires a detailed review rather than replacing it with a straight-time approval', async ({ days }) => {
  configured(); currentDetail.ledger.days = structuredClone(days);
  await employee(); period('2026-10-19');
  expect(screen.queryByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review overtime and adjustments for 2026-10-19' })).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});
test('changing pay dates clears the previous calculation before it can be saved for a different period', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')];
  await employee(); period('2026-10-19');
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { start: '2026-10-19', end: '2026-10-19', timeZone: 'America/Los_Angeles', workedDays: 1, approvedMillis: 8 * 3600000, grossCents: 16000, currency: 'USD', blockers: [], rows: [], canFinalize: true, fingerprint: 'synthetic-preview' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate gross pay' }));
  expect(await screen.findByRole('button', { name: 'Save calculation' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Pay period end'), { target: { value: '2026-10-20' } });
  expect(screen.queryByRole('button', { name: 'Save calculation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Gross pay before taxes: $160.00' })).not.toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('unsaved guided review blocks calculation until the administrator confirms discarding it', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')];
  await employee(); period('2026-10-19');
  fireEvent.click(screen.getByLabelText('I checked the hours and overtime for 2026-10-19.'));
  expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeDisabled();
  // Re-selecting the current section must not clear the outstanding draft.
  fireEvent.click(screen.getByRole('button', { name: 'Calculate pay' }));
  expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeDisabled();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.getByLabelText('I checked the hours and overtime for 2026-10-19.')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeDisabled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.getByLabelText('I checked the hours and overtime for 2026-10-19.')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeEnabled();
    expect(screen.getByLabelText('Pay period start')).toHaveValue('2026-10-19');
    expect(axios.post).not.toHaveBeenCalled();
  } finally { confirm.mockRestore(); }
});

test('a delayed historical calculation cannot reappear after the pay dates change', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')];
  currentDetail.snapshots = [{ id: 'saved-a', start: '2026-10-19', end: '2026-10-19', at: '2026-10-20T00:00:00Z', grossCents: 16000, currency: 'USD' }];
  await employee(); period('2026-10-19');
  let complete!: (response: Awaited<ReturnType<typeof axios.get>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof axios.get>>>(resolve => { complete = resolve; });
  // This mock deliberately resolves even after abort, as a late transport can.
  vi.mocked(axios.get).mockReturnValueOnce(pending);
  fireEvent.click(screen.getByRole('button', { name: 'Open calculation snapshot' }));
  const signal = vi.mocked(axios.get).mock.calls.at(-1)?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  fireEvent.change(screen.getByLabelText('Pay period end'), { target: { value: '2026-10-20' } });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete({ data: { data: { sourceChanged: false, preview: { start: '2026-10-19', end: '2026-10-19', timeZone: 'America/Los_Angeles', workedDays: 1, approvedMillis: 8 * 3600000, grossCents: 16000, currency: 'USD', blockers: [], rows: [], canFinalize: true, fingerprint: 'historical-synthetic' } } } } as Awaited<ReturnType<typeof axios.get>>);
    await pending;
  });
  expect(screen.queryByRole('heading', { name: 'Gross pay before taxes: $160.00' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save calculation' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Pay period end')).toHaveValue('2026-10-20');
  expect(axios.post).not.toHaveBeenCalled();
});

test('an unfinished day asks only for checkout, never for break logging',async()=>{
 configured();currentDetail.ledger.days=[{...recordedDay('2026-10-19'),incomplete:true}];
 await employee();period('2026-10-19');
 expect(screen.getByText('Missing checkout')).toBeVisible();
 expect(screen.getByText('Record the missing checkout before calculating this day.')).toBeVisible();
 expect(screen.getByRole('button',{name:'Fix checkout for 2026-10-19'})).toBeEnabled();
 expect(screen.queryByText(/break/i)).not.toBeInTheDocument();
});


test('an ordinary unapproved day explains the status and exposes approval without an extra click', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19', 3 * 3600000 + 14 * 60000 + 4000)];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('Awaiting approval')).toBeVisible();
  expect(day.getByText('Recorded time has not been approved yet.')).toBeVisible();
  expect(day.getByRole('checkbox', { name: 'I checked the hours and overtime for 2026-10-19.' })).toBeVisible();
  expect(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).toBeVisible();
  expect(day.queryByText('Needs review')).not.toBeInTheDocument();
  expect(day.queryByText('Needs attention')).not.toBeInTheDocument();
  expect(day.queryByRole('button', { name: 'Review hours for 2026-10-19' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});

test('outside-time details and a direct employee/date link are visible without opening adjustment controls', async () => {
  configured(); currentDetail.ledger.days = [{ ...recordedDay('2026-10-19', 3 * 3600000), review: {
    state: 'needs-attention', canApproveRecorded: false,
    reasons: [{ code: 'OUTSIDE_SCHEDULE', message: 'Work continued 30 min after the approved 5:00 PM end. Review this time in Work time.', action: 'work-time' }],
    workTime: { plannedStart: '08:00', plannedEnd: '17:00', plannedMinutes: 540, scheduleTimeZone: 'America/Los_Angeles', timeZone: 'America/Los_Angeles',
      checkin: '2026-10-19T21:30:00Z', checkout: '2026-10-20T00:30:00Z', earlyMillis: 0, lateMillis: 1800000, outsideMillis: 1800000, status: 'pending', reason: '', scheduleIssue: null },
  } }];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('Needs attention')).toBeVisible();
  expect(day.getByText('Work continued 30 min after the approved 5:00 PM end. Review this time in Work time.')).toBeVisible();
  expect(day.getByText('8:00 AM–5:00 PM')).toBeVisible();
  expect(day.getByText('2:30:00 PM')).toBeVisible(); expect(day.getByText('5:30:00 PM')).toBeVisible();
  expect(day.getByRole('link', { name: 'Review outside time for 2026-10-19' })).toHaveAttribute('href', '/staff/work-time?staff=a&date=2026-10-19');
  expect(day.queryByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).not.toBeInTheDocument();
  expect(day.queryByRole('button', { name: 'Review overtime and adjustments for 2026-10-19' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});

test('a stale approved day shows the actual policy issue instead of an approved badge', async () => {
  configured(); currentDetail.ledger.days = [{ ...recordedDay('2026-10-19'), approval: { status: 'approved', regularMillis: 8 * 3600000, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, rulesReviewed: true, reason: 'Earlier approval' },
    review: { state: 'needs-attention', canApproveRecorded: false, reasons: [{ code: 'POLICY_CHANGED', message: 'The paid-hours policy changed after approval. Review and approve this day again.', action: 'time' }] } }];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('Needs attention')).toBeVisible();
  expect(day.getByText('The paid-hours policy changed after approval. Review and approve this day again.')).toBeVisible();
  expect(day.queryByText('Approved', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText('0 of 1 recorded workdays approved. Review each day before calculating.')).toBeVisible();
  expect(day.getByRole('button', { name: 'Review overtime and adjustments for 2026-10-19' })).toBeVisible();
});

test('a day action opens the matching detailed approval immediately', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19'), recordedDay('2026-10-20', 9 * 3600000)];
  await employee(); period('2026-10-19', '2026-10-20');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-20' }));
  expect(day.getByText('9 hr 0 min recorded today exceeds 8 hours. Review the overtime allocation.')).toBeVisible();
  fireEvent.click(day.getByRole('button', { name: 'Review overtime and adjustments for 2026-10-20' }));
  await screen.findByRole('heading', { name: 'Work time and daily approvals' });
  const panels = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-payroll-date]'));
  expect(panels.find(panel => panel.dataset.payrollDate === '2026-10-20')?.open).toBe(true);
  expect(panels.find(panel => panel.dataset.payrollDate === '2026-10-19')?.open).toBe(false);
  expect(within(panels.find(panel => panel.dataset.payrollDate === '2026-10-20')!).getByLabelText('Regular paid hours')).toBeVisible();
});

test('missing rate and unconfirmed policy show their causes and direct setup actions', async () => {
  currentDetail.ledger.days = [recordedDay('2026-10-19')]; await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('No hourly rate is saved for this date.')).toBeVisible();
  expect(day.getByText('Payroll rules have not been reviewed and confirmed.')).toBeVisible();
  expect(day.getByRole('button', { name: 'Set hourly rate for 2026-10-19' })).toBeVisible();
  expect(day.getByRole('button', { name: 'Review payroll rules for 2026-10-19' })).toBeVisible();
  expect(day.queryByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).not.toBeInTheDocument();
});

test('a missing-rate shortcut starts the new rate on the affected workday', async () => {
  configured(); currentDetail.profile.rates = []; currentDetail.ledger.days = [recordedDay('2026-10-19')];
  await employee(); period('2026-10-19');
  fireEvent.click(screen.getByRole('button', { name: 'Set hourly rate for 2026-10-19' }));
  expect(await screen.findByLabelText('Effective date')).toHaveValue('2026-10-19');
  expect(axios.post).not.toHaveBeenCalled();
});

test('the payroll-rules shortcut opens the policy fields directly', async () => {
  currentDetail.ledger.days = [recordedDay('2026-10-19')];
  await employee(); period('2026-10-19');
  fireEvent.click(screen.getByRole('button', { name: 'Review payroll rules for 2026-10-19' }));
  const policy = await screen.findByLabelText('Payroll policy review notes');
  expect(policy).toBeVisible();
  expect(policy.closest('details')).toHaveAttribute('open');
  expect(axios.post).not.toHaveBeenCalled();
});

test('the missing-checkout shortcut opens the unfinished session without another search', async () => {
  configured(); currentDetail.ledger.days = [{ ...recordedDay('2026-10-19'), incomplete: true }];
  currentDetail.ledger.sessions = [{ id: 'open-a', start: '2026-10-19T15:00:00Z', end: null, version: 1, breaks: [] }];
  await employee(); period('2026-10-19');
  fireEvent.click(screen.getByRole('button', { name: 'Fix checkout for 2026-10-19' }));
  expect(await screen.findByLabelText('Corrected start (ISO timestamp)')).toHaveValue('2026-10-19T15:00:00Z');
  expect(screen.getByLabelText('Corrected checkout (blank if open)')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Save time correction' })).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});


test('a related-workweek issue points directly to the affected workday instead of reopening the approved day', async () => {
  configured();
  currentDetail.ledger.days = [recordedDay('2026-10-19'), { ...recordedDay('2026-10-20'),
    approval: { status: 'approved', regularMillis: 8 * 3600000, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, rulesReviewed: true, reason: 'Recorded work approved' },
    review: { state: 'needs-attention', canApproveRecorded: false, reasons: [
      { code: 'WORKWEEK_APPROVALS', date: '2026-10-19', message: 'The complete workweek needs approved time. Review 2026-10-19 before calculating.', action: 'time' },
      { code: 'WORKWEEK_CHECKOUT', date: '2026-10-19', message: 'The related workday 2026-10-19 needs its time records checked.', action: 'time' },
    ] },
  }];
  await employee(); period('2026-10-20');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-20' }));
  expect(day.getByText('The complete workweek needs approved time. Review 2026-10-19 before calculating.')).toBeVisible();
  expect(day.getAllByRole('button', { name: 'Review workday 2026-10-19' })).toHaveLength(1);
  expect(day.queryByRole('button', { name: 'Review overtime and adjustments for 2026-10-20' })).not.toBeInTheDocument();
  fireEvent.click(day.getByRole('button', { name: 'Review workday 2026-10-19' }));
  await screen.findByRole('heading', { name: 'Work time and daily approvals' });
  const panels = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-payroll-date]'));
  expect(panels.find(panel => panel.dataset.payrollDate === '2026-10-19')?.open).toBe(true);
  expect(panels.find(panel => panel.dataset.payrollDate === '2026-10-20')?.open).toBe(false);
  expect(axios.post).not.toHaveBeenCalled();
});
