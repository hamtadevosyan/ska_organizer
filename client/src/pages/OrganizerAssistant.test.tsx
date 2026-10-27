import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import OrganizerAssistant from './OrganizerAssistant';
import { SignedIn } from '../tests/authFixture';
import { assistantOptions, assistantSummary } from '../api/organizerAssistant';
import type { AssistantSummary } from '../api/organizerAssistant';
const events = vi.hoisted(() => ({ expired: new Set<() => void>(), denied: new Set<() => void>() }));
vi.mock('../api/organizerAssistant', () => ({ assistantOptions: vi.fn(), assistantSummary: vi.fn() }));
vi.mock('../auth/transport', () => ({ authError: (_error: unknown, fallback: string) => fallback,
  onSessionExpired: (cb: () => void) => { events.expired.add(cb); return () => events.expired.delete(cb); },
  onWorkAccessRequired: (cb: () => void) => { events.denied.add(cb); return () => events.denied.delete(cb); } }));
const options = { tasks: ['room', 'attendance', 'inventory', 'week'] as const, rooms: [{ id: 'r1', name: 'Sunshine room' }],
  status: { enabled: true, available: true, model: 'synthetic', sourceCount: 0, message: 'Local AI is ready.' }, today: '2026-10-26', weekStart: '2026-10-26' };
const result = { summary: 'Synthetic room summary.', sources: [{ id: 'room', title: 'Room settings' }], task: 'room' as const,
  takenAt: '2026-10-26T12:00:00Z', warning: 'Check the original records.' };
function view() { return render(<SignedIn><MemoryRouter><OrganizerAssistant /></MemoryRouter></SignedIn>); }
beforeEach(() => { vi.clearAllMocks(); events.expired.clear(); events.denied.clear();
  vi.mocked(assistantOptions).mockResolvedValue({ ...options, tasks: [...options.tasks] }); vi.mocked(assistantSummary).mockResolvedValue(result); });
test('summary uses only explicit selected task and shows plain text with source labels', async () => {
  view(); await screen.findByText('Local AI is ready.'); fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
  await screen.findByText(result.summary);
  expect(assistantSummary).toHaveBeenCalledWith({ task: 'room', roomId: 'r1' }, expect.any(AbortSignal));
  expect(screen.getByText('Room settings')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear summary' })); expect(screen.queryByText(result.summary)).not.toBeInTheDocument();
});
test('unavailable AI leaves normal Organizer navigation available', async () => {
  vi.mocked(assistantOptions).mockResolvedValue({ ...options, tasks: [...options.tasks], status: { ...options.status, available: false, message: 'AI host unavailable.' } });
  view(); await screen.findByText('AI host unavailable.');
  expect(screen.getByRole('button', { name: 'Summarize' })).toBeDisabled(); expect(screen.getByRole('link', { name: 'Back to Organizer' })).toBeInTheDocument();
});
test('task and room changes clear old results and inventory does not send room scope', async () => {
  view(); await screen.findByText('Local AI is ready.'); fireEvent.click(screen.getByRole('button', { name: 'Summarize' })); await screen.findByText(result.summary);
  fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'inventory' } }); expect(screen.queryByText(result.summary)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
  await waitFor(() => expect(assistantSummary).toHaveBeenLastCalledWith({ task: 'inventory' }, expect.any(AbortSignal)));
});
test.each(['expired', 'denied'] as const)('protected results clear on %s event', async kind => {
  view(); await screen.findByText('Local AI is ready.'); fireEvent.click(screen.getByRole('button', { name: 'Summarize' })); await screen.findByText(result.summary);
  act(() => events[kind].forEach(cb => cb())); expect(screen.queryByText(result.summary)).not.toBeInTheDocument(); expect(screen.queryByText('Sunshine room')).not.toBeInTheDocument();
});
test('cancelled and unmounted requests cannot restore an answer', async () => {
  let resolve!: (value: AssistantSummary) => void;
  vi.mocked(assistantSummary).mockReturnValue(new Promise(done => { resolve = done; }));
  const mounted = view(); await screen.findByText('Local AI is ready.'); fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => resolve(result)); expect(screen.queryByText(result.summary)).not.toBeInTheDocument();
  mounted.unmount(); expect(vi.mocked(assistantSummary).mock.calls[0][1].aborted).toBe(true);
});
test('model content is rendered as text and never loads links or images', async () => {
  vi.mocked(assistantSummary).mockResolvedValue({ ...result, summary: '<img src="https://external.invalid">' });
  view(); await screen.findByText('Local AI is ready.'); fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
  await screen.findByText('<img src="https://external.invalid">'); expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('a[href="https://external.invalid"]')).toBeNull();
});
