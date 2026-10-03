import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import AuthProvider from './AuthProvider';
import AuthGate from './AuthGate';
import { useAuth } from './context';
import Accounts from '../pages/Accounts';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import { replaceSession } from './transport';

const expired = vi.hoisted(() => new Set<() => void>());
const unreachable = vi.hoisted(() => new Set<() => void>());
vi.mock('./transport', async (original) => ({ ...await original<typeof import('./transport')>(),
  replaceSession: vi.fn(), onSessionExpired: (callback: () => void) => { expired.add(callback); return () => expired.delete(callback); },
  onServerUnavailable: (callback: () => void) => { unreachable.add(callback); return () => unreachable.delete(callback); } }));
vi.mock('axios', async (original) => {
  const real = await original<typeof import('axios')>();
  return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});
const session = { account: testAccount, csrfToken: 'synthetic-csrf' };
const failure = (status: number, message: string) => ({ isAxiosError: true, response: { status, data: { error: { message } } } });
function PrivateView() {
  const { signOut } = useAuth();
  return <div><h1>Private operations</h1><input aria-label="Draft note" defaultValue="" /><button onClick={() => { void signOut(); }}>Sign out</button></div>;
}
const app = () => render(<AuthProvider><AuthGate><PrivateView /></AuthGate></AuthProvider>);
beforeEach(() => { vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); vi.mocked(replaceSession).mockClear(); expired.clear(); unreachable.clear(); });

test('does not mount operational pages before a successful sign-in', async () => {
  vi.mocked(axios.get).mockRejectedValueOnce(failure(401, 'Sign in to continue.'));
  vi.mocked(axios.post).mockResolvedValueOnce({ data: session });
  app();
  expect(screen.queryByText('Private operations')).not.toBeInTheDocument();
  await screen.findByRole('heading', { name: 'Sign in' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'test-admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Synthetic passphrase 20!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Private operations');
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
});

test('failed and rate-limited sign-ins show a clear message and clear the password input', async () => {
  vi.mocked(axios.get).mockRejectedValueOnce(failure(401, 'Sign in to continue.'));
  vi.mocked(axios.post).mockRejectedValueOnce(failure(429, 'Too many attempts. Please try again later.'));
  app();
  await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'example' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Synthetic wrong passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  expect(screen.getByLabelText('Password')).toHaveValue('');
  expect(screen.queryByText('Private operations')).not.toBeInTheDocument();
});

test('requires a temporary password change before exposing operations', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { ...session, account: { ...testAccount, mustChangePassword: true } } });
  vi.mocked(axios.post).mockResolvedValueOnce({ data: session });
  app();
  await screen.findByRole('heading', { name: 'Change password' });
  expect(screen.queryByText('Private operations')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Synthetic temporary password' } });
  fireEvent.change(screen.getByLabelText('New password', { exact: true }), { target: { value: 'Synthetic changed password' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Synthetic changed password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }));
  await screen.findByText('Private operations');
});

test('session expiry unmounts operational state and prompts for another sign-in', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: session });
  app();
  await screen.findByText('Private operations');
  act(() => expired.forEach((callback) => callback()));
  await screen.findByRole('heading', { name: 'Sign in' });
  expect(screen.getByRole('status')).toHaveTextContent('session has expired');
  expect(screen.queryByText('Private operations')).not.toBeInTheDocument();
});

test('sign-out clears the private view and reports success', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: session });
  vi.mocked(axios.post).mockResolvedValueOnce({ status: 204 });
  app();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('You have signed out.'));
  expect(screen.queryByText('Private operations')).not.toBeInTheDocument();
});

test('non-administrators cannot open the account-management page or fetch its data', () => {
  render(<SignedIn account={{ ...testAccount, role: 'viewer' }}><Accounts /></SignedIn>);
  expect(screen.getByRole('alert')).toHaveTextContent('Administrator access is required');
  expect(axios.get).not.toHaveBeenCalled();
});

test.each([0, 502, 503, 504])('startup failure %i shows a connection screen and retries the live session without submitting a login', async status => {
  vi.mocked(axios.get).mockRejectedValueOnce(status ? failure(status, 'Unavailable') : { isAxiosError: true, code: 'ERR_NETWORK' });
  app();
  await screen.findByRole('heading', { name: 'We can’t reach the academy computer' });
  expect(screen.queryByText('Private operations')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  vi.mocked(axios.get).mockResolvedValueOnce({ data: session });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Private operations');
  expect(axios.post).not.toHaveBeenCalled();
  expect(axios.get).toHaveBeenLastCalledWith(expect.stringContaining('/auth/session'), expect.objectContaining({ timeout: 8000 }));
});

test('runtime outage and recovery keep the same open draft and do not rotate or retry writes', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: session });
  app();
  const draft = await screen.findByLabelText('Draft note');
  fireEvent.change(draft, { target: { value: 'Unsaved synthetic work' } });
  act(() => unreachable.forEach(callback => callback()));
  await screen.findByRole('heading', { name: 'Connection interrupted' });
  expect(screen.getByLabelText('Draft note')).toHaveValue('Unsaved synthetic work');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText(/Connection restored\./);
  expect(screen.getByLabelText('Draft note')).toBe(draft);
  expect(draft).toHaveValue('Unsaved synthetic work');
  expect(replaceSession).toHaveBeenCalledTimes(1);
  expect(axios.post).not.toHaveBeenCalled();
});

test('reconnection still rejects an expired session and clears the operational form', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: session });
  app();
  await screen.findByLabelText('Draft note');
  act(() => unreachable.forEach(callback => callback()));
  vi.mocked(axios.get).mockRejectedValueOnce(failure(401, 'Session expired'));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('heading', { name: 'Sign in' });
  expect(screen.queryByLabelText('Draft note')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'We can’t reach the academy computer' })).not.toBeInTheDocument();
});

test('an offline internet hint does not block a working local API', async () => {
  const hint = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  try {
    vi.mocked(axios.get).mockResolvedValue({ data: session });
    app();
    await screen.findByText('Private operations');
    act(() => window.dispatchEvent(new Event('offline')));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Private operations')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Connection interrupted' })).not.toBeInTheDocument();
  } finally { hint.mockRestore(); }
});

test.each([false, true])('login submits the explicit remembered choice %s without storing credentials', async rememberMe => {
  vi.mocked(axios.get).mockRejectedValueOnce(failure(401, 'Sign in to continue.'));
  vi.mocked(axios.post).mockResolvedValueOnce({ data: session });
  app();
  const box = await screen.findByRole('checkbox', { name: 'Keep me signed in' });
  expect(box).not.toBeChecked();
  expect(box).toHaveAccessibleDescription('Only use this on a device you trust. Sign out on shared devices.');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'test-admin' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Synthetic passphrase 20!' } });
  if (rememberMe) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Private operations');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/auth/login'), {
    username: 'test-admin', password: 'Synthetic passphrase 20!', rememberMe,
  });
  vi.mocked(axios.post).mockResolvedValueOnce({ status: 204 });
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('checkbox', { name: 'Keep me signed in' })).not.toBeChecked();
});
