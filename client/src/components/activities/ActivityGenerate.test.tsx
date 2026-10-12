import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { ActivityGenerate } from './ActivityGenerate';
import type { Activity, ActivityGeneration, ActivityPlan, Entry, GenerationSlot } from '../../api/activities';
import type { Room } from '../../api/rooms';

vi.mock('axios');
const room: Room = { id: 'sunflower', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12,
  active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const art: Activity = { id: 'art', name: 'Leaf painting', description: 'Paint with leaves.', durationMinutes: 20,
  ageMinMonths: 18, ageMaxMonths: 72, roomId: null, materials: [], version: 2 };
const music: Activity = { ...art, id: 'music', name: 'Music circle', durationMinutes: 25, ageMinMonths: null, ageMaxMonths: null };
const week = '2026-10-12';
const entry = (extra: Partial<Entry> = {}): Entry => ({ id: 'kept', date: week, startTime: '08:00', endTime: '08:20', timeBlock: null,
  activityId: art.id, activity: art, useLatest: false, ...extra });
const plan: ActivityPlan = { roomId: room.id, weekStart: week, version: 3, savedAt: '2026-10-10T12:00:00Z', entries: [], materials: [] };
const response = <T,>(data: T) => ({ data: { data } });
const resolved = (value: Entry) => ({ ...value, activity: value.activity || (value.activityId === music.id ? music : art) });
type Request = { roomId: string; weekStart: string; version: number; entries: Entry[]; slots: GenerationSlot[];
  replaceEntryIds: string[]; allowRepeats: boolean; excludeActivityIds: string[] };
function result(slots: GenerationSlot[], extra: Partial<ActivityGeneration> = {}): ActivityGeneration {
  const entries = slots.map((slot, index) => entry({ id: 'generated-' + index, date: slot.date, startTime: slot.startTime,
    endTime: slot.startTime.slice(0, 3) + '20', useLatest: true }));
  return { entries, generatedIds: entries.map(value => value.id), generatedSlots: slots.map((slot, index) => ({ slotId: slot.id, entryId: entries[index].id })),
    unfilledSlots: [], materials: [], warnings: [], ...extra };
}
function props(extra: Partial<Parameters<typeof ActivityGenerate>[0]> = {}) {
  return { plan, entries: [], room, catalog: [art, music], onApply: vi.fn(), onCancel: vi.fn(), onDirtyChange: vi.fn(), ...extra };
}
function request(index = 0): Request { return vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/generate'))[index][1] as Request; }
const generate = () => fireEvent.click(screen.getByRole('button', { name: 'Preview generated week' }));
const apply = () => screen.getByRole('button', { name: 'Use generated plan' });
async function ready() { await waitFor(() => expect(apply()).toBeEnabled()); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.setAttribute('open', ''); } },
    close: { configurable: true, value() { this.removeAttribute('open'); } },
  });
  vi.mocked(axios.post).mockImplementation(async (url, data) => {
    if (!url.endsWith('/generate')) return response({ materials: [] });
    const values = data as Request;
    return response(result(values.slots, { entries: [...values.entries.filter(value => !values.replaceEntryIds.includes(value.id)).map(resolved), ...result(values.slots).entries] }));
  });
});

test('week generation keeps the existing draft, accepts all ages and applies only after review', async () => {
  const existing = entry({ useLatest: true, copyFrom: { roomId: room.id, weekStart: '2026-10-05', version: 2, entryId: 'source' } });
  const callbacks = props({ entries: [existing], catalog: [{ ...art, ageMinMonths: null, ageMaxMonths: null }] }); render(<ActivityGenerate {...callbacks} />);
  expect(screen.getByRole('checkbox', { name: 'Plan Monday' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Plan Saturday' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Allow repeated activities when needed' })).not.toBeChecked();
  generate(); await ready();
  expect(request()).toMatchObject({ roomId: room.id, weekStart: week, version: 3, replaceEntryIds: [], allowRepeats: false });
  expect(request().slots).toHaveLength(5);
  expect(request().slots[0]).toMatchObject({ date: week, startTime: '09:00', endTime: '09:30' });
  expect(request().entries[0]).toMatchObject({ id: existing.id, useLatest: true, activityVersion: 2, copyFrom: existing.copyFrom });
  expect(callbacks.onApply).not.toHaveBeenCalled();
  expect(screen.getByText(/Existing activities stay in your week/)).toBeInTheDocument();
  fireEvent.click(apply());
  expect(callbacks.onApply).toHaveBeenCalledOnce();
  expect(vi.mocked(callbacks.onApply).mock.calls[0][0].some((value: Entry) => value.id === existing.id)).toBe(true);
  expect(vi.mocked(axios.post).mock.calls.every(([url]) => url.endsWith('/generate') || url.endsWith('/preview'))).toBe(true);
  expect(axios.put).not.toHaveBeenCalled(); expect(axios.delete).not.toHaveBeenCalled();
});

test('working days and multiple windows are explicit and invalid windows cannot generate', async () => {
  const callbacks = props(); render(<ActivityGenerate {...callbacks} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Plan Tuesday' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Plan Saturday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add time window' }));
  fireEvent.change(screen.getByLabelText('Window 2 finish by'), { target: { value: '09:00' } });
  expect(screen.getByRole('button', { name: 'Preview generated week' })).toBeDisabled();
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Window 2 finish by'), { target: { value: '10:45' } });
  generate(); await ready();
  expect(request().slots).toHaveLength(10);
  expect(request().slots.some(slot => slot.date === '2026-10-13')).toBe(false);
  expect(request().slots.some(slot => slot.date === '2026-10-17')).toBe(true);
  expect(request().slots.some(slot => slot.startTime === '10:00' && slot.endTime === '10:45')).toBe(true);
  expect(callbacks.onDirtyChange).toHaveBeenLastCalledWith(true);
});

test('empty or unsuitable library provides setup guidance without a generation request', () => {
  render(<ActivityGenerate {...props({ catalog: [{ ...art, ageMinMonths: 48 }, { ...music, durationMinutes: null }] })} />);
  expect(screen.getByRole('button', { name: 'Preview generated week' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('No activities are ready');
  expect(axios.post).not.toHaveBeenCalled();
});

test('replacing existing activities requires consent before preview and names only actual replacements', async () => {
  const existing = entry(); const callbacks = props({ entries: [existing] }); render(<ActivityGenerate {...callbacks} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Replace existing activity 1' }));
  expect(screen.getByRole('button', { name: 'Preview generated week' })).toBeDisabled();
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I agree to replace the 1/ })); generate(); await ready();
  expect(request().replaceEntryIds).toEqual([existing.id]);
  expect(screen.getByText(/1 selected existing activities will be replaced/)).toBeInTheDocument();
  expect(callbacks.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(callbacks.onCancel).toHaveBeenCalledOnce(); expect(callbacks.onApply).not.toHaveBeenCalled();
  expect(existing.id).toBe('kept');
});

test('insufficient replacement suggestions keep restored routines and show the authoritative preview', async () => {
  const existing = entry();
  vi.mocked(axios.post).mockImplementation(async (url, data) => url.endsWith('/generate') ? response(result((data as Request).slots.slice(0, 1), {
    entries: [existing, ...result((data as Request).slots.slice(0, 1)).entries],
    unfilledSlots: [{ ...(data as Request).slots[1], reason: 'Not enough different activities. Existing activities kept.' }],
    warnings: ['Selected existing activities were kept because a slot could not be filled.'],
  })) : response({ materials: [] }));
  const callbacks = props({ entries: [existing] }); render(<ActivityGenerate {...callbacks} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Replace existing activity 1' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /I agree to replace/ })); generate(); await ready();
  expect(screen.getByText(/Existing activities stay in your week/)).toBeInTheDocument();
  expect(screen.queryByText(/1 selected existing activities will be replaced/)).not.toBeInTheDocument();
  fireEvent.click(apply()); expect(vi.mocked(callbacks.onApply).mock.calls[0][0]).toContainEqual(existing);
});

test('preview edits are sent through material validation and selected retry preserves edits and original window room', async () => {
  render(<ActivityGenerate {...props()} />); generate(); await ready();
  fireEvent.change(screen.getByLabelText('Suggested activity 1'), { target: { value: music.id } });
  fireEvent.change(screen.getByLabelText('Suggested start 1'), { target: { value: '10:00' } });
  await ready();
  const latestPreview = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/preview')).at(-1)![1] as { entries: Entry[] };
  expect(latestPreview.entries[0]).toMatchObject({ activityId: music.id, activityVersion: 2, startTime: '10:00', endTime: '10:25', useLatest: true });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Try another activity for suggestion 2' }));
  vi.mocked(axios.post).mockImplementation(async (url, data) => {
    if (!url.endsWith('/generate')) return response({ materials: [] });
    const values = data as Request;
    const selected = values.replaceEntryIds[0];
    const replacement = entry({ id: 'alternate', date: values.slots[0].date, startTime: '09:00', endTime: '09:25', activityId: music.id, activity: music, useLatest: true });
    return response({ entries: [...values.entries.filter(value => value.id !== selected).map(resolved), replacement], generatedIds: [replacement.id],
      generatedSlots: [{ slotId: values.slots[0].id, entryId: replacement.id }], unfilledSlots: [], materials: [], warnings: [] });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate selected slots' })); await ready();
  expect(request(1).slots).toHaveLength(1);
  expect(request(1).slots[0]).toMatchObject({ date: '2026-10-13', startTime: '09:00', endTime: '09:30' });
  expect(request(1).replaceEntryIds).toEqual(['generated-1']);
  expect(request(1).excludeActivityIds).toEqual([art.id]);
  expect(request(1).entries.find(value => value.id === 'generated-0')).toMatchObject({ activityId: music.id, startTime: '10:00', endTime: '10:25' });
  expect(screen.getByLabelText('Suggested activity 1')).toHaveValue(music.id);
  expect(screen.getByLabelText('Suggested start 1')).toHaveValue('10:00');
});

test('retrying only unfilled slots retains successful suggestions and explicitly permits repeats', async () => {
  vi.mocked(axios.post).mockImplementation(async (url, data) => {
    if (!url.endsWith('/generate')) return response({ materials: [] });
    const values = data as Request;
    return response(result(values.slots.slice(0, 1), { unfilledSlots: values.slots.slice(1).map(slot => ({ ...slot, reason: 'Not enough different activities.' })) }));
  });
  render(<ActivityGenerate {...props()} />); generate(); await ready();
  expect(screen.getByRole('checkbox', { name: 'Retry Tuesday at 09:00' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Allow repeated activities when needed' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Retry Friday at 09:00' }));
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate selected slots' }));
  await waitFor(() => expect(vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/generate'))).toHaveLength(2));
  expect(request(1).allowRepeats).toBe(true); expect(request(1).slots).toHaveLength(3);
  expect(request(1).entries).toHaveLength(1); expect(request(1).replaceEntryIds).toEqual([]);
});

test('regenerating repeated suggestions sends each excluded activity only once', async () => {
  render(<ActivityGenerate {...props()} />); generate(); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Allow repeated activities when needed' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Try another activity for suggestion 1' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Try another activity for suggestion 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate selected slots' }));
  await waitFor(() => expect(vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/generate'))).toHaveLength(2));
  expect(request(1).slots).toHaveLength(2); expect(request(1).replaceEntryIds).toHaveLength(2);
  expect(request(1).excludeActivityIds).toEqual([art.id]);
});

test('failure and retry preserve settings and an existing draft', async () => {
  const existing = entry(); const callbacks = props({ entries: [existing] });
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Synthetic outage'));
  render(<ActivityGenerate {...callbacks} />);
  fireEvent.change(screen.getByLabelText('Window 1 start'), { target: { value: '09:05' } }); generate();
  expect(await screen.findByRole('alert')).toHaveTextContent('Your week is unchanged');
  expect(screen.getByLabelText('Window 1 start')).toHaveValue('09:05'); expect(callbacks.onApply).not.toHaveBeenCalled();
  generate(); await ready(); expect(request(1).entries[0].id).toBe(existing.id);
});

test('stopping or canceling a request aborts it and ignores late responses', async () => {
  const pending = deferred<ReturnType<typeof response<ActivityGeneration>>>();
  vi.mocked(axios.post).mockReturnValueOnce(pending.promise); const callbacks = props(); const view = render(<ActivityGenerate {...callbacks} />); generate();
  const signal = vi.mocked(axios.post).mock.calls[0][2]?.signal;
  expect(screen.getByRole('button', { name: 'Stop generation' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' })); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(response(result(request().slots))));
  expect(screen.queryByRole('region', { name: 'Generated week preview' })).not.toBeInTheDocument();
  expect(callbacks.onApply).not.toHaveBeenCalled();
  const next = deferred<ReturnType<typeof response<ActivityGeneration>>>(); vi.mocked(axios.post).mockReturnValueOnce(next.promise);
  generate(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(vi.mocked(axios.post).mock.calls[1][2]?.signal?.aborted).toBe(true); view.unmount();
  await act(async () => next.resolve(response(result(request(1).slots))));
  expect(callbacks.onCancel).toHaveBeenCalledOnce(); expect(callbacks.onApply).not.toHaveBeenCalled();
});

test('catalog changes cancel pending work and require a fresh generation context', async () => {
  const pending = deferred<ReturnType<typeof response<ActivityGeneration>>>(); vi.mocked(axios.post).mockReturnValueOnce(pending.promise);
  const callbacks = props(); const view = render(<ActivityGenerate {...callbacks} />); generate();
  view.rerender(<ActivityGenerate {...callbacks} catalog={[{ ...art, version: 4 }, music]} />);
  expect(vi.mocked(axios.post).mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(screen.getByRole('alert')).toHaveTextContent('activity library changed');
  await act(async () => pending.resolve(response(result(request().slots))));
  expect(screen.queryByRole('region', { name: 'Generated week preview' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview generated week' })).toBeDisabled();
});

test('invalid preview times block applying and validation conflicts preserve the editable preview', async () => {
  const callbacks = props(); render(<ActivityGenerate {...callbacks} />); generate(); await ready();
  fireEvent.change(screen.getByLabelText('Suggested end 1'), { target: { value: '08:00' } });
  expect(screen.queryByRole('button', { name: 'Use generated plan' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Suggested end 1')).toHaveAttribute('aria-invalid', 'true');
  vi.mocked(axios.isAxiosError).mockReturnValue(true);
  vi.mocked(axios.post).mockRejectedValue({ response: { status: 409, data: { error: { message: 'This week changed. Reload the week.' } } } });
  fireEvent.change(screen.getByLabelText('Suggested end 1'), { target: { value: '09:20' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('This week changed');
  expect(apply()).toBeDisabled(); expect(screen.getByLabelText('Suggested activity 1')).toHaveValue(art.id);
  expect(callbacks.onApply).not.toHaveBeenCalled();
});
