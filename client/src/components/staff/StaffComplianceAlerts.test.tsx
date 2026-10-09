import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthContext } from '../../auth/context';
import type { AuthState, Role } from '../../auth/context';
import { getStaffCompliance } from '../../api/staffDocuments';
import type { StaffCompliance } from '../../api/staffDocuments';
import { StaffComplianceAlerts } from './StaffComplianceAlerts';

const state = vi.hoisted(() => ({ expired: () => {} }));
vi.mock('../../api/staffDocuments', async importOriginal => ({ ...await importOriginal<typeof import('../../api/staffDocuments')>(), getStaffCompliance: vi.fn() }));
vi.mock('../../auth/transport', () => ({ authError: (_failure: unknown, fallback: string) => fallback,
  onSessionExpired: (callback: () => void) => { state.expired = callback; return () => {}; } }));
const response = (): StaffCompliance => ({ items: [{ staffId: 'employee', employeeName: 'Synthetic Teacher', requirementId: 'cpr',
  requirementTitle: 'Synthetic CPR training', status: 'expiring', expiresOn: '2026-11-17', daysRemaining: 40 }],
  totals: { expiring: 1 }, today: '2026-10-08', timeZone: 'America/Los_Angeles', warningDays: 40, configured: true,
  requiredTotal: 1, activeStaffTotal: 1 });
function auth(role: Role): AuthState {
  return { account: { id: 'account', username: 'synthetic', displayName: 'Synthetic', role, disabled: false, mustChangePassword: false },
    ready: true, notice: '', serverUnavailable: false, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() };
}
const show = (role: Role = 'admin') => render(<MemoryRouter><AuthContext.Provider value={auth(role)}><StaffComplianceAlerts /></AuthContext.Provider></MemoryRouter>);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getStaffCompliance).mockResolvedValue(response()); });
afterEach(() => { vi.useRealTimers(); });

test.each(['admin', 'editor'] as const)('%s sees actionable employee reminders with a link to the correct employee', async role => {
  show(role);
  const link = await screen.findByRole('link', { name: 'Synthetic Teacher · Synthetic CPR training' });
  expect(link).toHaveAttribute('href', '/staff?employee=employee');
  expect(screen.getByText(/Reminder window: 40 days/)).toBeInTheDocument();
  expect(screen.getByText('Renewal due soon · Expires 2026-11-17 (40 days)')).toBeInTheDocument();
  expect(screen.queryByText(/issuer|reference|notes|download/i)).not.toBeInTheDocument();
});

test('read-only accounts never request or render employee compliance', () => {
  show('viewer');
  expect(getStaffCompliance).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Employee document reminders' })).not.toBeInTheDocument();
});

test('an empty requirement catalog prompts setup without claiming completion', async () => {
  vi.mocked(getStaffCompliance).mockResolvedValue({ ...response(), configured: false, items: [], requiredTotal: 0 });
  show();
  await screen.findByRole('link', { name: 'Set up employee requirements' });
  expect(screen.queryByText(/No required employee documents need attention/)).not.toBeInTheDocument();
});

test('refresh follows the facility date and shows the exact expiry boundary', async () => {
  show(); await screen.findByRole('link', { name: /Synthetic Teacher/ });
  const next = response(); next.today = '2026-11-17'; next.items[0].daysRemaining = 0;
  vi.mocked(getStaffCompliance).mockResolvedValue(next);
  fireEvent(window, new Event('focus'));
  await screen.findByText('Renewal due soon · Expires today');
  next.today = '2026-11-18'; next.items[0].status = 'expired'; next.items[0].daysRemaining = -1;
  vi.mocked(getStaffCompliance).mockResolvedValue(structuredClone(next));
  fireEvent.click(screen.getByRole('button', { name: 'Check employee documents' }));
  await screen.findByText('Expired · Expired on 2026-11-17');
});

test('failed refresh hides stale results and does not show a false all-clear', async () => {
  show(); await screen.findByRole('link', { name: /Synthetic Teacher/ });
  vi.mocked(getStaffCompliance).mockRejectedValueOnce(new Error('Synthetic outage'));
  fireEvent.click(screen.getByRole('button', { name: 'Check employee documents' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: /Synthetic Teacher/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/No required employee documents need attention/)).not.toBeInTheDocument();
  vi.mocked(getStaffCompliance).mockResolvedValue({ ...response(), items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Check employee documents' }));
  await screen.findByText('No required employee documents need attention as of 2026-10-08.');
});

test('a successful document change refreshes the overview before its periodic timer', async () => {
  show(); await screen.findByRole('link', { name: /Synthetic Teacher/ });
  vi.mocked(getStaffCompliance).mockResolvedValue({ ...response(), items: [] });
  fireEvent(window, new Event('skao:staff-compliance-changed'));
  await screen.findByText('No required employee documents need attention as of 2026-10-08.');
  expect(screen.queryByRole('link', { name: /Synthetic Teacher/ })).not.toBeInTheDocument();
});

test('session expiry aborts fetching, removes reminders and ignores late responses', async () => {
  let finish!: (value: StaffCompliance) => void;
  vi.mocked(getStaffCompliance).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  show(); const signal = vi.mocked(getStaffCompliance).mock.calls[0][0];
  act(() => state.expired());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response()));
  expect(screen.queryByRole('region', { name: 'Employee document reminders' })).not.toBeInTheDocument();
});

test('a role change removes reminders and cancels the privileged request', async () => {
  const view = show(); await screen.findByRole('link', { name: /Synthetic Teacher/ });
  const signal = vi.mocked(getStaffCompliance).mock.calls[0][0];
  view.rerender(<MemoryRouter><AuthContext.Provider value={auth('viewer')}><StaffComplianceAlerts /></AuthContext.Provider></MemoryRouter>);
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('region', { name: 'Employee document reminders' })).not.toBeInTheDocument();
});

test('an open Home refreshes reminders periodically and stops when unmounted', async () => {
  vi.useFakeTimers();
  const view = show();
  await act(async () => {});
  expect(getStaffCompliance).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(60000));
  expect(getStaffCompliance).toHaveBeenCalledTimes(2);
  const signal = vi.mocked(getStaffCompliance).mock.calls.at(-1)![0];
  view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTime(60000));
  expect(getStaffCompliance).toHaveBeenCalledTimes(2);
});

test('the Staff overview pages and filters reminders while preserving employee links', async () => {
  const data = response();
  data.items = Array.from({ length: 12 }, (_, index) => ({ ...data.items[0], staffId: 'employee-' + index,
    employeeName: 'Synthetic Teacher ' + index, status: index === 11 ? 'expired' : 'missing' }));
  vi.mocked(getStaffCompliance).mockResolvedValue(data);
  render(<MemoryRouter><AuthContext.Provider value={auth('editor')}><StaffComplianceAlerts expanded /></AuthContext.Provider></MemoryRouter>);
  await screen.findByRole('link', { name: 'Synthetic Teacher 0 · Synthetic CPR training' });
  expect(screen.queryByRole('link', { name: 'Synthetic Teacher 11 · Synthetic CPR training' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next reminders' }));
  expect(screen.getByRole('link', { name: 'Synthetic Teacher 11 · Synthetic CPR training' })).toHaveAttribute('href', '/staff?employee=employee-11');
  fireEvent.change(screen.getByLabelText('Reminder status'), { target: { value: 'expired' } });
  expect(screen.getByRole('link', { name: 'Synthetic Teacher 11 · Synthetic CPR training' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Synthetic Teacher 10 · Synthetic CPR training' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search employee reminders'), { target: { value: 'No such synthetic name' } });
  expect(screen.getByText('No reminders match these filters.')).toBeInTheDocument();
  expect(screen.queryByText(/No required employee documents need attention/)).not.toBeInTheDocument();
});
