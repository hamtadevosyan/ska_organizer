import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Payroll from './Payroll';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../auth/context';
import { testAccount } from '../tests/authAccount';
import type { Role } from '../auth/context';
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });
const detail = { staff: { id: 'a', name: 'Ari Employee', active: true }, profile: { version: 2, legalName: 'Ari', paymentMethod: 'provider', payFrequency: 'biweekly', providerReference: '', instructions: '', taxId: '••••1234', bankAccount: '', routingNumber: '', requiredDocuments: ['W-4'], rates: [], rules: { mode: 'ca-standard', workweekStart: 1, confirmed: false, reference: '', dailyScheduledMinutes: 480 } }, ledger: { version: 1, timeZone: 'America/Los_Angeles', sessions: [], days: [], history: [] }, documents: [], snapshots: [], missingDocuments: ['W-4'] };
function view(role: Role = 'admin') { return <AuthContext.Provider value={{ account: { ...testAccount, role }, ready: true, notice: '', serverUnavailable: false, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><MemoryRouter><Payroll /></MemoryRouter></AuthContext.Provider>; }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(axios.get).mockImplementation(async url => ({ data: { data: String(url).endsWith('/a') || String(url).endsWith('/b') ? detail : [{ id: 'a', name: 'Ari Employee', active: true }, { id: 'b', name: 'Bea Employee', active: true }] } })); vi.mocked(axios.post).mockResolvedValue({ data: { data: {} } }); });
async function employee() { render(view()); await screen.findByRole('option', { name: 'Ari Employee' }); fireEvent.change(screen.getByLabelText('Payroll employee'), { target: { value: 'a' } }); await screen.findByRole('button', { name: 'Save private profile' }); }
test.each(['editor', 'viewer', 'teacher'] as const)('%s cannot load any private payroll records', role => { render(view(role)); expect(screen.getByRole('alert')).toHaveTextContent('Administrator payroll access'); expect(axios.get).not.toHaveBeenCalled(); });
test('masked secrets are not submitted as replacements and missing required files are visible', async () => {
  await employee(); expect(screen.getByText('Missing payroll documents: W-4')).toBeVisible(); expect(screen.getByLabelText('Employee SSN (optional)')).toHaveAttribute('placeholder', '••••1234');
  fireEvent.change(screen.getByLabelText('Reason for profile change'), { target: { value: 'Verified employee record' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private profile' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1)); const body = vi.mocked(axios.post).mock.calls[0][1]; expect(body).not.toHaveProperty('taxId'); expect(body).not.toHaveProperty('bankAccount'); expect(body).toMatchObject({ version: 2, reason: 'Verified employee record' });
});
test('employee and section changes confirm discarding unsaved private form entries', async () => {
  await employee(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('Legal employee name'), { target: { value: 'Unsaved private name' } });
  fireEvent.change(screen.getByLabelText('Payroll employee'), { target: { value: 'b' } }); expect(screen.getByLabelText('Payroll employee')).toHaveValue('a');
  fireEvent.click(screen.getByRole('button', { name: 'Hourly rates' })); expect(screen.getByLabelText('Legal employee name')).toHaveValue('Unsaved private name');
  expect(confirm).toHaveBeenCalledTimes(2); confirm.mockRestore();
});
test('a blocked preview cannot be finalized and describes taxes and payment explicitly', async () => {
  await employee(); fireEvent.click(screen.getByRole('button', { name: 'Pay preview' }));
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { start: '2026-10-19', end: '2026-10-25', timeZone: 'America/Los_Angeles', workedDays: 1, approvedMillis: 0, grossCents: 0, currency: 'USD', blockers: ['Missing checkout.'], rows: [], canFinalize: false } } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate gross preview' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Missing checkout.'); expect(screen.getByRole('button', { name: 'Save finalized calculation snapshot' })).toBeDisabled();
  expect(screen.getByText('Gross only. Payment has not been executed. Taxes and withholding are not calculated.')).toBeVisible();
});
test('a saved mutation with a failed refresh cannot be accidentally submitted again as an unsaved change', async () => {
  await employee(); vi.mocked(axios.get).mockRejectedValueOnce(new Error('Synthetic refresh failure'));
  fireEvent.change(screen.getByLabelText('Reason for profile change'), { target: { value: 'Synthetic reviewed change' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save private profile' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The change was saved, but the latest record could not be loaded.');
  expect(screen.queryByRole('button', { name: 'Save private profile' })).not.toBeInTheDocument(); expect(axios.post).toHaveBeenCalledTimes(1); expect(screen.getByRole('button', { name: 'Retry payroll' })).toBeEnabled();
});
