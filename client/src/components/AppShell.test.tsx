import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext } from '../auth/context';
import type { AuthState, Role } from '../auth/context';
import { testAccount } from '../tests/authAccount';
import AppShell from './AppShell';

const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
};
let desktop: EventTarget & { matches: boolean };

beforeAll(() => {
  // jsdom does not implement native modal focus/inert behavior; browser tests do.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
});
beforeEach(() => {
  desktop = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => desktop);
});
afterAll(() => {
  for (const name of ['showModal', 'close'] as const) {
    const descriptor = dialogMethods[name];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.unstubAllGlobals();
});

function CurrentPage() {
  const location = useLocation();
  return <h1>{location.pathname + location.search}</h1>;
}
function setup(path = '/dashboard', role: Role = 'admin', overrides: Partial<AuthState> = {}) {
  const state: AuthState = {
    account: { ...testAccount, role }, ready: true, notice: '', signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}), changePassword: vi.fn(async () => {}), retry: vi.fn(async () => {}), ...overrides,
  };
  render(<AuthContext.Provider value={state}><MemoryRouter initialEntries={[path]}>
    <AppShell><CurrentPage /></AppShell>
  </MemoryRouter></AuthContext.Provider>);
  return state;
}

test('primary navigation uses the existing routes and tracks the active page', () => {
  setup('/dashboard?date=2030-01-01');
  const nav = within(screen.getByRole('navigation', { name: 'Mobile navigation' }));
  expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/dashboard');
  expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  expect(nav.getByRole('link', { name: 'Meals' })).toHaveAttribute('href', '/meals');
  fireEvent.click(nav.getByRole('link', { name: 'Children' }));
  expect(screen.getByRole('heading', { name: '/children' })).toBeInTheDocument();
  expect(nav.getByRole('link', { name: 'Children' })).toHaveAttribute('aria-current', 'page');
  expect(nav.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
});

test.each(['admin', 'editor', 'viewer'] as const)('More and desktop preserve %s account visibility', (role) => {
  setup('/dashboard', role);
  const sidebar = within(screen.getByRole('navigation', { name: 'Desktop navigation' }));
  expect(Boolean(sidebar.queryByRole('link', { name: 'Accounts' }))).toBe(role === 'admin');
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  const more = within(screen.getByRole('navigation', { name: 'More navigation' }));
  expect(more.getAllByRole('link').map((link) => link.textContent)).toEqual([
    'Attendance', 'Rooms & Classes', 'Inventory', 'Activity Planner', 'Staff', 'Reports', ...(role === 'admin' ? ['Accounts'] : []),
  ]);
  expect(more.queryByRole('link', { name: 'Meals' })).not.toBeInTheDocument();
});

test('More highlights secondary routes including filters and closes after navigation', () => {
  setup('/inventory?status=low');
  const trigger = screen.getByRole('button', { name: 'More' });
  expect(trigger).toHaveAttribute('aria-current', 'true');
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const dialog = within(screen.getByRole('dialog', { name: 'More' }));
  expect(dialog.getByRole('link', { name: 'Inventory' })).toHaveAttribute('aria-current', 'page');
  fireEvent.click(dialog.getByRole('link', { name: 'Attendance' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '/attendance' })).toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('cancel restores the trigger focus and the previous scroll behavior', () => {
  setup();
  const trigger = screen.getByRole('button', { name: 'More' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true, bubbles: true }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe('');
});

test('resizing to desktop dismisses More and releases the scroll lock', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  act(() => { desktop.matches = true; desktop.dispatchEvent(new Event('change')); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.style.overflow).toBe('');
});

test('mobile password action reuses the existing changePassword flow', async () => {
  const state = setup();
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change password' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Account settings' }));
  fireEvent.change(dialog.getByLabelText('Current password'), { target: { value: 'Synthetic current password' } });
  fireEvent.change(dialog.getByLabelText('New password', { exact: true }), { target: { value: 'Synthetic new password' } });
  fireEvent.change(dialog.getByLabelText('Confirm new password'), { target: { value: 'Synthetic new password' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save password' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(state.changePassword).toHaveBeenCalledWith('Synthetic current password', 'Synthetic new password');
  expect(state.signOut).not.toHaveBeenCalled();
});

test('a failed sign-out remains actionable and reports the error inside More', async () => {
  const signOut = vi.fn().mockRejectedValue(new Error('Disconnected'));
  setup('/dashboard', 'admin', { signOut });
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Sign out' }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('Could not sign out.');
  expect(dialog.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  expect(signOut).toHaveBeenCalledOnce();
});
