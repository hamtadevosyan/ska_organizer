import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { useActivityPlanner } from './useActivityPlanner';
import { orderedEntries } from '../../api/activities';
import type { Activity, ActivityPlan, Entry } from '../../api/activities';

vi.mock('axios');
const week = '2030-01-07';
const art: Activity = { id: 'saved-art', name: 'Original tree activity', description: 'Original instructions.', durationMinutes: 20,
  ageMinMonths: 18, ageMaxMonths: 72, materials: [], roomId: null, version: 1 };
const latest: Activity = { ...art, name: 'Updated tree activity', description: 'Updated instructions.', version: 2 };
const entry = (values: Partial<Entry> = {}): Entry => ({ id: 'saved-entry', date: week, startTime: '08:00', endTime: '08:20',
  timeBlock: null, activityId: art.id, activity: art, useLatest: false, ...values });
let original: Entry[];
let catalog: Activity[];
const response = (data: unknown) => ({ data: { data } });

beforeEach(() => {
  vi.resetAllMocks();
  original = []; catalog = [latest];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/activity')) return response(catalog);
    const { roomId, weekStart } = config!.params;
    return response({ roomId, weekStart, version: 3, savedAt: '2029-12-31T12:00:00Z', materials: [],
      entries: roomId === 'selected-room' && weekStart === week ? original : [] });
  });
  vi.mocked(axios.post).mockImplementation(async (url, payload) => {
    if (url.endsWith('/preview')) return response({ materials: [] });
    const values = payload as ActivityPlan;
    return response({ ...values, version: values.version + 1, savedAt: '2030-01-01T12:00:00Z', materials: [],
      entries: values.entries.map(row => ({ ...row, useLatest: false,
        activity: (!row.useLatest && original.find(saved => saved.id === row.id && saved.activityId === row.activityId)?.activity)
          || catalog.find(activity => activity.id === row.activityId) })) });
  });
});

async function load(entries: Entry[] = []) {
  original = entries;
  const hook = renderHook(useActivityPlanner);
  act(() => { hook.result.current.chooseWeek(week); hook.result.current.chooseRoom('selected-room'); });
  await waitFor(() => expect(hook.result.current.plan?.roomId).toBe('selected-room'));
  return hook;
}

test('suggested times follow the day while a complete add commits the selected activity and times together', async () => {
  const { result } = await load();
  expect(result.current.suggestedTimes(week)).toEqual({ startTime: '08:00', endTime: '08:20' });
  act(() => result.current.addEntry(week, art, { startTime: '23:30', endTime: '23:50' }));
  expect(result.current.entries).toEqual([expect.objectContaining({ activityId: art.id, activity: art, useLatest: true,
    date: week, startTime: '23:30', endTime: '23:50', timeBlock: null })]);
  expect(result.current.suggestedTimes(week, 30)).toEqual({ startTime: '23:50', endTime: '24:00' });
  act(() => result.current.addEntry(week, art));
  expect(result.current.entries[1]).toMatchObject({ startTime: '23:50', endTime: '24:00' });
  expect(result.current.suggestedTimes(week)).toEqual({ startTime: '08:00', endTime: '08:20' });
  expect(result.current.suggestedTimes('2030-01-08', 45)).toEqual({ startTime: '08:00', endTime: '08:45' });
  expect(result.current.dirty).toBe(true);
});

test.each([false, true, undefined])('a focused same-activity edit preserves its snapshot and useLatest=%s', async (useLatest) => {
  const scheduled = entry({ useLatest });
  const { result } = await load([scheduled]);
  act(() => result.current.updateEntry(scheduled.id, { activity: latest, startTime: '10:00', endTime: '10:45', timeBlock: null }));
  expect(result.current.entries[0]).toEqual({ ...scheduled, startTime: '10:00', endTime: '10:45' });
  expect(result.current.entries[0].activity).toBe(art);
  expect(result.current.entries[0].useLatest).toBe(useLatest);
});

test('choosing a different activity in a focused edit changes its snapshot while retaining entry identity and date', async () => {
  const scheduled = entry({ timeBlock: 'morning', startTime: null, endTime: null });
  const other = { ...latest, id: 'other-activity', name: 'Build with blocks' };
  const { result } = await load([scheduled]);
  act(() => result.current.updateEntry(scheduled.id, { activity: other, startTime: '09:00', endTime: '09:30', timeBlock: null }));
  expect(result.current.entries).toEqual([{ ...scheduled, activityId: other.id, activity: other, useLatest: true,
    startTime: '09:00', endTime: '09:30', timeBlock: null }]);
});

test('removal undo restores the exact timed and legacy entries in reverse removal order', async () => {
  const timed = entry({ useLatest: true });
  const legacy = entry({ id: 'legacy-entry', timeBlock: 'morning', startTime: null, endTime: null, useLatest: undefined });
  const { result } = await load([timed, legacy]);
  act(() => { result.current.removeEntry(timed.id); result.current.removeEntry(legacy.id); });
  expect(result.current.entries).toEqual([]); expect(result.current.removedCount).toBe(2);
  act(() => result.current.undoRemoval());
  expect(result.current.entries).toEqual([legacy]); expect(result.current.removedCount).toBe(1);
  act(() => result.current.undoRemoval());
  expect(result.current.entries).toEqual(orderedEntries([timed, legacy])); expect(result.current.removedCount).toBe(0);
  expect(result.current.entries.find(row => row.id === timed.id)?.activity).toBe(art);
  expect(result.current.dirty).toBe(true);
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
});

test('failed saves retain removal undo and retry identifiers while a successful save clears undo', async () => {
  const first = entry(); const second = entry({ id: 'second-entry', startTime: '09:00', endTime: '09:20' });
  const { result } = await load([first, second]);
  const normal = vi.mocked(axios.post).getMockImplementation()!;
  let fail = true;
  vi.mocked(axios.post).mockImplementation(async (url, payload, config) => {
    if (url.endsWith('/plan') && fail) throw new Error('Synthetic lost response');
    return normal(url, payload, config);
  });
  act(() => result.current.removeEntry(first.id));
  await act(async () => result.current.save());
  expect(result.current.removedCount).toBe(1); expect(result.current.dirty).toBe(true);
  await act(async () => result.current.save());
  const attempts = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/plan'));
  expect(attempts[0][1]).toEqual(attempts[1][1]);
  act(() => result.current.undoRemoval());
  expect(result.current.entries).toEqual(orderedEntries([first, second]));
  act(() => result.current.removeEntry(first.id));
  fail = false;
  await act(async () => result.current.save());
  expect(result.current.removedCount).toBe(0); expect(result.current.dirty).toBe(false);
  act(() => result.current.undoRemoval());
  expect(result.current.entries.map(row => row.id)).toEqual([second.id]);
  expect(result.current.dirty).toBe(false);
});

test.each(['room', 'week', 'reload'])('loading another %s clears removal undo instead of restoring an entry across week context', async (change) => {
  const { result } = await load([entry()]);
  act(() => result.current.removeEntry('saved-entry'));
  expect(result.current.removedCount).toBe(1);
  act(() => {
    if (change === 'room') result.current.chooseRoom('other-room');
    else if (change === 'week') result.current.chooseWeek('2030-01-14');
    else result.current.reloadWeek();
  });
  await waitFor(() => expect(result.current.plan?.roomId).toBe(change === 'room' ? 'other-room' : 'selected-room'));
  expect(result.current.removedCount).toBe(0);
  const loadedIds = result.current.entries.map(row => row.id);
  act(() => result.current.undoRemoval());
  expect(result.current.entries.map(row => row.id)).toEqual(loadedIds);
  expect(result.current.dirty).toBe(false);
});
