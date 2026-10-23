import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import TimeClockStation from './TimeClockStation';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', async original => {
  const real = await original<typeof import('axios')>();
  return { ...real, default: { ...real.default, create: vi.fn(() => http), get: vi.fn(), post: vi.fn() } };
});
const session = { station: { name: 'Front desk', expiresAt: '2027-01-01T00:00:00Z' }, csrfToken: 'station-csrf' };
const person = { staff: { id: 'staff-a', name: 'Alex Example' }, checkedIn: false, version: 3, clockToken: 'short-lived-grant' };
const error = (status: number, code: string) => Object.assign(new Error(code), { isAxiosError: true, response: { status, data: { error: { code } } } });
async function open() { render(<TimeClockStation />); await screen.findByRole('heading', { name: 'Enter your PIN' }); }
async function identify(checkedIn = false) {
  http.post.mockResolvedValueOnce({ data: { data: { ...person, checkedIn } } });
  fireEvent.change(screen.getByLabelText('6-digit staff PIN'), { target: { value: '012345' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: person.staff.name });
}
beforeEach(() => { vi.clearAllMocks(); http.get.mockResolvedValue({ data: { data: session } }); http.post.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });

test('a public station uses its own client and pairing without a personal sign-in or employee list', async () => {
  http.get.mockRejectedValueOnce(error(401, 'STATION_EXPIRED')); render(<TimeClockStation />);
  await screen.findByRole('heading', { name: 'Pair this clock station' });
  expect(screen.queryByLabelText('Username')).not.toBeInTheDocument(); expect(screen.queryByText(person.staff.name)).not.toBeInTheDocument();
  http.post.mockResolvedValueOnce({ data: { data: session } });
  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'one-time-code' } }); fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
  await screen.findByRole('heading', { name: 'Enter your PIN' });
  expect(http.post).toHaveBeenCalledWith('/pair', { code: 'one-time-code' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});

test.each([false, true])('PIN identification shows only the applicable action (checked in: %s) and clears secrets after confirmation', async checkedIn => {
  await open(); await identify(checkedIn);
  expect(http.post).toHaveBeenLastCalledWith('/identify', { pin: '012345' }, expect.objectContaining({ headers: { 'X-CSRF-Token': session.csrfToken } }));
  expect(screen.queryByLabelText('6-digit staff PIN')).not.toBeInTheDocument();
  const action = checkedIn ? 'Check out' : 'Check in'; expect(screen.queryByRole('button', { name: checkedIn ? 'Check in' : 'Check out' })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/hours|payroll|arrived|departed|2027/);
  http.post.mockResolvedValueOnce({ data: { data: { action: checkedIn ? 'checkout' : 'checkin', replayed: false } } });
  fireEvent.click(screen.getByRole('button', { name: action }));
  await screen.findByRole('heading', { name: checkedIn ? 'You’re checked out' : 'You’re checked in' });
  expect(http.post).toHaveBeenLastCalledWith('/clock', { clockToken: person.clockToken, action: checkedIn ? 'checkout' : 'checkin', requestId: expect.any(String), version: 3 }, expect.objectContaining({ headers: { 'X-CSRF-Token': session.csrfToken } }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' })); expect(screen.getByLabelText('6-digit staff PIN')).toHaveValue(''); expect(screen.queryByText(person.staff.name)).not.toBeInTheDocument();
});

test('success resets automatically, and a second person never sees the previous identity', async () => {
  await open(); await identify(); vi.useFakeTimers(); http.post.mockResolvedValueOnce({ data: { data: { action: 'checkin' } } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check in' })); }); act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible(); expect(screen.queryByText(person.staff.name)).not.toBeInTheDocument();
});

test('inactivity and hiding the page clear a PIN or identified staff without writing time', async () => {
  vi.useFakeTimers(); await act(async () => { render(<TimeClockStation />); }); fireEvent.change(screen.getByLabelText('6-digit staff PIN'), { target: { value: '012345' } });
  await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(screen.getByLabelText('6-digit staff PIN')).toHaveValue('');
  vi.useRealTimers(); await identify(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange'));
  expect(screen.queryByText(person.staff.name)).not.toBeInTheDocument(); expect(screen.getByLabelText('6-digit staff PIN')).toHaveValue(''); expect(http.post).toHaveBeenCalledTimes(1);
});

test('hiding the page ignores a delayed identification response and never keeps the PIN', async () => {
  await open(); let resolve!: (value: unknown) => void; http.post.mockReturnValueOnce(new Promise(accept => { resolve = accept; }));
  fireEvent.change(screen.getByLabelText('6-digit staff PIN'), { target: { value: '012345' } }); fireEvent.click(screen.getByRole('button', { name: 'Continue' })); expect(screen.getByLabelText('6-digit staff PIN')).toHaveValue('');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange'));
  await act(async () => { resolve({ data: { data: person } }); }); expect(screen.queryByText(person.staff.name)).not.toBeInTheDocument();
});

test('an incorrect PIN keeps pairing but a revoked station requires pairing again', async () => {
  await open(); http.post.mockRejectedValueOnce(error(401, 'STATION_PIN_INVALID'));
  fireEvent.change(screen.getByLabelText('6-digit staff PIN'), { target: { value: '111111' } }); fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('PIN not recognized. Try again.'); expect(screen.getByLabelText('6-digit staff PIN')).toHaveValue('');
  http.post.mockRejectedValueOnce(error(401, 'STATION_EXPIRED')); fireEvent.change(screen.getByLabelText('6-digit staff PIN'), { target: { value: '012345' } }); fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('heading', { name: 'Pair this clock station' }); expect(screen.queryByText('Front desk')).not.toBeInTheDocument();
});

test.each([new Error('Network unavailable'), error(409, 'CLOCK_GRANT_STALE'), error(403, 'STATION_CSRF_INVALID')])('a failed clock clears identity, cannot retry an old grant and saves nothing offline', async failure => {
  const local = vi.spyOn(Storage.prototype, 'setItem'); await open(); await identify(); http.post.mockRejectedValueOnce(failure);
  fireEvent.click(screen.getByRole('button', { name: 'Check in' })); await waitFor(() => expect(screen.queryByText(person.staff.name)).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument(); expect(local).not.toHaveBeenCalled(); expect(http.post).toHaveBeenCalledTimes(2);
  if (screen.queryByRole('button', { name: 'Try again' })) { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await screen.findByRole('heading', { name: 'Enter your PIN' }); }
  expect(http.post).toHaveBeenCalledTimes(2); expect(screen.getByLabelText('6-digit staff PIN')).toHaveValue('');
});

test('a browser that blocks peer channels can still complete pairing without retaining its code', async () => {
  vi.stubGlobal('BroadcastChannel', class { constructor() { throw new DOMException('Blocked', 'SecurityError'); } });
  http.get.mockRejectedValueOnce(error(401, 'STATION_EXPIRED')); render(<TimeClockStation />);
  await screen.findByRole('heading', { name: 'Pair this clock station' });
  http.post.mockResolvedValueOnce({ data: { data: session } });
  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'one-time-code' } }); fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
  await screen.findByRole('heading', { name: 'Enter your PIN' }); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
});
