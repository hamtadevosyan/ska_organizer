import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { BillingAlerts } from './BillingAlerts';
import { SignedIn } from '../../tests/authFixture';
import { testAccount } from '../../tests/authAccount';
import { BILLING_CHANGED, getBillingAlerts } from '../../api/billing';
import type { BillingAlerts as Alerts } from '../../api/billing';

const events = vi.hoisted(() => ({ expired: new Set<() => void>() }));
vi.mock('../../auth/transport', () => ({ authError: (_failure: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { events.expired.add(callback); return () => events.expired.delete(callback); } }));
vi.mock('../../api/billing', async original => ({ ...await original<typeof import('../../api/billing')>(), getBillingAlerts: vi.fn() }));
const alerts = (): Alerts => ({ today: '2026-10-06', timeZone: 'America/Los_Angeles', count: 1, totalOutstandingCents: 12525, items: [{ id: 'charge:family', childId: 'child/a', childName: 'Maya Example', payer: 'family', chargeId: 'charge', title: 'October tuition', dueDate: '2026-10-01', daysOverdue: 5, outstandingCents: 12525 }] });
function show(role: 'admin' | 'editor' | 'viewer' | 'teacher' = 'admin') { return render(<SignedIn account={{ ...testAccount, role }}><MemoryRouter><BillingAlerts /></MemoryRouter></SignedIn>); }
beforeEach(() => { vi.clearAllMocks(); events.expired.clear(); vi.mocked(getBillingAlerts).mockResolvedValue(alerts()); });
afterEach(() => vi.useRealTimers());

test.each(['editor', 'viewer', 'teacher'] as const)('%s never requests or sees billing reminders', role => {
  show(role); expect(getBillingAlerts).not.toHaveBeenCalled(); expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('without an account provider the dashboard embeds no private financial request', () => {
  render(<MemoryRouter><BillingAlerts /></MemoryRouter>); expect(getBillingAlerts).not.toHaveBeenCalled();
});

test('administrator sees the responsible payer and exact amount, with a link to the correct child', async () => {
  show(); const link = await screen.findByRole('link', { name: 'Maya Example · $125.25' });
  expect(link).toHaveAttribute('href', '/billing?child=child%2Fa');
  expect(screen.getByText('Family · Due 2026-10-01 · 5 days overdue')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review overdue tuition' })).toHaveAttribute('href', '/billing?status=overdue');
  expect(getBillingAlerts).toHaveBeenCalledWith(expect.any(AbortSignal));
});

test('a payment change removes a resolved reminder without keeping a duplicate or stale amount', async () => {
  show(); await screen.findByRole('link', { name: 'Maya Example · $125.25' });
  vi.mocked(getBillingAlerts).mockResolvedValue({ ...alerts(), count: 0, totalOutstandingCents: 0, items: [] });
  fireEvent(window, new Event(BILLING_CHANGED));
  await screen.findByText('No tuition payments are five days overdue.');
  expect(screen.queryByText('Maya Example · $125.25')).not.toBeInTheDocument();
  expect(getBillingAlerts).toHaveBeenCalledTimes(2);
});

test('a failed reminder refresh hides earlier financial amounts and offers a working retry', async () => {
  show(); await screen.findByRole('link', { name: 'Maya Example · $125.25' });
  vi.mocked(getBillingAlerts).mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Check tuition reminders' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not check overdue tuition. Try again.');
  expect(screen.queryByText('Maya Example · $125.25')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check tuition reminders' }));
  await screen.findByRole('link', { name: 'Maya Example · $125.25' });
});

test('the visible-page timer asks the server for the new facility day rather than calculating days in the browser', async () => {
  vi.useFakeTimers();
  await act(async () => { show(); });
  expect(getBillingAlerts).toHaveBeenCalledTimes(1);
  vi.mocked(getBillingAlerts).mockResolvedValue({ ...alerts(), today: '2026-10-07', items: [{ ...alerts().items[0], daysOverdue: 6 }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(getBillingAlerts).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Family · Due 2026-10-01 · 6 days overdue')).toBeVisible();
  expect(screen.getByText(/As of 2026-10-07/)).toBeVisible();
});

test('an expired session aborts pending reminders and cannot restore private content from a delayed response', async () => {
  let finish!: (value: Alerts) => void;
  vi.mocked(getBillingAlerts).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  show(); await waitFor(() => expect(getBillingAlerts).toHaveBeenCalled());
  const signal = vi.mocked(getBillingAlerts).mock.calls[0][0]!;
  act(() => events.expired.forEach(callback => callback()));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(alerts()));
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  fireEvent(window, new Event('focus')); expect(getBillingAlerts).toHaveBeenCalledTimes(1);
});

test('pending monthly charges are visible instead of implying all tuition is settled', async () => {
  vi.mocked(getBillingAlerts).mockResolvedValue({ ...alerts(), pendingMonthlyCharges: 2, items: [], count: 0 });
  show(); await screen.findByText(/Some monthly charges need updating/);
  expect(screen.getByRole('link', { name: 'Open tuition to check charges' })).toHaveAttribute('href', '/billing');
});


test('CCRC review is shown separately from overdue parent amounts while actual receipts are pending', async () => {
  vi.mocked(getBillingAlerts).mockResolvedValue({ ...alerts(), items: [], count: 0, totalOutstandingCents: 0, awaitingCcrcCount: 2, awaitingCcrcCents: 120000 });
  show(); await screen.findByText(/2 service months await CCRC review/);
  expect(screen.getByRole('link', { name: 'Review CCRC payments' })).toHaveAttribute('href', '/billing?status=ccrc');
  expect(screen.getByText('No tuition payments are five days overdue.')).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Review overdue tuition' })).not.toBeInTheDocument();
});
