import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import ClockStationSetup from './ClockStationSetup';
import { API_BASE_URL } from '../../lib/api';
import type { Account, Role } from '../../auth/context';

const { auth, report } = vi.hoisted(() => ({
  auth: { account: { id: 'admin-a', role: 'admin', disabled: false, mustChangePassword: false } as Account | null, serverUnavailable: false },
  report: vi.fn(),
}));
vi.mock('../../auth/context', () => ({ useAuth: () => auth }));
vi.mock('../UnsavedChangesContext', () => ({ useUnsavedChanges: () => report }));
vi.mock('../../auth/transport', () => ({ authError: (_error: unknown, fallback: string) => fallback }));
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });

type SetupData = {
  stations: { id: string; name: string; createdAt: string; lastUsedAt: string | null; expiresAt: string; revokedAt: string | null }[];
  staff: { id: string; name: string; active: boolean; pinConfigured: boolean }[];
};
const url = API_BASE_URL + '/api/clock-stations';
let data: SetupData;
const formatted = (value: string) => new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
function view() { return <MemoryRouter><ClockStationSetup /></MemoryRouter>; }
async function open() {
  const result = render(view());
  await screen.findByRole('button', { name: 'Create pairing code' });
  return result;
}
function submitPin(name = 'Maya', pin = '123456') {
  const input = screen.getByLabelText('New 6-digit PIN for ' + name);
  fireEvent.change(input, { target: { value: pin } });
  fireEvent.submit(input.closest('form')!);
  return input;
}
beforeEach(() => {
  vi.resetAllMocks();
  auth.account = { id: 'admin-a', username: 'admin-a', displayName: 'Administrator', role: 'admin', disabled: false, mustChangePassword: false };
  auth.serverUnavailable = false;
  data = {
    stations: [{ id: 'tablet/a', name: 'Front desk', createdAt: '2026-10-01T10:00:00Z', lastUsedAt: '2026-10-23T08:30:00Z', expiresAt: '2099-01-01T10:00:00Z', revokedAt: null }],
    staff: [{ id: 'staff/a', name: 'Maya', active: true, pinConfigured: false }, { id: 'staff-b', name: 'Riley', active: true, pinConfigured: true }, { id: 'staff-old', name: 'Archived employee', active: false, pinConfigured: true }],
  };
  vi.mocked(axios.get).mockImplementation(async () => ({ data: { data: structuredClone(data) } }));
  vi.mocked(axios.post).mockResolvedValue({ data: { data: {} } });
});
afterEach(() => vi.restoreAllMocks());

test.each(['editor', 'teacher', 'viewer'] as Role[])('%s cannot load or change clock station setup', role => {
  auth.account!.role = role;
  render(view());
  expect(screen.getByRole('alert')).toHaveTextContent('Administrator access is required');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});

test.each(['no account', 'disabled', 'password change', 'offline'] as const)('blocked administrator has no setup requests: %s', mode => {
  if (mode === 'no account') auth.account = null;
  if (mode === 'disabled') auth.account!.disabled = true;
  if (mode === 'password change') auth.account!.mustChangePassword = true;
  if (mode === 'offline') auth.serverUnavailable = true;
  render(view());
  expect(screen.getByRole('alert')).toHaveTextContent(mode === 'offline' ? 'The connection is interrupted.' : 'Administrator access is required');
  expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});

test('setup lists active staff, PIN status and tablet expiry without exposing employee records', async () => {
  await open();
  expect(axios.get).toHaveBeenCalledWith(url, { signal: expect.any(AbortSignal) });
  expect(screen.getByRole('heading', { name: 'Clock station setup' })).toBeVisible();
  expect(screen.getByText(/Staff do not need a sign-in account/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'the staff clock station' })).toHaveAttribute('href', '/time-clock');
  expect(screen.getByRole('link', { name: 'the staff clock station' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: 'the staff clock station' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/up to 90 days/)).toBeVisible();
  expect(within(screen.getByRole('article', { name: 'Maya clock PIN' })).getByText('PIN not set')).toBeVisible();
  expect(within(screen.getByRole('article', { name: 'Riley clock PIN' })).getByText('PIN is set')).toBeVisible();
  expect(screen.queryByText('Archived employee')).not.toBeInTheDocument();
  const station = within(screen.getByRole('article', { name: 'Front desk clock station' }));
  expect(station.getByText('Connected')).toBeVisible();
  expect(station.getByText(formatted(data.stations[0].expiresAt))).toBeVisible();
  expect(station.getByText(formatted(data.stations[0].lastUsedAt!))).toBeVisible();
  expect(screen.queryByText(/hourly rate|tax identifier|payroll profile/i)).not.toBeInTheDocument();
});

test('pairing creates a trimmed name and shows a temporary code only in the open page', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem');
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { code: 'PAIR-ONLY-867530', expiresAt: '2099-01-01T10:15:00Z' } } });
  const shown = await open();
  const name = screen.getByLabelText('Clock station name');
  fireEvent.change(name, { target: { value: '  Academy tablet  ' } });
  expect(report).toHaveBeenLastCalledWith(true, false);
  fireEvent.submit(name.closest('form')!);
  const code = await screen.findByLabelText('Pairing code');
  expect(code).toHaveTextContent('PAIR-ONLY-867530');
  expect(axios.post).toHaveBeenCalledWith(url + '/pairing', { name: 'Academy tablet' }, { signal: expect.any(AbortSignal) });
  expect(screen.getByText('Expires ' + formatted('2099-01-01T10:15:00Z') + '. Keep this page open until the tablet is connected.')).toBeVisible();
  expect(name).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Hide pairing code' }));
  expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
  expect(store).not.toHaveBeenCalled();
  shown.unmount();
  await open();
  expect(screen.queryByText('PAIR-ONLY-867530')).not.toBeInTheDocument();
  expect(store).not.toHaveBeenCalled();
});

test('pairing code is discarded on unmount even when it was not explicitly hidden', async () => {
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { code: 'ONLY-ONCE-445566', expiresAt: '2099-01-01T10:15:00Z' } } });
  const shown = await open();
  fireEvent.change(screen.getByLabelText('Clock station name'), { target: { value: 'Tablet' } });
  fireEvent.submit(screen.getByLabelText('Clock station name').closest('form')!);
  await screen.findByText('ONLY-ONCE-445566');
  shown.unmount();
  await open();
  expect(screen.queryByText('ONLY-ONCE-445566')).not.toBeInTheDocument();
});

test.each(['', '12345', '1234567', 'abcdef', '123 56'])('invalid six-digit PIN is never submitted: %j', async pin => {
  await open();
  const input = submitPin('Maya', pin);
  expect(input).toHaveAttribute('type', 'password');
  expect(input).toHaveAttribute('autocomplete', 'off');
  expect(axios.post).not.toHaveBeenCalled();
});

test('setting a PIN refreshes its status and clears the secret without displaying returned credentials', async () => {
  vi.mocked(axios.post).mockImplementationOnce(async () => {
    data.staff[0].pinConfigured = true;
    return { data: { data: { pin: '123456', secret: 'NEVER-DISPLAY-RAW-RESPONSE' } } };
  });
  await open();
  const input = submitPin();
  expect(await screen.findByText('PIN saved for Maya.')).toBeVisible();
  expect(axios.post).toHaveBeenCalledWith(url + '/staff/staff%2Fa/pin', { pin: '123456' }, { signal: expect.any(AbortSignal) });
  expect(input).toHaveValue('');
  expect(within(screen.getByRole('article', { name: 'Maya clock PIN' })).getByText('PIN is set')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reset PIN for Maya' })).toBeEnabled();
  expect(screen.queryByText('123456')).not.toBeInTheDocument();
  expect(screen.queryByText('NEVER-DISPLAY-RAW-RESPONSE')).not.toBeInTheDocument();
  expect(report).toHaveBeenLastCalledWith(false, false);
});

test('a rejected PIN change clears the secret and leaves an explicit retry action', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('PIN-RAW-SECRET-123456'));
  await open();
  const input = submitPin();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this clock station change. Try again.');
  expect(input).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Set PIN for Maya' })).toBeEnabled();
  expect(screen.queryByText('PIN-RAW-SECRET-123456')).not.toBeInTheDocument();
  expect(report).toHaveBeenLastCalledWith(false, false);
});

test('disabling a PIN sends null, clears its draft and refreshes the available action', async () => {
  vi.mocked(axios.post).mockImplementationOnce(async () => { data.staff[1].pinConfigured = false; return { data: { data: {} } }; });
  await open();
  const input = screen.getByLabelText('New 6-digit PIN for Riley');
  fireEvent.change(input, { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Disable PIN for Riley' }));
  expect(await screen.findByText('PIN disabled for Riley.')).toBeVisible();
  expect(axios.post).toHaveBeenCalledWith(url + '/staff/staff-b/pin', { pin: null }, { signal: expect.any(AbortSignal) });
  expect(input).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Disable PIN for Riley' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Set PIN for Riley' })).toBeEnabled();
});

test('revocation blocks duplicate writes until refreshed tablet status is shown', async () => {
  let finish: (value: { data: { data: unknown } }) => void = () => {};
  vi.mocked(axios.post).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open();
  const revoke = screen.getByRole('button', { name: 'Revoke Front desk' });
  fireEvent.click(revoke); fireEvent.click(revoke);
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(revoke).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Create pairing code' })).toBeDisabled();
  expect(axios.post).toHaveBeenCalledWith(url + '/tablet%2Fa/revoke', {}, { signal: expect.any(AbortSignal) });
  await act(async () => { data.stations[0].revokedAt = '2026-10-23T09:00:00Z'; finish({ data: { data: {} } }); });
  expect(screen.getByText('Clock station disconnected: Front desk.')).toBeVisible();
  expect(within(screen.getByRole('article', { name: 'Front desk clock station' })).getByText('Revoked')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Revoke Front desk' })).not.toBeInTheDocument();
});

test('expired station access shows its date and status instead of connected', async () => {
  data.stations[0].expiresAt = '2000-01-01T10:00:00Z'; data.stations[0].lastUsedAt = null;
  await open();
  const station = within(screen.getByRole('article', { name: 'Front desk clock station' }));
  expect(station.getByText('Expired')).toBeVisible();
  expect(station.getByText(formatted(data.stations[0].expiresAt))).toBeVisible();
  expect(station.getByText('Not used yet')).toBeVisible();
  expect(station.queryByText('Connected')).not.toBeInTheDocument();
});

test('connection loss unmounts setup, clears its drafts and prevents further writes', async () => {
  const shown = await open();
  fireEvent.change(screen.getByLabelText('New 6-digit PIN for Maya'), { target: { value: '123456' } });
  auth.serverUnavailable = true; shown.rerender(view());
  expect(screen.getByRole('alert')).toHaveTextContent('The connection is interrupted.');
  expect(screen.queryByLabelText('New 6-digit PIN for Maya')).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
  expect(report).toHaveBeenLastCalledWith(false, false);
  auth.serverUnavailable = false; shown.rerender(view());
  expect(await screen.findByLabelText('New 6-digit PIN for Maya')).toHaveValue('');
});
