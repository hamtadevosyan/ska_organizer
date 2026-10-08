import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import RoomRoster from './RoomRoster';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { ChildRecord } from '../api/children';
import type { Room } from '../api/rooms';

vi.mock('axios');
const room: Room = { id: 'sunflower', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60,
  capacity: 30, active: true, assignedChildCount: 2, availablePlaces: 28, overCapacity: false, needsConfiguration: false };
const otherRoom = { ...room, id: 'rainbow', name: 'Rainbow' };
const child: ChildRecord = { id: 'first', firstName: 'Synthetic', lastName: 'Child', dateOfBirth: '2022-01-01',
  preferredName: 'Sunny', roomId: room.id, active: true, notes: 'Uses a blue cup.' };
let roster: ChildRecord[];
let catalog: Room[];

beforeEach(() => {
  vi.resetAllMocks();
  roster = [{ ...child }, { ...child, id: 'second', preferredName: 'Ray', dateOfBirth: '2023-01-01', notes: 'Uses a yellow cup.' },
    { ...child, id: 'inactive', firstName: 'Inactive', active: false }, { ...child, id: 'other', firstName: 'Other', roomId: otherRoom.id }];
  catalog = [{ ...room }, { ...otherRoom }];
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/documents')) return { data: { items: [], total: 0 } };
    if (url.endsWith('/profile')) {
      const value = roster.find(row => url.includes('/' + row.id + '/'))!;
      return { data: { child: value, room: catalog.find(item => item.id === value.roomId), recentAttendance: [
        { id: 'historical-attendance', roomId: otherRoom.id, checkIn: '2026-01-02T18:00:00Z', checkOut: '2026-01-02T20:00:00Z' },
      ], timeZone: 'America/Los_Angeles' } };
    }
    if (url.endsWith('/rooms')) return { data: { data: catalog } };
    if (url.includes('/rooms/')) {
      const value = catalog.find(item => url.endsWith('/' + item.id))!;
      return { data: { data: { ...value, assignedChildCount: roster.filter(row => row.roomId === value.id && row.active).length } } };
    }
    const { q = '', roomId, active, page = 1, pageSize = 25 } = config?.params || {};
    const matches = roster.filter(row => row.roomId === roomId && (active === 'all' || row.active) &&
      (row.firstName + ' ' + row.lastName + ' ' + row.preferredName).toLowerCase().includes(q.toLowerCase()));
    return { data: { items: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length } };
  });
});

function show(path = '/rooms/sunflower', role: 'admin' | 'viewer' = 'admin') {
  return render(<SignedIn account={{ ...testAccount, role }}><MemoryRouter initialEntries={[path]}>
    <Link to="/rooms/rainbow">Open Rainbow</Link>
    <Routes><Route path="/rooms/:roomId" element={<RoomRoster />} /><Route path="/rooms" element={<h1>Rooms &amp; Classes</h1>} /></Routes>
  </MemoryRouter></SignedIn>);
}

test('a room defaults to active enrollment, searches preferred names and keeps occupancy separate from filtering', async () => {
  show();
  await screen.findByRole('table', { name: 'Room roster records' });
  expect(screen.getAllByRole('row', { name: 'Synthetic Child' })).toHaveLength(2);
  expect(screen.queryByRole('row', { name: 'Inactive Child' })).not.toBeInTheDocument();
  expect(screen.queryByRole('row', { name: 'Other Child' })).not.toBeInTheDocument();
  const enrollment = screen.getByRole('region', { name: 'Room enrollment' });
  expect(enrollment).toHaveTextContent('2 active children');
  expect(enrollment).toHaveTextContent('Capacity 30');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include inactive children' }));
  const inactive = await screen.findByRole('row', { name: 'Inactive Child' });
  expect(inactive).toHaveTextContent('Inactive');
  expect(screen.getByRole('region', { name: 'Room enrollment' })).toHaveTextContent('2 active children');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search children' }), { target: { value: 'ray' } });
  await waitFor(() => expect(screen.getAllByRole('row', { name: 'Synthetic Child' })).toHaveLength(1));
  expect(screen.getByRole('row', { name: 'Synthetic Child' })).toHaveTextContent('Goes by Ray');
  expect(screen.getByRole('region', { name: 'Room enrollment' })).toHaveTextContent('2 active children');
});

test('same-name children open distinct existing profiles and return to the selected room', async () => {
  show();
  await screen.findByRole('table', { name: 'Room roster records' });
  const row = screen.getAllByRole('row', { name: 'Synthetic Child' }).find(item => item.textContent?.includes('2023-01-01'))!;
  fireEvent.click(within(row).getByRole('button', { name: 'View Synthetic Child' }));
  const profile = await screen.findByRole('region', { name: 'Child profile' });
  await within(profile).findByText('Uses a yellow cup.');
  await within(profile).findByText('Rainbow');
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/children/second/profile'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.queryByRole('table', { name: 'Room roster records' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to room roster' }));
  await screen.findByRole('table', { name: 'Room roster records' });
  expect(screen.getByRole('heading', { name: 'Sunflower' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Back to rooms' }));
  await screen.findByRole('heading', { name: 'Rooms & Classes' });
});

test('room navigation clears old children immediately and ignores a late response for the previous room', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let completeOld: (value: { data: { items: ChildRecord[]; total: number } }) => void = () => {};
  let oldSignal: AbortSignal | undefined;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/children') && config?.params.roomId === room.id) {
      oldSignal = config?.signal as AbortSignal;
      return new Promise(resolve => { completeOld = resolve; });
    }
    return get(url, config);
  });
  show();
  await waitFor(() => expect(oldSignal).toBeDefined());
  fireEvent.click(screen.getByRole('link', { name: 'Open Rainbow' }));
  expect(oldSignal?.aborted).toBe(true);
  expect(screen.queryByRole('row', { name: 'Synthetic Child' })).not.toBeInTheDocument();
  await screen.findByRole('row', { name: 'Other Child' });
  completeOld({ data: { items: [child], total: 1 } });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Rainbow' })).toBeInTheDocument());
  expect(screen.queryByRole('row', { name: 'Synthetic Child' })).not.toBeInTheDocument();
});

test('a refresh failure hides old children and retry loads the correct room', async () => {
  show();
  await screen.findByRole('table', { name: 'Room roster records' });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/children')) throw new Error('Synthetic outage');
    return get(url, config);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roster' }));
  expect(screen.queryByRole('row', { name: 'Synthetic Child' })).not.toBeInTheDocument();
  await screen.findByRole('alert');
  expect(screen.queryByRole('table', { name: 'Room roster records' })).not.toBeInTheDocument();
  vi.mocked(axios.get).mockImplementation(get);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('table', { name: 'Room roster records' });
  expect(screen.queryByRole('row', { name: 'Other Child' })).not.toBeInTheDocument();
});

test('refresh and returning to the app update transfers and enrollment occupancy', async () => {
  show();
  await screen.findByRole('table', { name: 'Room roster records' });
  roster = roster.map(row => row.id === 'second' ? { ...row, roomId: otherRoom.id } : row.id === 'first' ? { ...row, active: false } : row);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roster' }));
  await screen.findByText('No actively enrolled children are assigned to this room.');
  expect(screen.getByRole('region', { name: 'Room enrollment' })).toHaveTextContent('0 active children');
  roster = roster.map(row => row.id === 'first' ? { ...row, active: true } : row);
  fireEvent.focus(window);
  await screen.findByRole('row', { name: 'Synthetic Child' });
  expect(screen.getByRole('region', { name: 'Room enrollment' })).toHaveTextContent('1 active child');
});

test('pagination reaches every assigned child without changing occupancy', async () => {
  roster = Array.from({ length: 26 }, (_, index) => ({ ...child, id: 'child-' + index, firstName: 'Child' + index }));
  show();
  await screen.findByRole('row', { name: 'Child0 Child' });
  expect(screen.getByRole('region', { name: 'Room enrollment' })).toHaveTextContent('26 active children');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('row', { name: 'Child25 Child' });
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(screen.getByRole('region', { name: 'Room enrollment' })).toHaveTextContent('26 active children');
  roster = [roster[0]];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roster' }));
  await screen.findByRole('row', { name: 'Child0 Child' });
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
});

test('viewers can read room profiles without receiving child or room edit controls', async () => {
  show('/rooms/sunflower', 'viewer');
  await screen.findByRole('table', { name: 'Room roster records' });
  expect(screen.queryByRole('button', { name: /Add child|Edit|End enrollment|Archive/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'View Synthetic Child' })[0]);
  await screen.findByText('Uses a blue cup.');
  expect(axios.post).not.toHaveBeenCalled();
  expect(axios.put).not.toHaveBeenCalled();
});


test('automatic room refresh preserves a document draft and closing asks before discarding it', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  show();
  await screen.findByRole('table', { name: 'Room roster records' });
  fireEvent.click(screen.getAllByRole('button', { name: 'View Synthetic Child' })[0]);
  fireEvent.click(await screen.findByRole('button', { name: 'Add document' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Unsaved room form' } });
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Room enrollment' })).toBeInTheDocument());
  expect(screen.getByLabelText('Document title')).toHaveValue('Unsaved room form');
  fireEvent.click(screen.getByRole('button', { name: 'Back to room roster' }));
  expect(screen.getByLabelText('Document title')).toHaveValue('Unsaved room form');
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Back to room roster' }));
  await screen.findByRole('table', { name: 'Room roster records' });
});


test('a failed background roster refresh preserves the document draft in the open profile', async () => {
  show(); await screen.findByRole('table', { name: 'Room roster records' });
  fireEvent.click(screen.getAllByRole('button', { name: 'View Synthetic Child' })[0]);
  fireEvent.click(await screen.findByRole('button', { name: 'Add document' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Retained during outage' } });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation((url, config) => url.endsWith('/children') ? Promise.reject(new Error('Unavailable')) : get(url, config));
  fireEvent.focus(window);
  await screen.findByText('Could not load this room roster.');
  expect(screen.getByLabelText('Document title')).toHaveValue('Retained during outage');
});
