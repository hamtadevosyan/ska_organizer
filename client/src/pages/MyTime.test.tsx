import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import MyTime from './MyTime';
import { AuthContext } from '../auth/context';
import type { Role } from '../auth/context';
import { testAccount } from '../tests/authAccount';

vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });
function view(role: Role, linked: boolean, unavailable = false) {
  return <AuthContext.Provider value={{ account: { ...testAccount, role, staffMemberId: linked ? 'staff-a' : null }, ready: true, notice: '', serverUnavailable: unavailable,
    signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><MemoryRouter><MyTime /></MemoryRouter></AuthContext.Provider>;
}
beforeEach(() => { vi.resetAllMocks(); });

test.each((['admin', 'editor', 'teacher', 'viewer'] as const).flatMap(role => [true, false].map(linked => ({ role, linked }))))(
  'the disabled personal clock makes no time requests for $role (linked: $linked)', ({ role, linked }) => {
    render(view(role, linked));
    expect(screen.getByRole('heading', { name: 'Staff check-in has moved' })).toBeVisible();
    expect(screen.getByText('Use the academy clock station, or ask an administrator or editor to record your arrival or departure.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /check in|check out|refresh my time/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/clocked hours|hourly rate|tax identifier|recent workdays/i)).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: role === 'admin' || role === 'editor' ? 'Open staff clock' : 'Back to my class' });
    expect(link).toHaveAttribute('href', role === 'admin' || role === 'editor' ? '/staff/clock' : '/classroom');
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  },
);

test('focus, elapsed time and connection state cannot revive the disabled personal clock', () => {
  vi.useFakeTimers();
  try {
    const { rerender } = render(view('teacher', true));
    fireEvent(window, new Event('focus'));
    act(() => vi.advanceTimersByTime(60_000));
    rerender(view('teacher', true, true));
    fireEvent(window, new Event('focus'));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole('button', { name: /check in|check out/i })).not.toBeInTheDocument();
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
