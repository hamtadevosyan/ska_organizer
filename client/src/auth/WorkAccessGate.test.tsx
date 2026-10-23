import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import AuthGate from './AuthGate';
import AuthProvider from './AuthProvider';
import { useAuth } from './context';
import type { Account, Role } from './context';
import { testAccount } from '../tests/authAccount';
import { replaceSession } from './transport';

const { workDenied, unavailable } = vi.hoisted(() => ({ workDenied: new Set<() => void>(), unavailable: new Set<() => void>() }));
vi.mock('./transport', async original => ({ ...await original<typeof import('./transport')>(), replaceSession: vi.fn(),
  onWorkAccessRequired: (callback: () => void) => { workDenied.add(callback); return () => workDenied.delete(callback); },
  onServerUnavailable: (callback: () => void) => { unavailable.add(callback); return () => unavailable.delete(callback); },
}));
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });

const protectedUrl = '/api/private-work-gate-fixture';
const message = 'Please check in to continue. Use the check-in station or ask an administrator to check you in.';
const refreshName = "I've checked in—refresh";
const detached = vi.fn();
const linked = (role: Role = 'teacher', checkedIn = true): Account => ({ ...testAccount, id: 'employee-account', role, roomId: checkedIn ? 'classroom' : null,
  staffMemberId: checkedIn ? 'employee' : null, linkedStaff: checkedIn ? { id: 'employee', name: 'Private Staff Name', active: true, roomId: 'classroom' } : null,
  workAccess: { required: true, checkedIn, available: true } });
const session = (account: Account) => ({ data: { account, csrfToken: 'work-gate-csrf' } });
const failure = (status: number) => ({ isAxiosError: true, response: { status, data: { error: { message: 'Synthetic verification failure' } } } });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function Protected() {
  const [privateResponse, setPrivateResponse] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void axios.get(protectedUrl, { signal: controller.signal }).then(response => { if (!controller.signal.aborted) setPrivateResponse(response.data); }).catch(() => {});
    return () => { controller.abort(); detached(); };
  }, []);
  return <div><h1>Protected classroom</h1><input aria-label="Unsaved employee draft" defaultValue="" />{privateResponse && <p>{privateResponse}</p>}</div>;
}
function Scope() { const { account } = useAuth(); return <output aria-label="Current account scope">{JSON.stringify(account)}</output>; }
function app(inspect = false) { return render(<AuthProvider>{inspect && <Scope />}<AuthGate><Protected /></AuthGate></AuthProvider>); }
function mockSessions(account: Account) { vi.mocked(axios.get).mockImplementation(async url => url === protectedUrl ? { data: 'Fresh authorized response' } : session(account)); }
const protectedCalls = () => vi.mocked(axios.get).mock.calls.filter(([url]) => url === protectedUrl);
async function protectedRequest(count = 1) {
  // The DOM can commit before the passive effect starts its request.
  await waitFor(() => expect(protectedCalls()).toHaveLength(count));
  return protectedCalls()[count - 1];
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); workDenied.clear(); unavailable.clear(); });
afterEach(async () => {
  // Unmount and flush effects while their Axios implementation is still installed.
  await act(async () => { cleanup(); });
  vi.restoreAllMocks();
});

test.each(['editor', 'teacher', 'viewer'] as const)('a redacted off-clock %s session cannot mount or fetch any protected content', async role => {
  mockSessions(linked(role, false)); app();
  expect(await screen.findByRole('heading', { name: 'Please check in to continue' })).toBeVisible();
  expect(screen.getByText(message, { exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: refreshName })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /^Check in |^Check out / })).not.toBeInTheDocument();
  expect(screen.queryByText(/Private Staff Name|Protected classroom|hourly rate|paid hours|allergy/i)).not.toBeInTheDocument();
  expect(protectedCalls()).toHaveLength(0);
});

test('a linked account with missing or unavailable work metadata fails closed before any private request', async () => {
  const account = linked(); delete account.workAccess; mockSessions(account);
  const shown = app();
  await screen.findByText(message, { exact: true }); expect(protectedCalls()).toHaveLength(0);
  expect(screen.getByRole('status')).toHaveTextContent('could not verify your check-in');
  shown.unmount();
  mockSessions({ ...linked('editor', false), workAccess: { required: true, checkedIn: false, available: false } }); app();
  await screen.findByText(message, { exact: true }); expect(protectedCalls()).toHaveLength(0);
});

test('missing work metadata cannot turn a previously redacted employee session into an unlinked account', async () => {
  mockSessions(linked('teacher', false)); app();
  await screen.findByText(message, { exact: true });
  const missing = linked('teacher', false); delete missing.workAccess;
  mockSessions(missing); fireEvent.click(screen.getByRole('button', { name: refreshName }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not verify your check-in'));
  expect(screen.getByText(message, { exact: true })).toBeVisible();
  expect(protectedCalls()).toHaveLength(0);
});

test.each([
  { label: 'administrator', account: { ...linked('admin', false), workAccess: { required: true, checkedIn: false, available: false } } },
  { label: 'unlinked organization viewer', account: { ...testAccount, role: 'viewer' as const, staffMemberId: null, workAccess: { required: false, checkedIn: false, available: true } } },
])('$label keeps ordinary account access without employee check-in', async ({ account }) => {
  mockSessions(account); app();
  expect(await screen.findByRole('heading', { name: 'Protected classroom' })).toBeVisible();
  expect(screen.queryByText(message, { exact: true })).not.toBeInTheDocument();
  await protectedRequest();
});

test('the refresh action unlocks only after a fresh checked-in session and does not submit a personal clock action', async () => {
  mockSessions(linked('teacher', false)); app();
  await screen.findByText(message, { exact: true });
  const verification = pending<ReturnType<typeof session>>(); vi.mocked(axios.get).mockReturnValueOnce(verification.promise);
  fireEvent.click(screen.getByRole('button', { name: refreshName }));
  expect(screen.getByRole('button', { name: refreshName })).toBeDisabled();
  expect(protectedCalls()).toHaveLength(0);
  await act(async () => { verification.resolve(session(linked())); });
  expect(await screen.findByRole('heading', { name: 'Protected classroom' })).toBeVisible();
  await protectedRequest(); expect(axios.post).not.toHaveBeenCalled();
});

test('a work-access rejection clears drafts, redacts linked details and aborts a pending protected response', async () => {
  const privateResponse = pending<{ data: string }>();
  vi.mocked(axios.get).mockImplementation(async url => url === protectedUrl ? privateResponse.promise : session(linked()));
  app(true);
  const draft = await screen.findByLabelText('Unsaved employee draft'); fireEvent.change(draft, { target: { value: 'Sensitive unsaved draft' } });
  const [, config] = await protectedRequest();
  const signal = config?.signal;
  act(() => workDenied.forEach(callback => callback()));
  await screen.findByText(message, { exact: true });
  expect(signal?.aborted).toBe(true); expect(detached).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Unsaved employee draft')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Current account scope')).toHaveTextContent('"roomId":null');
  expect(screen.getByLabelText('Current account scope')).toHaveTextContent('"staffMemberId":null');
  expect(screen.getByLabelText('Current account scope')).not.toHaveTextContent('Private Staff Name');
  await act(async () => { privateResponse.resolve({ data: 'Late private health information' }); });
  expect(screen.queryByText('Late private health information')).not.toBeInTheDocument();
  mockSessions(linked()); fireEvent.click(screen.getByRole('button', { name: refreshName }));
  expect(await screen.findByLabelText('Unsaved employee draft')).toHaveValue('');
  await protectedRequest(2);
});

test('an older successful session check cannot unlock the app after a newer work-access rejection', async () => {
  mockSessions(linked()); app(); await screen.findByLabelText('Unsaved employee draft');
  await protectedRequest();
  const verification = pending<ReturnType<typeof session>>(); vi.mocked(axios.get).mockReturnValueOnce(verification.promise);
  fireEvent(window, new Event('focus'));
  const checkSignal = vi.mocked(axios.get).mock.calls.at(-1)?.[1]?.signal;
  act(() => workDenied.forEach(callback => callback()));
  expect(checkSignal?.aborted).toBe(true);
  await act(async () => { verification.resolve(session(linked())); });
  expect(screen.getByText(message, { exact: true })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Protected classroom' })).not.toBeInTheDocument();
});

test('focus immediately masks private content until verification finishes and fails closed on any check error', async () => {
  mockSessions(linked()); app(); const draft = await screen.findByLabelText('Unsaved employee draft');
  await protectedRequest();
  fireEvent.change(draft, { target: { value: 'Old work' } });
  const verification = pending<ReturnType<typeof session>>(); vi.mocked(axios.get).mockReturnValueOnce(verification.promise);
  fireEvent(window, new Event('focus'));
  expect(draft).not.toBeVisible();
  expect(draft.closest('[inert]')).not.toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Checking your check-in');
  await act(async () => { verification.resolve(session(linked())); });
  await waitFor(() => expect(draft).toBeVisible());
  expect(screen.getByLabelText('Unsaved employee draft')).toBe(draft);
  expect(draft).toHaveValue('Old work');
  vi.mocked(axios.get).mockRejectedValueOnce(failure(500)); fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not verify your check-in'));
  expect(screen.queryByLabelText('Unsaved employee draft')).not.toBeInTheDocument();
});

test('a live protected API outage clears an employee view while an offline hint can recover from the local server', async () => {
  mockSessions(linked()); app(); await screen.findByLabelText('Unsaved employee draft');
  await protectedRequest();
  act(() => unavailable.forEach(callback => callback()));
  await screen.findByText(message, { exact: true });
  expect(screen.queryByLabelText('Unsaved employee draft')).not.toBeInTheDocument();
  fireEvent(window, new Event('offline'));
  expect(await screen.findByLabelText('Unsaved employee draft')).toHaveValue('');
  await protectedRequest(2);
  expect(axios.post).not.toHaveBeenCalled();
});

test('hiding the tab conceals employee information and showing it waits for fresh verification', async () => {
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  mockSessions(linked()); app(); const draft = await screen.findByLabelText('Unsaved employee draft');
  await protectedRequest();
  visibility = 'hidden'; fireEvent(document, new Event('visibilitychange'));
  expect(draft).not.toBeVisible();
  expect(draft.closest('[inert]')).not.toBeNull();
  const verification = pending<ReturnType<typeof session>>(); vi.mocked(axios.get).mockReturnValueOnce(verification.promise);
  visibility = 'visible'; fireEvent(document, new Event('visibilitychange'));
  expect(screen.getByRole('status')).toHaveTextContent('Checking your check-in');
  await act(async () => { verification.resolve(session(linked('teacher', false))); });
  expect(screen.getByText(message, { exact: true })).toBeVisible();
  expect(screen.queryByLabelText('Unsaved employee draft')).not.toBeInTheDocument();
  expect(protectedCalls()).toHaveLength(1);
});

test('linked employee status is revalidated on the five-second timer and checkout removes the protected view', async () => {
  const interval = vi.spyOn(window, 'setInterval'); mockSessions(linked()); app();
  await screen.findByLabelText('Unsaved employee draft');
  await protectedRequest();
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000);
  vi.mocked(axios.get).mockImplementation(async url => url === protectedUrl ? { data: 'Private response' } : session(linked('teacher', false)));
  const tick = interval.mock.calls.find(([, delay]) => delay === 5000)![0] as () => void;
  await act(async () => tick());
  expect(screen.getByText(message, { exact: true })).toBeVisible();
  expect(screen.queryByLabelText('Unsaved employee draft')).not.toBeInTheDocument();
  expect(replaceSession).toHaveBeenCalledTimes(2);
});

test('a slow session verification is allowed to finish rather than being canceled by each polling tick', async () => {
  const interval = vi.spyOn(window, 'setInterval'); mockSessions(linked()); app();
  await screen.findByLabelText('Unsaved employee draft');
  await protectedRequest();
  const verification = pending<ReturnType<typeof session>>(); vi.mocked(axios.get).mockReturnValueOnce(verification.promise);
  const tick = interval.mock.calls.find(([, delay]) => delay === 5000)![0] as () => void;
  act(() => tick()); const count = vi.mocked(axios.get).mock.calls.length;
  const signal = vi.mocked(axios.get).mock.calls.at(-1)?.[1]?.signal;
  act(() => tick()); expect(axios.get).toHaveBeenCalledTimes(count); expect(signal?.aborted).toBe(false);
  await act(async () => { verification.resolve(session(linked('teacher', false))); });
  expect(screen.getByText(message, { exact: true })).toBeVisible();
  expect(screen.queryByLabelText('Unsaved employee draft')).not.toBeInTheDocument();
});

test('sign-out stays available off the clock and clears the authenticated account', async () => {
  mockSessions(linked('teacher', false)); vi.mocked(axios.post).mockResolvedValue({ status: 204 }); app();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(axios.post).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/logout$/), {});
  expect(protectedCalls()).toHaveLength(0);
});

test('password changes remain available off the clock and do not unlock protected content', async () => {
  mockSessions(linked('teacher', false)); vi.mocked(axios.post).mockResolvedValue(session(linked('teacher', false))); app();
  fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Current employee passphrase' } });
  fireEvent.change(screen.getByLabelText('New password', { exact: true }), { target: { value: 'Replacement employee passphrase' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Replacement employee passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }));
  expect(await screen.findByText(message, { exact: true })).toBeVisible();
  expect(axios.post).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/password$/), { currentPassword: 'Current employee passphrase', password: 'Replacement employee passphrase' });
  expect(protectedCalls()).toHaveLength(0);
});

test('a required temporary password change takes precedence over the check-in gate', async () => {
  mockSessions({ ...linked('teacher', false), mustChangePassword: true }); app();
  expect(await screen.findByRole('heading', { name: 'Change password' })).toBeVisible();
  expect(screen.queryByText(message, { exact: true })).not.toBeInTheDocument();
  expect(protectedCalls()).toHaveLength(0);
});
