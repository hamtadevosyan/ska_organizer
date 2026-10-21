import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import MyTime from './MyTime';
import { AuthContext } from '../auth/context';
import { testAccount } from '../tests/authAccount';
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });
const clock = { staff: { id: 'staff-a', name: 'Ari Example' }, version: 2, timeZone: 'America/Los_Angeles', sessions: [], days: [] };
function view(linked = true, unavailable = false) { return <AuthContext.Provider value={{ account: { ...testAccount, role: 'viewer', staffMemberId: linked ? 'staff-a' : null }, ready: true, notice: '', serverUnavailable: unavailable, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><MyTime /></AuthContext.Provider>; }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(axios.get).mockResolvedValue({ data: { data: clock } }); vi.mocked(axios.post).mockResolvedValue({ data: {} }); });
test('a linked viewer can record only their own server-timed arrival and uncertain retries keep one ID', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Synthetic network error'));
  render(view()); fireEvent.click(await screen.findByRole('button', { name: 'Check in to work' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check in to work' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(axios.post).mock.calls[0]).toEqual(vi.mocked(axios.post).mock.calls[1]);
  expect(vi.mocked(axios.post).mock.calls[0][1]).toEqual({ action: 'checkin', version: 2, requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) });
  expect(screen.queryByText(/hourly rate|tax identifier/i)).not.toBeInTheDocument();
});
test('a checked-in employee has checkout and explicit paid/unpaid breaks, with no duplicate arrival', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { data: { ...clock, sessions: [{ id: 's', start: '2026-10-20T15:00:00Z', end: null, breaks: [] }] } } });
  render(view()); expect(await screen.findByRole('button', { name: 'Check out of work' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Check in to work' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start paid rest break' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Start unpaid meal break' })).toBeEnabled();
});
test('an open break must be ended before checkout', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { data: { ...clock, sessions: [{ id: 's', start: '2026-10-20T15:00:00Z', end: null, breaks: [{ start: '2026-10-20T16:00:00Z', end: null, paid: true }] }] } } });
  render(view()); expect(await screen.findByRole('button', { name: 'End my break' })).toBeEnabled(); expect(screen.queryByRole('button', { name: 'Check out of work' })).not.toBeInTheDocument();
});
test('unlinked accounts and an unavailable server cannot record time', async () => {
  const { rerender } = render(view(false)); expect(screen.getByRole('alert')).toHaveTextContent('link your account'); expect(axios.get).not.toHaveBeenCalled();
  rerender(view(true, true)); expect(screen.getByRole('alert')).toHaveTextContent('connection is interrupted'); expect(screen.queryByRole('button', { name: /Check in/ })).not.toBeInTheDocument();
});
