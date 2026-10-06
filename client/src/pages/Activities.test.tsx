import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';

import { createMemoryRouter, RouterProvider, Link, useLocation } from 'react-router-dom';
import AuthGate from '../auth/AuthGate';
import UnsavedChangesProvider from '../components/UnsavedChangesProvider';
import Activities from './Activities';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { Activity, ActivityPlan, Entry } from '../api/activities';
import type { Room } from '../api/rooms';

const { transferableAbortController } = await vi.importActual<{ transferableAbortController: () => AbortController }>('node:util');
afterEach(() => vi.unstubAllGlobals());
vi.mock('axios');
const room: Room = { id: 'saved-room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const art: Activity = { id: 'saved-art', name: 'Paint a tree', description: 'Paint leaves.', durationMinutes: 20, ageMinMonths: 18, ageMaxMonths: 72, materials: [], roomId: null, version: 1 };
const response = (data: unknown) => ({ data: { data } });
let rooms: Room[];
let activities: Activity[];
let weeks: Map<string, ActivityPlan>;
const base = (roomId: string, weekStart: string): ActivityPlan => ({ roomId, weekStart, version: 0, savedAt: null, entries: [], materials: [] });
async function chooseRoom() {
  await screen.findByRole('option', { name: /^Sunflower/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: room.id } });
  await screen.findByRole('region', { name: 'Monday' });
  await waitFor(() => expect(screen.queryByText('Loading activities…')).not.toBeInTheDocument());
}
function add(day = 'Monday', number = 1, id = art.id) {
  fireEvent.click(screen.getByRole('button', { name: day }));
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  const form = screen.getByRole('form', { name: 'Schedule activity' });
  fireEvent.click(within(form).getByRole('button', { name: 'Choose ' + activities.find((activity) => activity.id === id)!.name }));
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  expect(selected(number, day)).toHaveTextContent(activities.find((activity) => activity.id === id)!.name);
}
const selected = (number = 1, day = 'Monday') => screen.getByRole('group', { name: day + ' activity ' + number });
const start = () => screen.getByLabelText('Start time', { exact: true });
const end = () => screen.getByLabelText('End time', { exact: true });
function edit(number = 1, day = 'Monday') {
  fireEvent.click(screen.getByRole('button', { name: `Edit activity ${number} on ${day}` }));
  return screen.getByRole('form', { name: 'Edit scheduled activity' });
}
function apply() { fireEvent.click(screen.getByRole('button', { name: 'Apply changes' })); }
function openNew(day = 'Monday') {
  fireEvent.click(screen.getByRole('button', { name: day }));
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create an activity' }));
  return screen.getByRole('form', { name: 'New activity' });
}
async function createAndSchedule(form: HTMLElement) {
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity & choose time' }));
  const schedule = await screen.findByRole('form', { name: 'Schedule activity' });
  await waitFor(() => expect(within(schedule).getByRole('button', { name: 'Add to day' })).toBeEnabled());
  fireEvent.click(within(schedule).getByRole('button', { name: 'Add to day' }));
}
function discardComposer(form: HTMLElement) {
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  const prompt = within(form).queryByRole('group', { name: 'Discard scheduled activity changes' });
  if (prompt) fireEvent.click(within(prompt).getByRole('button', { name: 'Discard changes' }));
}
beforeEach(() => {
  vi.resetAllMocks();
  rooms = [room, { ...room, id: 'other-room', name: 'Other room' }]; activities = [{ ...art }]; weeks = new Map();
  vi.spyOn(window, 'confirm').mockReturnValue(true); vi.spyOn(window, 'print').mockImplementation(() => {});
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/rooms')) return response(rooms);
    if (url.endsWith('/activity')) return response(activities);
    if (url.endsWith('/inventory')) return { data: { items: [], total: 0 } };
    const { roomId, weekStart } = config!.params;
    return response(weeks.get(roomId + weekStart) || base(roomId, weekStart));
  });
  vi.mocked(axios.post).mockImplementation(async (url, payload) => {
    if (url.endsWith('/preview')) return response({ materials: [] });
    if (url.endsWith('/activity')) {
      const saved = { ...art, ...payload as object, id: 'new-art' }; activities.push(saved); return response(saved);
    }
    const values = payload as ActivityPlan;
    const previous = weeks.get(values.roomId + values.weekStart);
    const saved: ActivityPlan = { ...values, version: values.version + 1, savedAt: '2026-09-18T00:00:00Z', materials: [],
      entries: values.entries.map((entry) => ({ ...entry, useLatest: false,
        activity: !entry.useLatest && previous?.entries.find((item) => item.id === entry.id && item.activityId === entry.activityId)?.activity || activities.find((item) => item.id === entry.activityId)! })) };
    weeks.set(values.roomId + values.weekStart, saved); return response(saved);
  });
  vi.mocked(axios.put).mockImplementation(async (_url, payload) => {
    const saved = { ...art, ...payload as object, version: 2 }; activities = [saved]; return response(saved);
  });
});

test('plans more than three activities in one day, saves times and IDs, reloads separate weeks and prints every entry', async () => {
  activities.push({ ...art, id: 'older', name: 'Older children activity', ageMinMonths: 72, ageMaxMonths: 120 });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  expect(screen.queryByRole('button', { name: 'Choose Older children activity' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  for (let number = 1; number <= 5; number++) add('Monday', number);
  expect(selected()).toHaveTextContent('08:00–08:20'); expect(selected(5)).toHaveTextContent('09:20–09:40');
  expect(within(selected()).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(selected()).queryByRole('textbox')).not.toBeInTheDocument();
  const week = (screen.getByLabelText('Week starting Monday') as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const calls = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/plan'));
  const saved = calls[0][1] as ActivityPlan;
  expect(saved.entries).toHaveLength(5); expect(new Set(saved.entries.map((entry) => entry.id)).size).toBe(5);
  expect(saved.entries[4]).toMatchObject({ date: week, startTime: '09:20', endTime: '09:40', activityId: art.id, activityVersion: 1 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'other-room' } });
  await screen.findByText('Nothing scheduled for this day.');
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: room.id } });
  await waitFor(() => expect(selected(5)).toHaveTextContent('Paint a tree'));
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: '2030-01-07' } });
  await screen.findByText('Nothing scheduled for this day.');
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: week } });
  await waitFor(() => expect(selected(5)).toHaveTextContent('09:20–09:40'));
  fireEvent.click(screen.getByRole('button', { name: 'Print' })); expect(window.print).toHaveBeenCalledTimes(1);
  const printed = document.querySelector('.activity-print table')!;
  expect(printed).toHaveTextContent('09:20–09:40'); expect(within(printed as HTMLElement).getAllByText('Paint a tree')).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: 'Remove activity 3 on Monday' }));
  expect(screen.queryByRole('group', { name: 'Monday activity 5' })).not.toBeInTheDocument();
  expect(screen.getByText('Unsaved changes', { exact: true })).toBeInTheDocument();
});

test('times are editable, can reach midnight, and incomplete or reversed times cannot be scheduled', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  const form = screen.getByRole('form', { name: 'Schedule activity' });
  expect(screen.getByRole('button', { name: 'Save week' })).toBeDisabled();
  fireEvent.click(within(form).getByRole('button', { name: 'Choose Paint a tree' }));
  fireEvent.change(start(), { target: { value: '07:00' } }); expect(end()).toHaveValue('07:20');
  fireEvent.change(end(), { target: { value: '06:00' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  expect(within(form).getByText('End time must be after start time.', { exact: true })).toBeInTheDocument();
  expect(end()).toHaveAttribute('aria-invalid', 'true');
  expect(end()).toHaveAccessibleDescription('End time must be after start time.');
  expect(screen.queryByRole('group', { name: 'Monday activity 1' })).not.toBeInTheDocument();
  fireEvent.change(end(), { target: { value: '00:00' } });
  expect(end()).toHaveValue('00:00');
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ startTime: '07:00', endTime: '24:00' })] }));
  add('Sunday'); expect(selected(1, 'Sunday')).toHaveTextContent('Paint a tree');
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(selected()).toHaveTextContent('07:00–midnight');
});

test('an empty catalog can create an activity, validates ages and schedules only after time confirmation', async () => {
  activities = [];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  expect(screen.getByRole('button', { name: 'Add activity' })).toBeEnabled();
  const form = openNew();
  expect(within(form).getByLabelText('Minimum age (months)')).not.toBeVisible();
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Play with shapes' } });
  fireEvent.click(within(form).getByText('More details')); form.querySelector('details')!.open = true;
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minimum age (months)' }), { target: { value: '0' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '0' } });
  fireEvent.click(within(form).getByText('More details')); form.querySelector('details')!.open = false;
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity & choose time' }));
  await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('Enter both ages in months'));
  expect(within(form).getByLabelText('Maximum age (months)')).toBeVisible();
  expect(within(form).getByRole('alert')).toHaveFocus();
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '72' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity & choose time' }));
  await screen.findByText('Activity saved to the library. Save week separately to keep schedule changes.');
  expect(screen.queryByRole('group', { name: 'Monday activity 1' })).not.toBeInTheDocument();
  expect(screen.queryByText('Unsaved changes', { exact: true })).not.toBeInTheDocument();
  const schedule = screen.getByRole('form', { name: 'Schedule activity' });
  expect(schedule).toHaveTextContent('Play with shapes'); expect(start()).toHaveValue('08:00'); expect(end()).toHaveValue('08:20');
  fireEvent.click(within(schedule).getByRole('button', { name: 'Add to day' }));
  expect(selected()).toHaveTextContent('Play with shapes'); expect(selected()).toHaveTextContent('08:00–08:20');
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ activityId: 'new-art', startTime: '08:00', endTime: '08:20' })] }));
});

test('declining a room change retains the draft and a failed save retries the same request identifier', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'other-room' } });
  expect(screen.getByRole('combobox', { name: 'Room' })).toHaveValue(room.id);
  const normal = vi.mocked(axios.post).getMockImplementation()!; let fail = true;
  vi.mocked(axios.post).mockImplementation(async (url, payload, config) => {
    if (url.endsWith('/plan') && fail) { fail = false; throw new Error('Lost response'); }
    return normal(url, payload, config);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText(/Could not save the week/);
  expect(selected()).toHaveTextContent('Paint a tree');
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const saves = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/plan'));
  expect(saves).toHaveLength(2); expect(saves[0][1]).toEqual(saves[1][1]);
});

test('late room responses cannot overwrite the selected room and viewers have no write actions', async () => {
  const normal = vi.mocked(axios.get).getMockImplementation()!;
  let resolve!: (value: ReturnType<typeof response>) => void;
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/plan') && config?.params.roomId === room.id) return new Promise((done) => { resolve = done; });
    return normal(url, config);
  });
  render(<SignedIn account={{ ...testAccount, role: 'viewer' }}><Activities /></SignedIn>);
  await screen.findByRole('option', { name: /^Sunflower/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: room.id } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'other-room' } });
  await screen.findByText('Nothing scheduled for this day.');
  await act(async () => resolve(response({ ...base(room.id, '2026-09-14'), entries: [{ id: 'old', date: '2026-09-14', timeBlock: 'morning', startTime: null, endTime: null, activityId: art.id, activity: art }] })));
  expect(screen.getByRole('combobox', { name: 'Room' })).toHaveValue('other-room');
  expect(screen.queryByRole('button', { name: 'Add activity' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save week' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create library activity' })).not.toBeInTheDocument();
});

test('catalog edits preserve saved entries when times change until explicitly choosing the updated activity', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const summary = screen.getByText('Saved activities (1)'); fireEvent.click(summary); summary.closest('details')!.open = true;
  fireEvent.click(screen.getByRole('button', { name: 'Edit Paint a tree' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Corrected tree activity' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  await screen.findByText('Activity saved to the library. Save week separately to keep schedule changes.');
  edit(); fireEvent.change(start(), { target: { value: '10:00' } }); apply();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(selected()).toHaveTextContent('Paint a tree'); expect(selected()).not.toHaveTextContent('Corrected tree activity');
  fireEvent.click(within(selected()).getByRole('button', { name: 'Use updated activity' }));
  expect(selected()).toHaveTextContent('Corrected tree activity'); expect(selected()).toHaveTextContent('10:00–10:20');
  expect(screen.getByText('Unsaved changes', { exact: true })).toBeInTheDocument();
});

test('legacy schedules keep untimed activities and allow times to be entered without losing the snapshot', async () => {
  const legacy: Entry = { id: 'legacy-entry', date: '2026-09-14', timeBlock: 'morning', startTime: null, endTime: null, activityId: art.id, activity: { ...art, name: 'Earlier activity' } };
  weeks.set(room.id + '2026-09-14', { ...base(room.id, '2026-09-14'), version: 1, savedAt: '2026-09-14T00:00:00Z', entries: [legacy] });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: '2026-09-14' } });
  await waitFor(() => expect(selected()).toHaveTextContent('Earlier activity'));
  expect(within(selected()).getByText('Time not set · Morning. Your saved activity is kept; enter its times when ready.', { exact: true })).toBeInTheDocument();
  edit(); expect(start()).toHaveValue(''); expect(end()).toHaveValue('');
  expect(screen.getByRole('form', { name: 'Edit scheduled activity' })).toHaveTextContent('Earlier activity');
  fireEvent.change(start(), { target: { value: '08:45' } }); expect(end()).toHaveValue('09:05'); apply();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ id: 'legacy-entry', timeBlock: null, startTime: '08:45', endTime: '09:05', useLatest: false })] }));
  expect(selected()).toHaveTextContent('Earlier activity');
});

test('material shortages are shown from preview and failed checks do not leave stale quantities visible', async () => {
  const normal = vi.mocked(axios.post).getMockImplementation()!; let fail = false;
  vi.mocked(axios.post).mockImplementation(async (url, payload, config) => {
    if (!url.endsWith('/preview')) return normal(url, payload, config);
    if (fail) throw new Error('Unavailable inventory');
    return response({ materials: [{ itemId: 'paper', name: 'Paper', location: 'Cupboard', unit: 'count', needed: '12', available: '10', shortage: '2', issue: null }] });
  });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  const table = await screen.findByRole('table', { name: 'Activity material availability' });
  expect(table).toHaveTextContent('12 items'); expect(table).toHaveTextContent('10 items'); expect(table).toHaveTextContent('2 items');
  fail = true; fireEvent.click(screen.getByRole('button', { name: 'Check materials again' }));
  await screen.findByText(/Could not check materials/);
  expect(screen.queryByRole('table', { name: 'Activity material availability' })).not.toBeInTheDocument();
  expect(selected()).toHaveTextContent('Paint a tree');
});

test('an unmatched catalog offers creation for the chosen day and cancellation leaves the draft alone', async () => {
  activities = [{ ...art, ageMinMonths: 72, ageMaxMonths: 120 }];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  expect(screen.queryByRole('button', { name: 'Choose Paint a tree' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
  expect(screen.queryByText('Unsaved changes', { exact: true })).not.toBeInTheDocument();
  const form = openNew('Tuesday');
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Circle time' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '15' } });
  fireEvent.click(within(form).getByText('More details')); form.querySelector('details')!.open = true;
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minimum age (months)' }), { target: { value: '72' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '120' } });
  fireEvent.submit(form); await screen.findByText(/This activity must include the room’s age range/);
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minimum age (months)' }), { target: { value: '24' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '60' } });
  await createAndSchedule(form);
  expect(selected(1, 'Tuesday')).toHaveTextContent('Circle time'); expect(selected(1, 'Tuesday')).toHaveTextContent('08:00–08:15');
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const save = vi.mocked(axios.post).mock.calls.find(([url]) => url.endsWith('/plan'))![1] as ActivityPlan;
  const tuesday = new Date(save.weekStart + 'T00:00:00Z'); tuesday.setUTCDate(tuesday.getUTCDate() + 1);
  expect(save.entries).toEqual([expect.objectContaining({ date: tuesday.toISOString().slice(0, 10), activityId: 'new-art', endTime: '08:15' })]);
});

test.each([
  { settings: { active: false }, reason: 'This room is archived. Its saved week is available to view and print.' },
  { settings: { needsConfiguration: true, capacity: null }, reason: 'Finish this room’s setup in Rooms & Classes before adding activities.' },
])('Add activity explains blocked room settings without allowing changes: $reason', async ({ settings, reason }) => {
  rooms = [{ ...room, ...settings }]; activities = [];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  const button = screen.getByRole('button', { name: 'Add activity' });
  expect(button).toBeDisabled(); expect(button).toHaveAccessibleDescription(reason);
  fireEvent.click(button); expect(screen.queryByRole('form', { name: 'Schedule activity' })).not.toBeInTheDocument();
});

test('a failed catalog load explains the disabled action and refresh restores Add activity', async () => {
  const normal = vi.mocked(axios.get).getMockImplementation()!; let fail = true;
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/activity') && fail) throw new Error('Catalog unavailable');
    return normal(url, config);
  });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  const button = screen.getByRole('button', { name: 'Add activity' });
  expect(button).toBeDisabled(); expect(button).toHaveAccessibleDescription('Activities could not load. Use Refresh activities to retry.');
  fail = false;
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Refresh activities' }));
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button); expect(screen.getByRole('form', { name: 'Schedule activity' })).toBeInTheDocument();
});

test('a new library activity does not inherit an invalid age range from an older room', async () => {
  rooms = [{ ...room, ageMinMonths: 0, ageMaxMonths: 0 }]; activities = [];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  const summary = screen.getByText('Saved activities (0)'); fireEvent.click(summary); summary.closest('details')!.open = true;
  fireEvent.click(screen.getByRole('button', { name: 'Create library activity' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  expect(within(form).getByLabelText('Minimum age (months)')).toHaveValue(null);
  expect(within(form).getByLabelText('Maximum age (months)')).toHaveValue(null);
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Read a book' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity' }));
  await screen.findByText('Activity saved to the library. Save week separately to keep schedule changes.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/activity'), expect.objectContaining({ name: 'Read a book', ageMinMonths: null, ageMaxMonths: null }));
  expect(screen.queryByRole('group', { name: 'Monday activity 1' })).not.toBeInTheDocument();
});

test('switching days keeps open activity details and freezes the chosen day while saving the catalog', async () => {
  activities = [];
  const normal = vi.mocked(axios.post).getMockImplementation()!;
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(axios.post).mockImplementation(async (url, payload, config) => {
    if (url.endsWith('/activity')) return new Promise((resolve) => { finish = resolve; });
    return normal(url, payload, config);
  });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: '2026-09-14' } });
  await waitFor(() => expect(screen.queryByText('Loading week…')).not.toBeInTheDocument());
  const form = openNew();
  const name = within(form).getByRole('textbox', { name: 'Activity name' });
  fireEvent.change(name, { target: { value: 'Read a book' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
  expect(within(form).getByRole('heading', { name: 'Add activity to Wednesday' })).toBeInTheDocument();
  expect(name).toHaveValue('Read a book'); expect(screen.getAllByRole('form', { name: 'New activity' })).toHaveLength(1);
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  const confirmation = within(form).getByRole('group', { name: 'Discard activity changes' });
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
  expect(name).toHaveValue('Read a book');
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity & choose time' }));
  expect(screen.getByRole('button', { name: 'Wednesday' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
  expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
  const saved = { ...art, id: 'read-book', name: 'Read a book', durationMinutes: 15 };
  activities.push(saved); await act(async () => finish(response(saved)));
  await screen.findByText('Activity saved to the library. Save week separately to keep schedule changes.');
  expect(screen.getByRole('button', { name: 'Wednesday' })).toBeEnabled();
  expect(screen.queryByRole('group', { name: 'Tuesday activity 1' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add to day' }));
  expect(selected(1, 'Tuesday')).toHaveTextContent('Read a book'); expect(selected(1, 'Tuesday')).toHaveTextContent('08:00–08:15');
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ date: '2026-09-15', activityId: saved.id })] }));
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
});

test('Cancel visibly confirms discarding typed details and preserves the weekly draft', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  const form = openNew();
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Unfinished activity' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(form).getByRole('button', { name: 'Discard activity' }));
  expect(screen.queryByRole('form', { name: 'New activity' })).not.toBeInTheDocument();
  expect(selected()).toHaveTextContent('Paint a tree'); expect(screen.getByText('Unsaved changes', { exact: true })).toBeInTheDocument();
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
  expect(window.confirm).not.toHaveBeenCalled();
});

test('a failed activity save shows an error and restores editing and day navigation', async () => {
  activities = [];
  const normal = vi.mocked(axios.post).getMockImplementation()!; let fail = true;
  vi.mocked(axios.post).mockImplementation(async (url, payload, config) => {
    if (url.endsWith('/activity') && fail) throw new Error('Activity save failed');
    return normal(url, payload, config);
  });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  const form = openNew();
  const name = within(form).getByRole('textbox', { name: 'Activity name' });
  fireEvent.change(name, { target: { value: 'Read a book' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity & choose time' }));
  await within(form).findByText('Could not save this activity. Your details are still here.');
  expect(name).toHaveValue('Read a book'); expect(name).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Tuesday' })).toBeEnabled();
  expect(within(form).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fail = false; await createAndSchedule(form);
  expect(selected(1, 'Tuesday')).toHaveTextContent('Read a book');
});

function navigationDom() {
  // Node fetch requires its own AbortSignal; jsdom's controller has a different realm.
  vi.stubGlobal('AbortController', class { constructor() { return transferableAbortController(); } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
}
function navigationApp(role: 'admin' | 'viewer' = 'admin') {
  navigationDom();
  const router = createMemoryRouter([{ path: '*', element:
    <SignedIn account={{ ...testAccount, role }}><UnsavedChangesProvider>
      <Link to="/home">Home</Link><ActivityNavigationPage />
    </UnsavedChangesProvider></SignedIn>,
  }], { initialEntries: ['/home', '/activities'], initialIndex: 1 });
  render(<RouterProvider router={router} />);
  return router;
}
// The real planner must unmount on navigation, just as it does in AppRoutes.
function ActivityNavigationPage() {
  const location = useLocation();
  return location.pathname === '/activities' ? <Activities /> : <h1>Destination</h1>;
}

test('schedule navigation keeps edits on cancel, guards history and explicitly discards', async () => {
  const router = navigationApp(); await chooseRoom(); add();
  fireEvent.click(screen.getByRole('link', { name: 'Home' }));
  await screen.findByRole('dialog', { name: 'Leave your unsaved work?' });
  expect(router.state.location.pathname).toBe('/activities');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(selected()).toHaveTextContent('Paint a tree');
  await act(async () => { await router.navigate(-1); });
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
  await screen.findByRole('heading', { name: 'Destination' });
  await act(async () => { await router.navigate(1); });
  await chooseRoom();
  expect(screen.queryByRole('group', { name: 'Monday activity 1' })).not.toBeInTheDocument();
});

test('unfinished activity survives cancel and day changes; leaving never creates a catalog activity', async () => {
  navigationApp(); await chooseRoom(); const form = openNew();
  fireEvent.change(within(form).getByLabelText('Activity name'), { target: { value: 'Unfinished synthetic activity' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Activity name')).toHaveValue('Unfinished synthetic activity');
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Home' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard and leave' }));
  await screen.findByRole('heading', { name: 'Destination' });
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
});

test('failed and conflicting week saves preserve the draft and its navigation guard', async () => {
  navigationApp(); await chooseRoom(); add();
  vi.mocked(axios.post).mockImplementation(async (url) => {
    if (url.endsWith('/preview')) return response({ materials: [] });
    throw { response: { status: 409, data: { error: 'Another user changed this week.' } } };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByRole('alert');
  expect(selected()).toHaveTextContent('Paint a tree');
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(selected()).toHaveTextContent('Paint a tree');
});

test('successful save and readonly navigation do not prompt', async () => {
  navigationApp(); await chooseRoom(); add();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('heading', { name: 'Destination' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('readonly planner does not block leaving', async () => {
  navigationApp('viewer'); await chooseRoom();
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('heading', { name: 'Destination' });
});

test('navigation waits for an in-flight save and a failure keeps entered work', async () => {
  navigationApp(); await chooseRoom(); add();
  let rejectSave!: (error: unknown) => void;
  vi.mocked(axios.post).mockImplementation((url) => url.endsWith('/preview') ? Promise.resolve(response({ materials: [] }))
    : new Promise((_resolve, reject) => { rejectSave = reject; }));
  fireEvent.click(screen.getByRole('button', { name: 'Save week' }));
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
  expect(screen.getByRole('button', { name: 'Discard and leave' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  await act(async () => rejectSave(new Error('Synthetic unavailable server'))); await screen.findByRole('alert');
  expect(selected()).toHaveTextContent('Paint a tree');
  fireEvent.click(screen.getByRole('link', { name: 'Home' }));
  expect(await screen.findByRole('button', { name: 'Discard and leave' })).toBeEnabled();
});

test('discarding a form clears its guard without discarding a weekly draft', async () => {
  navigationApp(); await chooseRoom(); add(); const form = openNew();
  fireEvent.change(within(form).getByLabelText('Activity name'), { target: { value: 'Synthetic discarded form' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(form).getByRole('button', { name: 'Discard activity' }));
  expect(selected()).toHaveTextContent('Paint a tree');
  discardComposer(screen.getByRole('form', { name: 'Schedule activity' }));
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
});

test('account changes unmount both private drafts and clear a pending navigation dialog', async () => {
  navigationDom();
  const router = createMemoryRouter([{ path: '*', element: <UnsavedChangesProvider><Link to="/home">Home</Link><ActivityNavigationPage /></UnsavedChangesProvider> }], { initialEntries: ['/activities'] });
  const view = render(<SignedIn><AuthGate><RouterProvider router={router} /></AuthGate></SignedIn>);
  await chooseRoom(); add(); const form = openNew();
  fireEvent.change(within(form).getByLabelText('Activity name'), { target: { value: 'Previous account private draft' } });
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
  view.rerender(<SignedIn account={{ ...testAccount, id: 'different-account' }}><AuthGate><RouterProvider router={router} /></AuthGate></SignedIn>);
  await chooseRoom();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Activity name')).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Monday activity 1' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('heading', { name: 'Destination' });
});

test('the week overview shows all seven days without opening seven editing forms', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  add('Monday'); add('Wednesday'); add('Sunday');
  fireEvent.click(screen.getByRole('button', { name: 'Week view' }));
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    expect(screen.getByRole('region', { name: day })).toBeInTheDocument();
  }
  expect(selected(1, 'Monday')).toHaveTextContent('Paint a tree');
  expect(selected(1, 'Wednesday')).toHaveTextContent('Paint a tree');
  expect(selected(1, 'Sunday')).toHaveTextContent('Paint a tree');
  expect(screen.queryByRole('form', { name: 'Schedule activity' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Start time', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const saved = vi.mocked(axios.post).mock.calls.find(([url]) => url.endsWith('/plan'))![1] as ActivityPlan;
  expect(saved.entries).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Day view' }));
  expect(screen.getByRole('region', { name: 'Sunday' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Monday' })).not.toBeInTheDocument();
});

test('a saved activity becomes a complete scheduled entry in three clicks', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  // The current day is already selected: open, choose, confirm.
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  const form = screen.getByRole('form', { name: 'Schedule activity' });
  fireEvent.click(within(form).getByRole('button', { name: 'Choose Paint a tree' }));
  expect(start()).toHaveValue('08:00'); expect(end()).toHaveValue('08:20');
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  expect(selected()).toHaveTextContent('Paint a tree'); expect(selected()).toHaveTextContent('08:00–08:20');
  expect(screen.queryByRole('form', { name: 'Schedule activity' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save week' })).toBeEnabled();
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/plan'))).toBe(false);
});

test('focused editing commits only on Apply changes and Cancel preserves the existing week', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const form = edit(); fireEvent.change(start(), { target: { value: '10:00' } });
  expect(selected()).toHaveTextContent('08:00–08:20');
  expect(screen.queryByText('Unsaved changes', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Room' })).toBeDisabled();
  expect(screen.getByLabelText('Week starting Monday')).toBeDisabled();
  discardComposer(form);
  expect(selected()).toHaveTextContent('08:00–08:20'); expect(screen.getByText('Saved week', { exact: true })).toBeInTheDocument();
  edit(); fireEvent.change(start(), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Week view' }));
  expect(screen.getByRole('heading', { name: 'Edit activity on Monday' })).toBeInTheDocument();
  expect(start()).toHaveValue('10:00'); apply();
  expect(selected()).toHaveTextContent('10:00–10:20'); expect(screen.getByText('Unsaved changes', { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Tuesday activity 1' })).not.toBeInTheDocument();
});

test('removal is undoable across day and week views and a saved removal clears Undo', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add(); add('Monday', 2);
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const original = [...weeks.values()][0].entries.map((entry) => entry.id);
  fireEvent.click(screen.getByRole('button', { name: 'Remove activity 1 on Monday' }));
  expect(screen.queryByRole('group', { name: 'Monday activity 2' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Week view' }));
  fireEvent.click(screen.getByRole('button', { name: 'Undo removal' }));
  expect(selected(1, 'Monday')).toHaveTextContent('08:00–08:20'); expect(selected(2, 'Monday')).toHaveTextContent('08:20–08:40');
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect([...weeks.values()][0].entries.map((entry) => entry.id).sort()).toEqual(original.sort());
  fireEvent.click(screen.getByRole('button', { name: 'Remove activity 1 on Monday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(screen.queryByRole('button', { name: 'Undo removal' })).not.toBeInTheDocument();
});

test('invalid edited times show an inline error and cannot overwrite the scheduled entry', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  const form = edit(); fireEvent.change(end(), { target: { value: '07:00' } }); apply();
  expect(within(form).getByText('End time must be after start time.', { exact: true })).toBeInTheDocument();
  expect(end()).toHaveAttribute('aria-invalid', 'true');
  expect(end()).toHaveAccessibleDescription('End time must be after start time.');
  expect(selected()).toHaveTextContent('08:00–08:20');
  fireEvent.change(end(), { target: { value: '' } }); apply();
  expect(end()).toHaveAccessibleDescription('Enter an end time.');
  expect(selected()).toHaveTextContent('08:00–08:20');
  fireEvent.change(end(), { target: { value: '08:45' } }); apply();
  expect(selected()).toHaveTextContent('08:00–08:45');
});

test('unsaved chooser search and time changes remain guarded through navigation and view changes', async () => {
  navigationApp(); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  const form = screen.getByRole('form', { name: 'Schedule activity' });
  fireEvent.change(within(form).getByLabelText('Search saved activities', { exact: true }), { target: { value: 'Paint' } });
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(within(form).getByLabelText('Search saved activities', { exact: true })).toHaveValue('Paint');
  fireEvent.click(within(form).getByRole('button', { name: 'Choose Paint a tree' }));
  fireEvent.change(start(), { target: { value: '09:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Week view' }));
  expect(screen.getByRole('form', { name: 'Schedule activity' })).toBe(form);
  expect(start()).toHaveValue('09:30'); expect(end()).toHaveValue('09:50');
  fireEvent.click(screen.getByRole('link', { name: 'Home' })); await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  expect(selected(1, 'Tuesday')).toHaveTextContent('09:30–09:50');
  expect(screen.queryByRole('group', { name: 'Monday activity 1' })).not.toBeInTheDocument();
});
