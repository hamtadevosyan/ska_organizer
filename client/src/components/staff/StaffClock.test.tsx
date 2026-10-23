import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import StaffClock from './StaffClock';
import { AuthContext } from '../../auth/context';
import type { Account } from '../../auth/context';
import { testAccount } from '../../tests/authAccount';
import { UnsavedChangesContext } from '../UnsavedChangesContext';
import { API_BASE_URL } from '../../lib/api';

vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });

const url = API_BASE_URL + '/api/work-time/clock';
const report = vi.fn();
const initial = () => ({ staff: [
  { id: 'arriving', name: 'Alex Cleaner', active: true, checkedIn: false, version: 2 },
  { id: 'leaving', name: 'Taylor Teacher', active: true, checkedIn: true, version: 4 },
  { id: 'archived', name: 'Former Employee', active: false, checkedIn: false, version: 1 },
], timeZone: 'America/Los_Angeles' });
const response = (data = initial()) => ({ data: { data } });
function view(account: Account | null = testAccount, serverUnavailable = false) {
  return <AuthContext.Provider value={{ account, ready: true, notice: '', serverUnavailable,
    signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}>
    <UnsavedChangesContext.Provider value={report}><StaffClock /></UnsavedChangesContext.Provider>
  </AuthContext.Provider>;
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(axios.get).mockReset().mockResolvedValue(response());
  vi.mocked(axios.post).mockReset().mockResolvedValue({ data: { data: { replayed: false } } });
});

test('the manager clock lists only active staff and shows only the applicable action', async () => {
  render(view());
  const arriving = await screen.findByRole('article', { name: 'Alex Cleaner work clock' });
  const leaving = screen.getByRole('article', { name: 'Taylor Teacher work clock' });
  expect(within(arriving).getByText('Checked out')).toBeVisible();
  expect(within(arriving).getByRole('button', { name: 'Check in Alex Cleaner' })).toBeEnabled();
  expect(within(arriving).queryByRole('button', { name: /Check out/ })).not.toBeInTheDocument();
  expect(within(leaving).getByText('Checked in')).toBeVisible();
  expect(within(leaving).getByRole('button', { name: 'Check out Taylor Teacher' })).toBeEnabled();
  expect(within(leaving).queryByRole('button', { name: /Check in/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Former Employee')).not.toBeInTheDocument();
  expect(screen.queryByText(/hourly rate|gross pay|paid hours|tax identifier/i)).not.toBeInTheDocument();
  expect(axios.get).toHaveBeenCalledWith(url, { signal: expect.any(AbortSignal) });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find staff' }), { target: { value: '  CLEANER ' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('article')).toHaveAccessibleName('Alex Cleaner work clock');
});

test('an editor can record individual staff attendance without a payroll projection', async () => {
  render(view({ ...testAccount, role: 'editor', staffMemberId: 'arriving' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check out Taylor Teacher' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  expect(axios.post).toHaveBeenCalledWith(API_BASE_URL + '/api/work-time/staff/leaving/clock', {
    action: 'checkout', version: 4, requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  }, { signal: expect.any(AbortSignal) });
  expect(await screen.findByText('Taylor Teacher checked out.')).toBeVisible();
  expect(vi.mocked(axios.get).mock.calls.every(([path]) => path === url)).toBe(true);
});

test.each([
  { label: 'teacher', account: { ...testAccount, role: 'teacher' as const }, offline: false },
  { label: 'viewer', account: { ...testAccount, role: 'viewer' as const }, offline: false },
  { label: 'signed out', account: null, offline: false },
  { label: 'disabled administrator', account: { ...testAccount, disabled: true }, offline: false },
  { label: 'temporary password', account: { ...testAccount, mustChangePassword: true }, offline: false },
  { label: 'offline administrator', account: testAccount, offline: true },
])('$label cannot load or mutate the manager clock', ({ account, offline }) => {
  render(view(account, offline));
  expect(screen.getByRole('alert')).toHaveTextContent(offline ? 'connection is interrupted' : 'Administrator or editor access is required');
  expect(axios.get).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});

test('a pending check-in cannot be submitted twice and becomes a checkout after refreshed server status', async () => {
  const write = pending<{ data: { data: { replayed: boolean } } }>();
  vi.mocked(axios.post).mockReturnValue(write.promise);
  const checkedIn = initial(); checkedIn.staff[0] = { ...checkedIn.staff[0], checkedIn: true, version: 3 };
  vi.mocked(axios.get).mockResolvedValueOnce(response()).mockResolvedValue(response(checkedIn));
  render(view());
  const checkin = await screen.findByRole('button', { name: 'Check in Alex Cleaner' });
  fireEvent.click(checkin); fireEvent.click(checkin);
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(checkin).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check out Taylor Teacher' })).toBeDisabled();
  expect(report).toHaveBeenLastCalledWith(false, true);
  const unloading = new Event('beforeunload', { cancelable: true });
  fireEvent(window, unloading); expect(unloading.defaultPrevented).toBe(true);
  await act(async () => { write.resolve({ data: { data: { replayed: false } } }); });
  expect(await screen.findByRole('button', { name: 'Check out Alex Cleaner' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Check in Alex Cleaner' })).not.toBeInTheDocument();
  expect(screen.getByText('Alex Cleaner checked in.')).toBeVisible();
  expect(report).toHaveBeenLastCalledWith(false, false);
});

test('a conflicting version refreshes status and requires an explicit new action instead of repeating a write', async () => {
  const changed = initial(); changed.staff[0] = { ...changed.staff[0], checkedIn: true, version: 3 };
  vi.mocked(axios.get).mockResolvedValueOnce(response()).mockResolvedValue(response(changed));
  vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
  render(view());
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Alex Cleaner' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Staff status changed. Review the refreshed status before choosing an action. No action was repeated.');
  expect(axios.post).toHaveBeenCalledTimes(1);
  const originalId = (vi.mocked(axios.post).mock.calls[0][1] as { requestId: string }).requestId;
  fireEvent.click(screen.getByRole('button', { name: 'Check out Alex Cleaner' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(axios.post).mock.calls[1][1]).toEqual({ action: 'checkout', version: 3, requestId: expect.any(String) });
  expect((vi.mocked(axios.post).mock.calls[1][1] as { requestId: string }).requestId).not.toBe(originalId);
});

test('an uncertain result retains the same request ID for an explicit retry of the unchanged status', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Synthetic connection loss'));
  render(view());
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Alex Cleaner' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm this clock action. Review the refreshed status before trying again.');
  expect(axios.post).toHaveBeenCalledTimes(1);
  const original = vi.mocked(axios.post).mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Check in Alex Cleaner' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(axios.post).mock.calls[1][1]).toEqual(original);
  expect(await screen.findByText('Alex Cleaner checked in.')).toBeVisible();
});

test('a saved clock action with an unreadable refresh removes stale actions until status can be loaded', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('Synthetic refresh failure')).mockResolvedValue(response());
  render(view());
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Alex Cleaner' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The clock action was saved, but the latest status could not be loaded. Refresh before recording another action.');
  expect(screen.queryByRole('button', { name: 'Check in Alex Cleaner' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh staff clock' }));
  expect(await screen.findByRole('button', { name: 'Check in Alex Cleaner' })).toBeEnabled();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('unmounting aborts a pending clock action and cannot refresh or announce its result later', async () => {
  const write = pending<{ data: { data: { replayed: boolean } } }>();
  vi.mocked(axios.post).mockReturnValue(write.promise);
  const { unmount } = render(view());
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Alex Cleaner' }));
  const signal = vi.mocked(axios.post).mock.calls[0][2]?.signal;
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { write.resolve({ data: { data: { replayed: false } } }); });
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenLastCalledWith(false, false);
});

test('losing manager access immediately clears staff status and aborts its active request', async () => {
  const refresh = pending<ReturnType<typeof response>>();
  vi.mocked(axios.get).mockResolvedValueOnce(response()).mockReturnValueOnce(refresh.promise);
  const { rerender } = render(view());
  await screen.findByRole('article', { name: 'Alex Cleaner work clock' });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
  const signal = vi.mocked(axios.get).mock.calls[1][1]?.signal;
  rerender(view({ ...testAccount, role: 'viewer' }));
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByText('Alex Cleaner')).not.toBeInTheDocument();
  await act(async () => { refresh.resolve(response()); });
  expect(screen.getByRole('alert')).toHaveTextContent('Administrator or editor access is required');
  expect(screen.queryByRole('button', { name: /Check in|Check out/ })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});

test('refresh failures do not claim the facility has no active staff', async () => {
  vi.mocked(axios.get).mockRejectedValueOnce(new Error('Synthetic outage'));
  render(view());
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load staff clock status. Refresh to try again.');
  expect(screen.queryByText('No active staff')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh staff clock' }));
  expect(await screen.findByRole('button', { name: 'Check in Alex Cleaner' })).toBeEnabled();
});
