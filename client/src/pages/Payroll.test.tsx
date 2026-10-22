import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  fireEvent.click(screen.getByRole('button', { name: 'Review hours for 2026-10-19' }));
  expect(axios.post).not.toHaveBeenCalled();
  const approve = screen.getByRole('button', { name: 'Approve recorded hours for 2026-10-19' });
  fireEvent.click(approve); expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('I checked the hours, breaks and overtime for 2026-10-19.'));
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
  expect(screen.getByRole('button', { name: 'Review hours for 2026-10-19' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Review hours for 2026-10-20' })).toBeVisible();
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
  fireEvent.click(screen.getByRole('button', { name: 'Review hours for 2026-10-19' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Review hours for 2026-10-19' }));
  fireEvent.click(screen.getByLabelText('I checked the hours, breaks and overtime for 2026-10-19.'));
  expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeDisabled();
  // Re-selecting the current section must not clear the outstanding draft.
  fireEvent.click(screen.getByRole('button', { name: 'Calculate pay' }));
  expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeDisabled();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.getByLabelText('I checked the hours, breaks and overtime for 2026-10-19.')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Calculate gross pay' })).toBeDisabled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.queryByLabelText('I checked the hours, breaks and overtime for 2026-10-19.')).not.toBeInTheDocument();
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
