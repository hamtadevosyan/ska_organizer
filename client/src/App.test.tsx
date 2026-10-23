import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
const mounts = vi.hoisted(() => ({ auth: vi.fn(), gate: vi.fn(), shell: vi.fn(), routes: vi.fn() }));
vi.mock('./auth/AuthProvider', () => ({ default: ({ children }: { children: ReactNode }) => { mounts.auth(); return children; } }));
vi.mock('./auth/AuthGate', () => ({ default: ({ children }: { children: ReactNode }) => { mounts.gate(); return children; } }));
vi.mock('./components/AppShell', () => ({ default: ({ children }: { children: ReactNode }) => { mounts.shell(); return children; } }));
vi.mock('./router', () => ({ default: () => { mounts.routes(); return <p>Private application</p>; } }));
vi.mock('./pwa/PwaProvider', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('./pages/TimeClockStation', () => ({ default: () => <h1>Public staff clock</h1> }));
test('the public clock route never mounts personal authentication, private routes or the application shell', async () => {
  window.history.replaceState({}, '', '/time-clock');
  const { default: App } = await import('./App'); render(<App />);
  expect(screen.getByRole('heading', { name: 'Public staff clock' })).toBeVisible();
  expect(mounts.auth).not.toHaveBeenCalled(); expect(mounts.gate).not.toHaveBeenCalled(); expect(mounts.shell).not.toHaveBeenCalled(); expect(mounts.routes).not.toHaveBeenCalled();
});
