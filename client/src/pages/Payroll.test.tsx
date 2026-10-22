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
async function employee(profile = false) { render(view()); await screen.findByRole('option', { name: 'Ari Employee' }); fireEvent.change(screen.getByLabelText('Payroll employee'), { target: { value: 'a' } }); await screen.findByLabelText('Pay period start'); if (profile) { fireEvent.click(screen.getByText('Employee setup & records')); fireEvent.click(screen.getByRole('button', { name: 'Private profile' })); } }
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
test('a blocked preview cannot be finalized and identifies the amount as before taxes without sending payment', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')]; await employee(); period('2026-10-19');
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { start: '2026-10-19', end: '2026-10-25', timeZone: 'America/Los_Angeles', workedDays: 1, approvedMillis: 0, grossCents: 0, currency: 'USD', blockers: ['Missing checkout.'], rows: [], canFinalize: false } } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate pay' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Missing checkout.'); expect(screen.getByRole('button', { name: 'Save calculation' })).toBeDisabled();
  expect(screen.getByText('Before taxes. No payment has been sent.')).toBeVisible();
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
  expect(screen.getByRole('heading', { name: 'Review days' })).toBeVisible();
  expect(screen.getByLabelText('Pay period start')).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Calculate pay' })).toHaveLength(1);
  expect(screen.queryByLabelText('Employee SSN (optional)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Bank account')).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});
test('rounding approval is explicit, retains selected dates and preserves exact recorded milliseconds', async () => {
  configured(); const exactMillis = 7.5 * 3600000 + 123;
  currentDetail.ledger.days = [recordedDay('2026-10-19', exactMillis)];
  await employee(); period('2026-10-19');
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByText('Needs attention')).toBeVisible();
  const approve = screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' });
  expect(screen.queryByLabelText('I checked the hours and overtime for 2026-10-19.')).not.toBeInTheDocument();
  vi.mocked(axios.post).mockImplementationOnce(async (_url, body) => {
    currentDetail.ledger = { ...currentDetail.ledger, version: 2, days: [{ ...currentDetail.ledger.days[0], approval: body as Details['ledger']['days'][number]['approval'] }] };
    return { data: { data: {} } };
  });
  fireEvent.click(approve);
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][0]).toMatch(/\/a\/approvals$/);
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ version: 1, date: '2026-10-19', status: 'approved', mode: 'manual-reviewed', paidMillis: 8 * 3600000, premiumCents: 0, overtimeReviewed: false, adjustmentCents: 0, rulesReviewed: true });
  await screen.findByText('Saved.');
  expect(screen.getByLabelText('Pay period start')).toHaveValue('2026-10-19');
  expect(screen.getByLabelText('Pay period end')).toHaveValue('2026-10-19');
  expect(currentDetail.ledger.days[0].rawMillis).toBe(exactMillis);
  expect(currentDetail.ledger.days[0].paidMillis).toBe(exactMillis);
});
test('hour review includes recorded days outside the selected period when they share its overtime workweek', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19'), recordedDay('2026-10-20')];
  await employee(); period('2026-10-20');
  fireEvent.click(screen.getByText('Related workweek days'));
  expect(screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-20' })).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});

const detailedCases: { label: string; date?: string; days: Details['ledger']['days'] }[] = [
  { label: 'daily overtime', days: [recordedDay('2026-10-19', 9 * 3600000)] },
  { label: 'weekly overtime despite eight-hour days', date: '2026-10-24', days: Array.from({ length: 6 }, (_, index) => recordedDay('2026-10-' + String(19 + index))) },
  { label: 'seven worked days despite short shifts', date: '2026-10-25', days: Array.from({ length: 7 }, (_, index) => recordedDay('2026-10-' + String(19 + index), 3600000)) },
  { label: 'an existing approved premium', days: [{ ...recordedDay('2026-10-19'), approval: { status: 'approved', regularMillis: 8 * 3600000, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 100, reason: 'Existing reviewed premium', rulesReviewed: true } }] },
];
test.each(detailedCases.filter(item => item.label !== 'an existing approved premium'))('$label exposes an explicit manual pay review without choosing a multiplier', async ({ days, date = '2026-10-19' }) => {
  configured(); currentDetail.ledger.days = structuredClone(days);
  await employee(); period(date);
  expect(screen.queryByRole('button', { name: 'Approve recorded hours for ' + date })).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'I reviewed overtime and additional pay for ' + date + '.' })).toBeVisible();
  expect(screen.getByLabelText('Additional pay for ' + date + ' ($)')).toHaveValue(null);
  expect(screen.getByRole('button', { name: 'Approve reviewed pay for ' + date })).toBeVisible();
  expect(screen.queryByLabelText(/1\.5|Double-time hours/)).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});
test('an existing reviewed adjustment is not silently replaced by a new ordinary approval', async () => {
  configured(); currentDetail.ledger.days = structuredClone(detailedCases.find(item => item.label === 'an existing approved premium')!.days);
  await employee(); period('2026-10-19');
  expect(screen.queryByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' })).getByText('View approved day'));
  fireEvent.click(screen.getByRole('button', { name: 'Review hours for 2026-10-19' }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ adjustmentCents: 100 });
});
test('changing pay dates clears the previous calculation before it can be saved for a different period', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')];
  await employee(); period('2026-10-19');
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { start: '2026-10-19', end: '2026-10-19', timeZone: 'America/Los_Angeles', workedDays: 1, approvedMillis: 8 * 3600000, grossCents: 16000, currency: 'USD', blockers: [], rows: [], canFinalize: true, fingerprint: 'synthetic-preview' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate pay' }));
  expect(await screen.findByRole('button', { name: 'Save calculation' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Pay period end'), { target: { value: '2026-10-20' } });
  expect(screen.queryByRole('button', { name: 'Save calculation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Gross pay before taxes: $160.00' })).not.toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test.each(['new preview', 'saved snapshot'] as const)('returning from employee setup clears the %s before showing pay dates again', async source => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19')];
  const preview = { start: '2026-10-19', end: '2026-10-19', timeZone: 'America/Los_Angeles',
    workedDays: 1, rawMillis: 8 * 3600000, approvedMillis: 8 * 3600000, grossCents: 16000,
    currency: 'USD', blockers: [], rows: [], canFinalize: true, fingerprint: 'before-setup' };
  if (source === 'saved snapshot') currentDetail.snapshots = [{ id: 'saved-before-setup', start: preview.start, end: preview.end, at: '2026-10-20T00:00:00Z', grossCents: preview.grossCents, currency: 'USD' }];
  await employee(); period('2026-10-19');
  if (source === 'new preview') {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: preview } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate pay' }));
    expect(await screen.findByRole('button', { name: 'Save calculation' })).toBeEnabled();
  } else {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: { sourceChanged: false, preview } } });
    fireEvent.click(screen.getByText('Saved calculations'));
    fireEvent.click(screen.getByRole('button', { name: 'Open calculation snapshot' }));
  }
  expect(await screen.findByRole('heading', { name: 'Gross pay before taxes: $160.00' })).toBeVisible();
  fireEvent.click(screen.getByText('Employee setup & records'));
  fireEvent.click(screen.getByRole('button', { name: 'Hourly rates' }));
  expect(await screen.findByRole('heading', { name: 'Effective hourly rates' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Back to pay' }));
  expect(await screen.findByLabelText('Pay period start')).toBeVisible();
  expect(screen.getByLabelText('Pay period end')).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Pay calculation result' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Gross pay before taxes: $160.00' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save calculation' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Calculate pay' })).toHaveLength(1);
  expect(axios.post).toHaveBeenCalledTimes(source === 'new preview' ? 1 : 0);
});

test('the single calculate action shows exact server pay with readable clocked and approved time', async () => {
  configured();
  const approvedDay = (date: string, clocked: number, paid = clocked) => ({
    ...recordedDay(date, clocked),
    approval: { status: 'approved', mode: 'manual-reviewed' as const, paidMillis: paid,
      regularMillis: paid, overtimeMillis: 0, doubleMillis: 0, premiumCents: 0,
      adjustmentCents: 0, overtimeReviewed: false, rulesReviewed: true, reason: 'Administrator approved paid time' },
  });
  const first = approvedDay('2026-10-21', 6.695 * 3600000, 7 * 3600000);
  const second = approvedDay('2026-10-22', 3.235 * 3600000, 4 * 3600000);
  currentDetail.ledger.days = [first, second];
  currentDetail.profile.rates[0].cents = 1700;
  await employee(); period('2026-10-21', '2026-10-22');
  const calculate = screen.getAllByRole('button', { name: 'Calculate pay' });
  expect(calculate).toHaveLength(1);
  expect(axios.post).not.toHaveBeenCalled();
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: {
    start: '2026-10-21', end: '2026-10-22', timeZone: 'America/Los_Angeles', workedDays: 2,
    rawMillis: first.rawMillis + second.rawMillis, approvedMillis: 11 * 3600000,
    grossCents: 18700, currency: 'USD', blockers: [], canFinalize: true, fingerprint: 'exact-server-pay',
    rows: [{ ...first, rate: currentDetail.profile.rates[0], grossCents: 11900, issues: [] },
      { ...second, rate: currentDetail.profile.rates[0], grossCents: 6800, issues: [] }],
  } } });
  fireEvent.click(calculate[0]);
  const result = within(await screen.findByRole('region', { name: 'Pay calculation result' }));
  expect(result.getByRole('heading', { name: 'Gross pay before taxes: $187.00' })).toBeVisible();
  expect(result.getAllByText('6 hr 41 min 42 sec').length).toBeGreaterThanOrEqual(1);
  expect(result.getAllByText('3 hr 14 min 6 sec').length).toBeGreaterThanOrEqual(1);
  expect(result.getAllByText('7 hr').length).toBeGreaterThanOrEqual(1);
  expect(result.getAllByText('4 hr').length).toBeGreaterThanOrEqual(1);
  expect(result.getAllByText('$119.00').length).toBeGreaterThanOrEqual(1);
  expect(result.getAllByText('$68.00').length).toBeGreaterThanOrEqual(1);
  expect(result.queryByText(/6\.695|3\.235|4\.000/)).not.toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(axios.post).mock.calls[0][0]).toMatch(/\/a\/preview$/);
  expect(vi.mocked(axios.post).mock.calls[0][1]).toEqual({ start: '2026-10-21', end: '2026-10-22' });
});

test('an older saved fractional-hours calculation is displayed unchanged rather than silently rounded', async () => {
  configured();
  const paidMillis = 6.695 * 3600000;
  const day = { ...recordedDay('2026-10-21', paidMillis), approval: {
    status: 'approved', mode: 'manual-reviewed' as const, paidMillis, regularMillis: paidMillis,
    overtimeMillis: 0, doubleMillis: 0, premiumCents: 0, adjustmentCents: 0,
    overtimeReviewed: false, rulesReviewed: true, reason: 'Earlier saved paid-hours decision',
  } };
  currentDetail.ledger.days = [day];
  currentDetail.profile.rates[0].cents = 1700;
  currentDetail.snapshots = [{ id: 'older-fractional', start: day.date, end: day.date, at: '2026-10-21T23:00:00Z', grossCents: 11382, currency: 'USD' }];
  await employee(); period(day.date);
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: { sourceChanged: true, preview: {
    start: day.date, end: day.date, timeZone: 'America/Los_Angeles', workedDays: 1,
    rawMillis: paidMillis, approvedMillis: paidMillis, grossCents: 11382, currency: 'USD',
    blockers: [], canFinalize: true, fingerprint: 'older-saved-fingerprint',
    rows: [{ ...day, rate: currentDetail.profile.rates[0], grossCents: 11382, issues: [] }],
  } } } });
  fireEvent.click(screen.getByText('Saved calculations'));
  fireEvent.click(screen.getByRole('button', { name: 'Open calculation snapshot' }));
  const result = within(await screen.findByRole('region', { name: 'Pay calculation result' }));
  expect(result.getByRole('heading', { name: 'Gross pay before taxes: $113.82' })).toBeVisible();
  expect(result.getByRole('alert')).toHaveTextContent('This historical calculation is retained unchanged');
  expect(result.getAllByText('6 hr 41 min 42 sec')).toHaveLength(2);
  expect(result.queryByText('7 hr', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save calculation' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});

test('unsaved guided review blocks calculation until the administrator confirms discarding it', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19', 9 * 3600000)];
  await employee(); period('2026-10-19');
  fireEvent.change(screen.getByLabelText('Additional pay for 2026-10-19 ($)'), { target: { value: '25' } });
  expect(screen.getByRole('button', { name: 'Calculate pay' })).toBeDisabled();
  // There is one calculation action, so no duplicate navigation button can discard the draft.
  expect(screen.getAllByRole('button', { name: 'Calculate pay' })).toHaveLength(1);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.getByLabelText('Additional pay for 2026-10-19 ($)')).toHaveValue(25);
    expect(screen.getByRole('button', { name: 'Calculate pay' })).toBeDisabled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.getByLabelText('Additional pay for 2026-10-19 ($)')).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Calculate pay' })).toBeEnabled();
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


test('an ordinary whole-hour day explains the status and exposes approval without an extra click', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19', 3 * 3600000)];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('Awaiting approval')).toBeVisible();
  expect(day.getByText('Recorded time has not been approved yet.')).toBeVisible();
  expect(day.queryByRole('checkbox', { name: 'I checked the hours and overtime for 2026-10-19.' })).not.toBeInTheDocument();
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
  expect(screen.getByText('0 of 1 recorded workdays approved.')).toBeVisible();
  expect(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).toBeVisible();
});

test('a day action opens the matching detailed approval immediately', async () => {
  configured(); currentDetail.ledger.days = [recordedDay('2026-10-19'), recordedDay('2026-10-20', 9 * 3600000)];
  await employee(); period('2026-10-19', '2026-10-20');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-20' }));
  expect(day.getByText('Overtime needs your review. Enter the additional pay amount explicitly; no multiplier is applied automatically.')).toBeVisible();
  fireEvent.click(day.getByText('Change paid hours or add an adjustment'));
  fireEvent.click(day.getByRole('button', { name: 'Open detailed approval for 2026-10-20' }));
  await screen.findByRole('heading', { name: 'Work time and daily approvals' });
  const panels = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-payroll-date]'));
  expect(panels.find(panel => panel.dataset.payrollDate === '2026-10-20')?.open).toBe(true);
  expect(panels.find(panel => panel.dataset.payrollDate === '2026-10-19')?.open).toBe(false);
  expect(within(panels.find(panel => panel.dataset.payrollDate === '2026-10-20')!).getByLabelText('Paid hours')).toBeVisible();
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

function nineHourCreditDay(): Details['ledger']['days'][number] {
  return { ...recordedDay('2026-10-19', 8.5 * 3600000), review: {
    state: 'needs-attention', canApproveRecorded: false, suggestedPaidMillis: 9 * 3600000,
    scheduledCreditMillis: 30 * 60000, requiresOvertimeReview: true,
    reasons: [{ code: 'OVERTIME_REVIEW', message: 'This day requires your explicit overtime and additional-pay review.', action: 'time' }],
    workTime: { plannedStart: '08:00', plannedEnd: '17:00', plannedMinutes: 540,
      scheduleTimeZone: 'America/Los_Angeles', timeZone: 'America/Los_Angeles',
      checkin: '2026-10-19T15:30:00Z', checkout: '2026-10-20T00:00:00Z',
      earlyMillis: 0, lateMillis: 0, outsideMillis: 0, status: 'within-schedule', reason: '', scheduleIssue: null },
  } };
}

const sevenHourActualMillis = (6 * 3600 + 41 * 60 + 42) * 1000;
function roundedSevenHourDay({ date = '2026-10-19', matchingSchedule = false, ordinal = 0, alreadyApproved = false } = {}): Details['ledger']['days'][number] {
  const needsReview = !matchingSchedule || ordinal > 1;
  return { ...recordedDay(date, sevenHourActualMillis),
    approval: alreadyApproved ? { status: 'approved', mode: 'manual-reviewed', paidMillis: sevenHourActualMillis,
      regularMillis: sevenHourActualMillis, overtimeMillis: 0, doubleMillis: 0, premiumCents: 0,
      adjustmentCents: 0, rulesReviewed: true, overtimeReviewed: false, reason: 'Earlier fractional-hours decision' } : null,
    review: {
      state: needsReview ? 'needs-attention' : 'awaiting-approval', canApproveRecorded: !needsReview,
      suggestedPaidMillis: 7 * 3600000, scheduledCreditMillis: matchingSchedule ? 7 * 3600000 - sevenHourActualMillis : 0,
      roundingCreditMillis: 7 * 3600000 - sevenHourActualMillis, requiresRoundingReview: needsReview,
      requiresOvertimeReview: false, shortDayOrdinal: ordinal,
      reasons: needsReview ? [{ code: 'ROUNDING_REVIEW', action: 'approve', message: ordinal > 1
        ? 'Review rounding from 6 hr 41 min 42 sec to 7 hr paid time. This is the second short day in this workweek.'
        : 'Review rounding from 6 hr 41 min 42 sec to 7 hr paid time. No matching approved schedule is recorded.' }]
        : [{ code: 'APPROVAL_REQUIRED', action: 'approve', message: 'Recorded time has not been approved yet.' }],
      ...(matchingSchedule ? { workTime: { plannedStart: '08:00', plannedEnd: '15:00', plannedMinutes: 420,
        scheduleTimeZone: 'America/Los_Angeles', timeZone: 'America/Los_Angeles',
        checkin: date + 'T15:18:18Z', checkout: date + 'T22:00:00Z', earlyMillis: 0, lateMillis: 0,
        outsideMillis: 0, status: 'within-schedule', reason: '', scheduleIssue: null } } : {}),
    },
  };
}

test.each([false, true])('seven-hour rounding without a matching schedule is visible for review before approval (earlier approval: %s)', async alreadyApproved => {
  configured(); currentDetail.ledger.days = [roundedSevenHourDay({ alreadyApproved })];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('6 hr 41 min 42 sec actual worked time')).toBeVisible();
  expect(day.getByText('7 hr proposed paid time', { exact: true })).toBeVisible();
  expect(day.getByText('Needs attention')).toBeVisible();
  expect(day.getByText('Review rounding from 6 hr 41 min 42 sec to 7 hr paid time. No matching approved schedule is recorded.')).toBeVisible();
  expect(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).toHaveTextContent('Approve 7 hr');
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ paidMillis: 7 * 3600000, rulesReviewed: true, overtimeReviewed: false });
  expect(currentDetail.ledger.days[0].rawMillis).toBe(sevenHourActualMillis);
  expect(currentDetail.ledger.days[0].paidMillis).toBe(sevenHourActualMillis);
});

test('rounding review preserves a higher intentional paid-time decision and its saved additional pay and adjustment', async () => {
  configured();
  const recorded = roundedSevenHourDay({ alreadyApproved: true });
  recorded.approval = { ...recorded.approval!, paidMillis: 9 * 3600000, regularMillis: 9 * 3600000,
    premiumCents: 2500, adjustmentCents: 125, reason: 'Administrator deliberately approved nine paid hours and additional pay' };
  currentDetail.ledger.days = [recorded];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('9 hr proposed paid time', { exact: true })).toBeVisible();
  expect(day.getByText(/Your earlier paid-time decision is kept\. The rounded minimum is 7 hr\./)).toBeVisible();
  expect(day.getByText('6 hr 41 min 42 sec actual worked time')).toBeVisible();
  expect(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' })).toHaveTextContent('Approve 9 hr');
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({
    paidMillis: 9 * 3600000, premiumCents: 2500, adjustmentCents: 125,
    rulesReviewed: true, overtimeReviewed: false,
  });
  expect(currentDetail.ledger.days[0].rawMillis).toBe(sevenHourActualMillis);
  expect(currentDetail.ledger.days[0].paidMillis).toBe(sevenHourActualMillis);
});

test('the first short day in a matching seven-hour schedule proposes seven hours without a rounding warning', async () => {
  configured(); currentDetail.ledger.days = [roundedSevenHourDay({ matchingSchedule: true, ordinal: 1 })];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('7 hr proposed paid time', { exact: true })).toBeVisible();
  expect(day.getByText('Awaiting approval')).toBeVisible();
  expect(day.queryByText('Needs attention')).not.toBeInTheDocument();
  expect(day.queryByText(/Review rounding/)).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Repeated short workdays' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ paidMillis: 7 * 3600000, rulesReviewed: true, overtimeReviewed: false });
  expect(currentDetail.ledger.days[0].paidMillis).toBe(sevenHourActualMillis);
});

test('the second short day warns before approval even when seven paid hours match the approved schedule', async () => {
  configured(); currentDetail.ledger.days = [roundedSevenHourDay({ date: '2026-10-20', matchingSchedule: true, ordinal: 2 })];
  currentDetail.ledger.shortDayWarnings = [{ staffId: 'a', name: 'Ari Employee', weekStart: '2026-10-19', weekEnd: '2026-10-25', count: 2, dates: ['2026-10-19', '2026-10-20'] }];
  await employee(); period('2026-10-20');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-20' }));
  expect(day.getByText('7 hr proposed paid time', { exact: true })).toBeVisible();
  expect(day.getByText('Needs attention')).toBeVisible();
  expect(day.getByText('Review rounding from 6 hr 41 min 42 sec to 7 hr paid time. This is the second short day in this workweek.')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Repeated short workdays' })).toBeVisible();
  expect(screen.getByText('2 short days in the week of 2026-10-19.')).toBeVisible();
  expect(day.getByRole('button', { name: 'Approve recorded hours for 2026-10-20' })).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});

test('nine-hour paid credit stays separate from the actual eight-and-a-half-hour clock record', async () => {
  configured(); currentDetail.ledger.days = [nineHourCreditDay()];
  await employee(); period('2026-10-19');
  const day = within(screen.getByRole('article', { name: 'Pay review for 2026-10-19' }));
  expect(day.getByText('8 hr 30 min actual worked time')).toBeVisible();
  expect(day.getByText('9 hr proposed paid time', { exact: true })).toBeVisible();
  expect(day.getAllByText(/30 min/).length).toBeGreaterThanOrEqual(2);
  expect(day.getByLabelText('Additional pay for 2026-10-19 ($)')).toHaveValue(null);
  expect(day.getByRole('checkbox', { name: 'I reviewed overtime and additional pay for 2026-10-19.' })).not.toBeChecked();
  expect(day.getAllByRole('checkbox')).toHaveLength(1);
  expect(day.queryByLabelText(/1\.5|Double-time hours/)).not.toBeInTheDocument();
  expect(currentDetail.ledger.days[0].paidMillis).toBe(8.5 * 3600000);
  expect(axios.post).not.toHaveBeenCalled();
});

test('overtime cannot be approved without the explicit review, amount and reason', async () => {
  configured(); currentDetail.ledger.days = [nineHourCreditDay()];
  await employee(); period('2026-10-19');
  const approve = screen.getByRole('button', { name: 'Approve reviewed pay for 2026-10-19' });
  fireEvent.click(approve); expect(axios.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Additional pay for 2026-10-19 ($)'), { target: { value: '25' } });
  fireEvent.change(screen.getByLabelText('Pay review reason for 2026-10-19'), { target: { value: 'Reviewed required additional pay and scheduled credit' } });
  fireEvent.click(approve); expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed overtime and additional pay for 2026-10-19.' }));
  fireEvent.click(approve);
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({
    version: 1, profileVersion: 2, date: '2026-10-19', status: 'approved', mode: 'manual-reviewed',
    paidMillis: 9 * 3600000, premiumCents: 2500, overtimeReviewed: true,
    rulesReviewed: true, reason: 'Reviewed required additional pay and scheduled credit',
  });
  expect(vi.mocked(axios.post).mock.calls[0][1]).not.toHaveProperty('overtimeMillis');
  expect(vi.mocked(axios.post).mock.calls[0][1]).not.toHaveProperty('doubleMillis');
  expect(currentDetail.ledger.days[0].paidMillis).toBe(8.5 * 3600000);
});

test('a second completed short workday shows the administrator the count and affected dates', async () => {
  configured(); currentDetail.ledger.days = [nineHourCreditDay()];
  currentDetail.ledger.shortDayWarnings = [{ staffId: 'a', name: 'Ari Employee', weekStart: '2026-10-19', weekEnd: '2026-10-25', count: 2, dates: ['2026-10-19', '2026-10-20'] }];
  await employee(); period('2026-10-19');
  expect(screen.getByRole('heading', { name: 'Repeated short workdays' })).toBeVisible();
  expect(screen.getByText('2 short days in the week of 2026-10-19.')).toBeVisible();
  expect(screen.getByText(/2026-10-20/)).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});

test('returning an overtime day for correction does not require confirming review or pricing it', async () => {
  configured(); currentDetail.ledger.days = [nineHourCreditDay()];
  await employee(); period('2026-10-19');
  fireEvent.click(screen.getByText('Change paid hours or add an adjustment'));
  fireEvent.click(screen.getByRole('button', { name: 'Open detailed approval for 2026-10-19' }));
  fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'returned' } });
  const amount = screen.getByLabelText('Additional pay ($)');
  expect(amount).not.toBeRequired(); expect(amount).toHaveValue(null);
  expect(screen.getByRole('checkbox', { name: 'I reviewed overtime and additional pay for this date.' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Approval / return reason, including any difference from clocked time'), { target: { value: 'Verify the recorded departure before a pay decision' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save daily decision' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ status: 'returned', paidMillis: 9 * 3600000, premiumCents: 0, overtimeReviewed: false, rulesReviewed: false });
  expect(currentDetail.ledger.days[0].paidMillis).toBe(8.5 * 3600000);
});
