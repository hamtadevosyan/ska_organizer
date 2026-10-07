import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { ActivityReuse } from './ActivityReuse';
import { ActivityMove } from './ActivityMove';
import { PlanActionPreview } from './PlanActionPreview';
import { activityPlanUrl, weekDates } from '../../api/activities';
import type { Activity, ActivityPlan, Entry, MaterialCheck } from '../../api/activities';
import type { Room } from '../../api/rooms';

vi.mock('axios');
const week = '2026-10-05';
const room: Room = { id: 'room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12,
  active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const art: Activity = { id: 'art', name: 'Paint leaves', description: 'Keep the saved instructions.', durationMinutes: 20,
  ageMinMonths: 18, ageMaxMonths: 72, roomId: null, materials: [], version: 1 };
const music: Activity = { ...art, id: 'music', name: 'Sing together' };
const saved = (values: Partial<Entry> = {}): Entry => ({ id: 'saved-art', date: week, startTime: '09:00', endTime: '09:20',
  timeBlock: null, activityId: art.id, activity: art, useLatest: false, ...values });
const plan = (entries: Entry[] = [], values: Partial<ActivityPlan> = {}): ActivityPlan => ({ roomId: room.id,
  weekStart: week, version: 3, savedAt: '2026-10-01T12:00:00Z', entries, materials: [], ...values });
const response = <T,>(data: T) => ({ data: { data } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function reuseProps(extra: Partial<Parameters<typeof ActivityReuse>[0]> = {}) {
  return { scope: 'day' as const, destination: plan(), entries: [], room, rooms: [room], catalog: [art, music],
    initialDate: week, onApply: vi.fn(), onCancel: vi.fn(), ...extra };
}
const previewButton = () => screen.getByRole('button', { name: 'Preview copy' });
const applyCopy = () => screen.getByRole('button', { name: 'Add copy to draft' });
const includeArt = () => screen.getByRole('checkbox', { name: /^Include Paint leaves / });
const includeMusic = () => screen.getByRole('checkbox', { name: /^Include Sing together / });

beforeEach(() => {
  vi.resetAllMocks();
  // jsdom has no native modal implementation. Keep real dialog markup and its
  // effects, including close/cancel controls, accessible to these UI tests.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  vi.mocked(axios.get).mockResolvedValue(response(plan([saved()])));
  vi.mocked(axios.post).mockResolvedValue(response({ materials: [] }));
});

test('source load failure can be retried without writing or applying anything', async () => {
  vi.mocked(axios.get).mockRejectedValueOnce(new Error('Synthetic source outage'));
  const callbacks = reuseProps(); render(<ActivityReuse {...callbacks} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the saved source week.');
  expect(screen.queryByRole('button', { name: 'Preview copy' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled(); expect(callbacks.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload source week' }));
  await screen.findByRole('checkbox', { name: /^Include Paint leaves / });
  expect(axios.get).toHaveBeenCalledTimes(2);
  expect(previewButton()).toBeEnabled(); expect(includeArt()).toBeChecked();
  expect(callbacks.onApply).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});

test('changing source week ignores an older response even when its request resolves after the new source', async () => {
  const old = deferred<ReturnType<typeof response<ActivityPlan>>>();
  const next = deferred<ReturnType<typeof response<ActivityPlan>>>();
  vi.mocked(axios.get).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const callbacks = reuseProps({ scope: 'week' }); render(<ActivityReuse {...callbacks} />);
  expect(screen.getByLabelText('Source week starting Monday')).toHaveValue('2026-09-28');
  fireEvent.change(screen.getByLabelText('Source week starting Monday'), { target: { value: '2026-09-21' } });
  await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
  const oldSignal = vi.mocked(axios.get).mock.calls[0][1]?.signal;
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => next.resolve(response(plan([saved({ id: 'new-source', date: '2026-09-21', activityId: music.id, activity: music })],
    { weekStart: '2026-09-21', version: 4 }))));
  expect(includeMusic()).toBeChecked();
  await act(async () => old.resolve(response(plan([saved({ date: '2026-09-28' })], { weekStart: '2026-09-28' }))));
  expect(includeMusic()).toBeChecked();
  expect(screen.queryByRole('checkbox', { name: /^Include Paint leaves / })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Source week starting Monday')).toHaveValue('2026-09-21');
  expect(callbacks.onApply).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});

test('a source-version conflict blocks applying the copy and preserves source selections', async () => {
  vi.mocked(axios.get).mockResolvedValue(response(plan([saved(), saved({ id: 'saved-music', activityId: music.id, activity: music })])));
  vi.mocked(axios.isAxiosError).mockReturnValue(true);
  vi.mocked(axios.post).mockRejectedValue({ response: { status: 409,
    data: { error: { message: 'The saved source week changed. Reload it before copying.' } } } });
  const callbacks = reuseProps(); render(<ActivityReuse {...callbacks} />);
  await screen.findByRole('checkbox', { name: /^Include Sing together / });
  fireEvent.click(includeMusic());
  fireEvent.click(previewButton());
  expect(await screen.findByRole('alert')).toHaveTextContent('The saved source week changed.');
  expect(applyCopy()).toBeDisabled(); expect(includeArt()).toBeChecked(); expect(includeMusic()).not.toBeChecked();
  expect(screen.getByLabelText('Source week starting Monday')).toHaveValue(week);
  fireEvent.click(applyCopy());
  expect(callbacks.onApply).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(axios.post).mock.calls[0][0]).toBe(activityPlanUrl + '/preview');
});

test('an unsuitable current activity blocks copying until excluded or replaced with a suitable choice', async () => {
  const currentArt = { ...art, ageMinMonths: 48, version: 2 };
  const source = plan([saved(), saved({ id: 'saved-music', activityId: music.id, activity: music })]);
  vi.mocked(axios.get).mockResolvedValue(response(source));
  const callbacks = reuseProps({ catalog: [currentArt, music] }); render(<ActivityReuse {...callbacks} />);
  await screen.findByRole('checkbox', { name: /^Include Paint leaves / });
  expect(screen.getByRole('alert')).toHaveTextContent('Resolve the flagged activities');
  expect(previewButton()).toBeDisabled();
  fireEvent.click(includeArt());
  expect(previewButton()).toBeEnabled();
  fireEvent.click(includeArt());
  expect(previewButton()).toBeDisabled();
  expect(screen.getByLabelText('Replacement for activity 1')).not.toContainHTML('Paint leaves (current library version)');
  fireEvent.change(screen.getByLabelText('Replacement for activity 1'), { target: { value: music.id } });
  expect(previewButton()).toBeEnabled();
  fireEvent.click(previewButton());
  await waitFor(() => expect(applyCopy()).toBeEnabled());
  const payload = vi.mocked(axios.post).mock.calls[0][1] as { entries: Entry[] };
  expect(payload.entries).toHaveLength(2);
  const replacement = payload.entries.find(row => row.useLatest);
  expect(replacement).toMatchObject({ activityId: music.id, useLatest: true });
  expect(replacement?.copyFrom).toBeUndefined();
  expect(payload.entries.find(row => !row.useLatest)).toMatchObject({ activityId: music.id, useLatest: false,
    copyFrom: { roomId: room.id, weekStart: week, version: source.version, entryId: 'saved-music' } });
  fireEvent.click(applyCopy());
  expect(callbacks.onApply).toHaveBeenCalledOnce();
  const applied: Entry[] = vi.mocked(callbacks.onApply).mock.calls[0][0];
  expect(applied.find(row => row.useLatest)?.activity).toBe(music);
  expect(source.entries[0].activity).toBe(art);
  expect(vi.mocked(axios.post).mock.calls.every(([url]) => url.endsWith('/preview'))).toBe(true);
});

test('replacement requires confirmation and Cancel writes no changes even after confirmation', async () => {
  const destinationEntry = saved({ id: 'destination-art' });
  const untouched = saved({ id: 'other-day', date: '2026-10-06' });
  const destination = plan([destinationEntry, untouched]);
  const callbacks = reuseProps({ destination, entries: destination.entries }); render(<ActivityReuse {...callbacks} />);
  await screen.findByRole('checkbox', { name: /^Include Paint leaves / });
  fireEvent.click(screen.getByRole('radio', { name: 'Replace activities on copied days' }));
  fireEvent.click(previewButton());
  await screen.findByText('No materials listed for this week.');
  expect(applyCopy()).toBeDisabled();
  const confirm = screen.getByRole('checkbox', { name: 'I confirm replacing 1 existing activities on these dates.' });
  fireEvent.click(confirm);
  expect(applyCopy()).toBeEnabled();
  const payload = vi.mocked(axios.post).mock.calls[0][1] as { entries: Entry[] };
  expect(payload.entries.map(row => row.id)).not.toContain(destinationEntry.id);
  expect(payload.entries.map(row => row.id)).toContain(untouched.id);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(callbacks.onCancel).toHaveBeenCalledOnce(); expect(callbacks.onApply).not.toHaveBeenCalled();
  expect(destination.entries).toEqual([destinationEntry, untouched]);
  expect(vi.mocked(axios.post).mock.calls.every(([url]) => url.endsWith('/preview'))).toBe(true);
  expect(axios.put).not.toHaveBeenCalled(); expect(axios.delete).not.toHaveBeenCalled();
});

test('material retry hides the previous stock and keeps Apply disabled through pending and failed checks', async () => {
  const pending = deferred<ReturnType<typeof response<{ materials: MaterialCheck[] }>>>();
  const stock: MaterialCheck = { itemId: 'paper', name: 'Colored paper', location: 'Art shelf', unit: 'count',
    needed: '5', available: '12', shortage: '0', issue: null };
  vi.mocked(axios.post).mockResolvedValueOnce(response({ materials: [stock] })).mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(response({ materials: [{ ...stock, available: '2', shortage: '3' }] }));
  const onApply = vi.fn(); render(<PlanActionPreview plan={plan()} entries={[saved()]} actionLabel="Apply tested change" onApply={onApply} />);
  const apply = screen.getByRole('button', { name: 'Apply tested change' });
  await screen.findByText('Needed: 5 items · Available: 12 items');
  expect(apply).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check preview again' }));
  expect(screen.queryByText('Needed: 5 items · Available: 12 items')).not.toBeInTheDocument();
  expect(screen.queryByText('Ready', { exact: true })).not.toBeInTheDocument();
  expect(apply).toBeDisabled();
  fireEvent.click(apply); expect(onApply).not.toHaveBeenCalled();
  await act(async () => pending.reject(new Error('Synthetic stock outage')));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not check this change.');
  expect(apply).toBeDisabled(); expect(screen.queryByText('Colored paper')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check preview again' }));
  await screen.findByText('Needed: 5 items · Available: 2 items');
  expect(screen.getByText('To get: 3 items')).toBeInTheDocument();
  expect(apply).toBeEnabled();
  fireEvent.click(apply); expect(onApply).toHaveBeenCalledOnce();
});

test('moving to a different day ignores a stale stock preview and Cancel keeps the original entry unchanged', async () => {
  const old = deferred<ReturnType<typeof response<{ materials: MaterialCheck[] }>>>();
  const next = deferred<ReturnType<typeof response<{ materials: MaterialCheck[] }>>>();
  vi.mocked(axios.post).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const entry = saved({ copyFrom: { roomId: 'source', weekStart: '2026-09-28', version: 2, entryId: 'source-art' } });
  const onApply = vi.fn(); const onCancel = vi.fn();
  render(<ActivityMove plan={plan([entry])} entry={entry} entries={[entry]} dates={weekDates(week)} roomName={room.name}
    onApply={onApply} onCancel={onCancel} />);
  const apply = screen.getByRole('button', { name: 'Move in draft' });
  expect(screen.getByLabelText('Destination day')).toHaveValue('2026-10-06');
  fireEvent.change(screen.getByLabelText('Destination day'), { target: { value: '2026-10-07' } });
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(axios.post).mock.calls[0][2]?.signal?.aborted).toBe(true);
  await act(async () => old.resolve(response({ materials: [] })));
  expect(apply).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Checking current stock');
  await act(async () => next.resolve(response({ materials: [] })));
  expect(apply).toBeEnabled();
  const payload = vi.mocked(axios.post).mock.calls[1][1] as { entries: Entry[] };
  expect(payload.entries).toEqual([expect.objectContaining({ id: entry.id, date: '2026-10-07', startTime: entry.startTime,
    endTime: entry.endTime, copyFrom: entry.copyFrom, useLatest: false })]);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledOnce(); expect(onApply).not.toHaveBeenCalled();
  expect(entry.date).toBe(week); expect(entry.activity).toBe(art);
  expect(vi.mocked(axios.post).mock.calls.every(([url]) => url.endsWith('/preview'))).toBe(true);
});

test('moving back to the current day cannot apply even after a successful material check', async () => {
  const entry = saved(); const onApply = vi.fn();
  render(<ActivityMove plan={plan([entry])} entry={entry} entries={[entry]} dates={weekDates(week)} roomName={room.name}
    onApply={onApply} onCancel={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Move in draft' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Destination day'), { target: { value: week } });
  await screen.findByText('No materials listed for this week.');
  const apply = screen.getByRole('button', { name: 'Move in draft' });
  expect(apply).toBeDisabled();
  fireEvent.click(apply); expect(onApply).not.toHaveBeenCalled();
});
