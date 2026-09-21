import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Activities from './Activities';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { Activity, ActivityPlan, Entry } from '../api/activities';
import type { Room } from '../api/rooms';

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
  fireEvent.click(screen.getByRole('button', { name: 'Add to ' + day }));
  fireEvent.change(screen.getByRole('combobox', { name: day + ' activity ' + number }), { target: { value: id } });
}
const selected = (number = 1, day = 'Monday') => screen.getByRole('combobox', { name: day + ' activity ' + number });
const start = (number = 1) => screen.getByLabelText('Monday activity ' + number + ' start');
const end = (number = 1) => screen.getByLabelText('Monday activity ' + number + ' end');
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
  for (let number = 1; number <= 5; number++) add('Monday', number);
  expect(within(selected()).queryByRole('option', { name: 'Older children activity' })).not.toBeInTheDocument();
  expect(start()).toHaveValue('08:00'); expect(start(5)).toHaveValue('09:20'); expect(end(5)).toHaveValue('09:40');
  const week = (screen.getByLabelText('Week starting Monday') as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const calls = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/plan'));
  const saved = calls[0][1] as ActivityPlan;
  expect(saved.entries).toHaveLength(5); expect(new Set(saved.entries.map((entry) => entry.id)).size).toBe(5);
  expect(saved.entries[4]).toMatchObject({ date: week, startTime: '09:20', endTime: '09:40', activityId: art.id, activityVersion: 1 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'other-room' } });
  await screen.findByText('Nothing scheduled for this day.');
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: room.id } });
  await waitFor(() => expect(selected(5)).toHaveValue(art.id));
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: '2030-01-07' } });
  await screen.findByText('Nothing scheduled for this day.');
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: week } });
  await waitFor(() => expect(start(5)).toHaveValue('09:20'));
  fireEvent.click(screen.getByRole('button', { name: 'Print' })); expect(window.print).toHaveBeenCalledTimes(1);
  const printed = document.querySelector('.activity-print table')!;
  expect(printed).toHaveTextContent('09:20–09:40'); expect(within(printed as HTMLElement).getAllByText('Paint a tree')).toHaveLength(5);
  fireEvent.click(screen.getByRole('button', { name: 'Remove activity 3 on Monday' }));
  expect(screen.queryByRole('combobox', { name: 'Monday activity 5' })).not.toBeInTheDocument();
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
});

test('times are editable, can reach midnight, and incomplete or reversed times cannot be saved', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Monday' }));
  expect(screen.getByRole('button', { name: 'Save week' })).toBeDisabled();
  fireEvent.change(selected(), { target: { value: art.id } });
  fireEvent.change(start(), { target: { value: '07:00' } }); expect(end()).toHaveValue('07:20');
  fireEvent.change(end(), { target: { value: '06:00' } });
  expect(screen.getByText('End time must be after start time.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save week' })).toBeDisabled();
  fireEvent.change(end(), { target: { value: '00:00' } });
  expect(screen.getByText('Ends at midnight, at the end of this day.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ startTime: '07:00', endTime: '24:00' })] }));
  add('Sunday');
  expect(selected(1, 'Sunday')).toHaveValue(art.id);
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(start()).toHaveValue('07:00');
});

test('Add to day works with an empty catalog, validates ages and schedules the created activity', async () => {
  activities = [];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  await screen.findByText('No activities yet. Use Add to day to create your first one.');
  expect(screen.getByRole('button', { name: 'Add to Monday' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Monday' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  expect(within(form).getByLabelText('Minimum age (months)')).not.toBeVisible();
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Play with shapes' } });
  fireEvent.click(within(form).getByText('More details')); form.querySelector('details')!.open = true;
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minimum age (months)' }), { target: { value: '0' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '0' } });
  fireEvent.click(within(form).getByText('More details')); form.querySelector('details')!.open = false;
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  await screen.findByText(/Enter both ages in months/);
  expect(within(form).getByLabelText('Maximum age (months)')).toBeVisible();
  expect(within(form).getByRole('alert')).toHaveFocus();
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '72' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' })); await screen.findByText('Unsaved changes');
  expect(selected()).toHaveValue('new-art');
  expect(within(selected()).getByRole('option', { name: 'Play with shapes' })).toBeInTheDocument();
  expect(start()).toHaveValue('08:00'); expect(end()).toHaveValue('08:20');
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
  expect(selected()).toHaveValue(art.id);
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
  expect(screen.queryByRole('button', { name: 'Add to Monday' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save week' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add activity' })).not.toBeInTheDocument();
});

test('catalog edits preserve saved entries when times change until explicitly choosing the updated activity', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const summary = screen.getByText('Saved activities (1)'); fireEvent.click(summary); summary.closest('details')!.open = true;
  fireEvent.click(screen.getByRole('button', { name: 'Edit Paint a tree' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Corrected tree activity' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' })); await screen.findByText('Activity saved. Choose it in the week below.');
  fireEvent.change(start(), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(within(selected()).getByRole('option', { name: 'Paint a tree' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use updated activity' }));
  expect(within(selected()).getByRole('option', { name: 'Corrected tree activity' })).toBeInTheDocument();
  expect(start()).toHaveValue('10:00'); expect(end()).toHaveValue('10:20');
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
});

test('legacy schedules keep untimed activities and allow times to be entered without losing the snapshot', async () => {
  const legacy: Entry = { id: 'legacy-entry', date: '2026-09-14', timeBlock: 'morning', startTime: null, endTime: null, activityId: art.id, activity: { ...art, name: 'Earlier activity' } };
  weeks.set(room.id + '2026-09-14', { ...base(room.id, '2026-09-14'), version: 1, savedAt: '2026-09-14T00:00:00Z', entries: [legacy] });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: '2026-09-14' } });
  await screen.findByText(/Time not set · Morning. Your saved activity is kept/);
  expect(start()).toHaveValue(''); expect(within(selected()).getByRole('option', { name: 'Earlier activity' })).toBeInTheDocument();
  fireEvent.change(start(), { target: { value: '08:45' } }); expect(end()).toHaveValue('09:05');
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ id: 'legacy-entry', timeBlock: null, startTime: '08:45', endTime: '09:05', useLatest: false })] }));
  expect(within(selected()).getByRole('option', { name: 'Earlier activity' })).toBeInTheDocument();
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
  expect(selected()).toHaveValue(art.id);
});

test('an unmatched catalog offers creation for the chosen day and cancellation leaves the draft alone', async () => {
  activities = [{ ...art, ageMinMonths: 72, ageMaxMonths: 120 }];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  expect(screen.getByRole('button', { name: 'Add to Tuesday' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Tuesday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Tuesday' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  expect(screen.getByRole('button', { name: 'Continue activity for Tuesday' })).toBeEnabled();
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Circle time' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '15' } });
  fireEvent.click(within(form).getByText('More details')); form.querySelector('details')!.open = true;
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minimum age (months)' }), { target: { value: '72' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '120' } });
  fireEvent.submit(form); await screen.findByText(/This activity must include the room’s age range/);
  expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.endsWith('/activity'))).toBe(false);
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minimum age (months)' }), { target: { value: '24' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Maximum age (months)' }), { target: { value: '60' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  await screen.findByText('Unsaved changes');
  expect(selected(1, 'Tuesday')).toHaveValue('new-art');
  expect(screen.getByLabelText('Tuesday activity 1 end')).toHaveValue('08:15');
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  const save = vi.mocked(axios.post).mock.calls.find(([url]) => url.endsWith('/plan'))![1] as ActivityPlan;
  const tuesday = new Date(save.weekStart + 'T00:00:00Z'); tuesday.setUTCDate(tuesday.getUTCDate() + 1);
  expect(save.entries).toEqual([expect.objectContaining({ date: tuesday.toISOString().slice(0, 10), activityId: 'new-art', endTime: '08:15' })]);
});

test.each([
  { settings: { active: false }, reason: 'This room is archived. Choose an active room to add activities.' },
  { settings: { needsConfiguration: true, capacity: null }, reason: 'Finish this room’s setup in Rooms & Classes before adding activities.' },
])('Add to day explains blocked room settings without allowing changes: $reason', async ({ settings, reason }) => {
  rooms = [{ ...room, ...settings }]; activities = [];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  const button = screen.getByRole('button', { name: 'Add to Monday' });
  expect(button).toBeDisabled(); expect(button).toHaveAccessibleDescription(reason);
  fireEvent.click(button); expect(screen.queryByRole('form', { name: 'New activity' })).not.toBeInTheDocument();
});

test('a failed catalog load explains the disabled action and refresh restores Add to day', async () => {
  const normal = vi.mocked(axios.get).getMockImplementation()!; let fail = true;
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/activity') && fail) throw new Error('Catalog unavailable');
    return normal(url, config);
  });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  const button = screen.getByRole('button', { name: 'Add to Monday' });
  expect(button).toBeDisabled(); expect(button).toHaveAccessibleDescription('Activities could not load. Select Refresh activities above.');
  fail = false;
  fireEvent.click(
    within(screen.getByRole('alert')).getByRole('button', {
      name: 'Refresh activities',
    }),
  );
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button); expect(selected()).toBeInTheDocument();
});

test('a new activity does not inherit an invalid age range from an older room', async () => {
  rooms = [{ ...room, ageMinMonths: 0, ageMaxMonths: 0 }]; activities = [];
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Monday' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  expect(within(form).getByLabelText('Minimum age (months)')).toHaveValue(null);
  expect(within(form).getByLabelText('Maximum age (months)')).toHaveValue(null);
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Read a book' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  await screen.findByText('Unsaved changes');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/activity'), expect.objectContaining({ name: 'Read a book', ageMinMonths: null, ageMaxMonths: null }));
  expect(within(selected()).getByRole('option', { name: 'Read a book' })).toBeInTheDocument();
});

test('switching days keeps the open activity details and saves to the chosen day without changing it mid-request', async () => {
  activities = [];
  const normal = vi.mocked(axios.post).getMockImplementation()!;
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(axios.post).mockImplementation(async (url, payload, config) => {
    if (url.endsWith('/activity')) return new Promise((resolve) => { finish = resolve; });
    return normal(url, payload, config);
  });
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom();
  fireEvent.change(screen.getByLabelText('Week starting Monday'), { target: { value: '2026-09-14' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Add to Monday' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  const name = within(form).getByRole('textbox', { name: 'Activity name' });
  fireEvent.change(name, { target: { value: 'Read a book' } });
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'Minutes' }), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
  expect(within(form).getByRole('heading', { name: 'Add activity to Wednesday' })).toBeInTheDocument();
  expect(name).toHaveValue('Read a book');
  fireEvent.click(screen.getByRole('button', { name: 'Continue activity for Wednesday' }));
  expect(name).toHaveFocus(); expect(screen.getAllByRole('form', { name: 'New activity' })).toHaveLength(1);
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  const confirmation = within(form).getByRole('group', { name: 'Discard activity changes' });
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Keep editing' }));
  expect(name).toHaveValue('Read a book');
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  expect(screen.getByRole('button', { name: 'Wednesday' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }));
  expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
  const saved = { ...art, id: 'read-book', name: 'Read a book', durationMinutes: 15 };
  activities.push(saved);
  await act(async () => finish(response(saved)));
  await screen.findByText('Unsaved changes');
  expect(screen.getByRole('button', { name: 'Wednesday' })).toBeEnabled();
  expect(selected(1, 'Tuesday')).toHaveValue(saved.id);
  expect(screen.getByLabelText('Tuesday activity 1 end')).toHaveValue('08:15');
  fireEvent.click(screen.getByRole('button', { name: 'Save week' })); await screen.findByText('Week saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/schedule/plan'), expect.objectContaining({ entries: [expect.objectContaining({ date: '2026-09-15', activityId: saved.id })] }));
  fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
  expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument();
});

test('Cancel visibly confirms discarding typed details and preserves the weekly draft', async () => {
  render(<SignedIn><Activities /></SignedIn>); await chooseRoom(); add();
  fireEvent.click(screen.getByRole('button', { name: 'Add activity' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  fireEvent.change(within(form).getByRole('textbox', { name: 'Activity name' }), { target: { value: 'Unfinished activity' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(form).getByRole('button', { name: 'Discard activity' }));
  expect(screen.queryByRole('form', { name: 'New activity' })).not.toBeInTheDocument();
  expect(selected()).toHaveValue(art.id); expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
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
  fireEvent.click(screen.getByRole('button', { name: 'Add to Monday' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  const name = within(form).getByRole('textbox', { name: 'Activity name' });
  fireEvent.change(name, { target: { value: 'Read a book' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  await within(form).findByText('Could not save this activity. Your details are still here.');
  expect(name).toHaveValue('Read a book'); expect(name).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Tuesday' })).toBeEnabled();
  expect(within(form).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
  fail = false; fireEvent.click(within(form).getByRole('button', { name: 'Add to day' }));
  await screen.findByText('Unsaved changes');
  expect(selected(1, 'Tuesday')).toHaveValue('new-art');
});
