import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Staff from './Staff';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { Room } from '../api/rooms';
import type { StaffDetails, StaffMember } from '../api/staff';

vi.mock('axios');
const room: Room = { id: 'room-one', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12,
  active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const person: StaffMember = { id: 'staff-one', name: 'Synthetic Teacher', role: 'Teacher', active: true,
  roomId: room.id, room: { id: room.id, name: room.name, active: room.active }, version: 1,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
let people: StaffMember[];
let rooms: Room[];
const response = (data: unknown) => ({ data: { data } });
const renderStaff = () => render(<SignedIn><Staff /></SignedIn>);
const edit = async () => fireEvent.click(await screen.findByRole('button', { name: 'Edit Synthetic Teacher' }));

beforeEach(() => {
  vi.resetAllMocks();
  people = [structuredClone(person)]; rooms = [structuredClone(room)];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  // Route-based mocks keep room lookups from consuming staff responses.
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/rooms')) return response(rooms);
    if (url.endsWith('/staff')) {
      const params = config?.params as { active: string; q?: string; roomId?: string; page: number; pageSize: number };
      const matches = people.filter((item) => (params.active === 'all' || item.active === (params.active === 'true')) &&
        (!params.q || item.name.toLowerCase().includes(params.q.toLowerCase())) &&
        (!params.roomId || item.roomId === (params.roomId === 'unassigned' ? null : params.roomId)));
      return { data: { items: matches.slice((params.page - 1) * params.pageSize, params.page * params.pageSize),
        total: matches.length, activeTotal: people.filter((item) => item.active).length, page: params.page, pageSize: params.pageSize } };
    }
    if (url.includes('/staff/')) return response(people.find((item) => url.endsWith('/' + item.id)));
    throw new Error('Unexpected GET: ' + url);
  });
  vi.mocked(axios.post).mockImplementation(async (url, payload) => {
    if (!url.endsWith('/staff')) throw new Error('Unexpected POST: ' + url);
    const saved = { ...person, ...payload as StaffDetails, id: 'staff-new', room: null };
    people.push(saved); return response(saved);
  });
  vi.mocked(axios.put).mockImplementation(async (url, payload) => {
    const previous = people.find((item) => url.endsWith('/' + item.id));
    if (!previous) throw new Error('Unexpected PUT: ' + url);
    const saved = { ...previous, ...payload as Partial<StaffDetails>, version: previous.version + 1 };
    const assigned = rooms.find((item) => item.id === saved.roomId);
    saved.room = assigned ? { id: assigned.id, name: assigned.name, active: assigned.active } : null;
    people = people.map((item) => item.id === saved.id ? saved : item);
    return response(saved);
  });
});

test('validates and creates a staff record without credentials or app-role controls', async () => {
  renderStaff();
  await screen.findByRole('rowheader', { name: person.name });
  fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save staff' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Correct the highlighted staff details.');
  fireEvent.change(screen.getByRole('textbox', { name: /^Full name/ }), { target: { value: '  New teacher  ' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^Job role/ }), { target: { value: 'Teacher' } });
  expect(screen.queryByLabelText('Password', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Job role' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  await screen.findByRole('rowheader', { name: 'New teacher' });
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/staff'), { name: 'New teacher', role: 'Teacher', active: true, roomId: null });
  expect(screen.getByText(/2 active staff across all rooms/)).toBeInTheDocument();
});

test('deactivation preserves the record and assignment, updates totals, and supports reactivation', async () => {
  renderStaff();
  fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Synthetic Teacher' }));
  await screen.findByText(/Synthetic Teacher deactivated/);
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Status' })).toBeEnabled());
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/staff/staff-one'), { active: false, version: 1 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'false' } });
  const row = (await screen.findByRole('rowheader', { name: person.name })).closest('tr')!;
  expect(within(row).getByText('Inactive')).toBeInTheDocument();
  expect(within(row).getByText('Sunflower')).toBeInTheDocument();
  expect(screen.getByText(/0 active staff across all rooms/)).toBeInTheDocument();
  await edit();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Active staff member' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  await waitFor(() => expect(people[0]).toMatchObject({ id: person.id, roomId: room.id, active: true, version: 3 }));
  await screen.findByText(/1 active staff across all rooms/);
  expect(screen.queryByRole('rowheader', { name: person.name })).not.toBeInTheDocument();
});

test('filters by name, status and room while preserving an unsaved edit', async () => {
  people.push({ ...person, id: 'unassigned', name: 'Another Teacher', roomId: null, room: null });
  renderStaff();
  await edit();
  fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Unsaved name' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter by room' }), { target: { value: 'unassigned' } });
  await screen.findByRole('rowheader', { name: 'Another Teacher' });
  await waitFor(() => expect(screen.queryByRole('rowheader', { name: person.name })).not.toBeInTheDocument());
  expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Unsaved name');
  expect(screen.getByText(/2 active staff across all rooms · 1 matching record/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search staff' }), { target: { value: 'Missing person' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('No staff match these filters.');
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  await screen.findByRole('rowheader', { name: person.name });
  expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Unsaved name');
});

test('retains an archived assignment and requires an active room or unassigned when reactivating', async () => {
  rooms[0].active = false;
  people[0] = { ...person, active: false, room: { ...person.room!, active: false } };
  renderStaff();
  await screen.findByText('No staff match these filters.');
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'false' } });
  await edit();
  expect(screen.getByRole('combobox', { name: 'Assigned room (optional)' })).toHaveValue(room.id);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Active staff member' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  expect(axios.put).not.toHaveBeenCalled();
  expect(screen.getByText('Choose an active, configured room or leave this person unassigned.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: /^Assigned room/ }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/staff/staff-one'), expect.objectContaining({ active: true, roomId: null, version: 1 })));
  await screen.findByText(/Staff record updated/);
});

test('a conflict retains typed edits until the user explicitly reloads the latest record', async () => {
  renderStaff();
  await edit();
  fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'My unsaved name' } });
  people[0] = { ...person, role: 'Other administrator update', version: 2 };
  vi.mocked(axios.isAxiosError).mockReturnValue(true);
  vi.mocked(axios.put).mockRejectedValueOnce({ response: { status: 409, data: { error: {
    code: 'STAFF_CONFLICT', message: 'This staff record changed elsewhere. Reload it and review the latest details before saving.',
  } } } });
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  await screen.findByRole('button', { name: 'Reload staff record' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reload staff record' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('My unsaved name');
  expect(screen.getByRole('button', { name: 'Save staff' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload staff record' }));
  await screen.findByText('Latest staff details loaded. Review them before saving.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save staff' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Job role' })).toHaveValue('Other administrator update');
  fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Reviewed name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save staff' }));
  await screen.findByRole('rowheader', { name: 'Reviewed name' });
  expect(axios.put).toHaveBeenLastCalledWith(expect.stringContaining('/staff/staff-one'), expect.objectContaining({ version: 2, name: 'Reviewed name' }));
});

test.each(['editor', 'viewer'] as const)('%s can read the directory without staff management controls', async (role) => {
  render(<SignedIn account={{ ...testAccount, role }}><Staff /></SignedIn>);
  await screen.findByRole('rowheader', { name: person.name });
  expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Deactivate / })).not.toBeInTheDocument();
});

test('a late list response cannot replace the selected status filter results', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let resolveOld!: (value: { data: unknown }) => void;
  let first = true;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/staff') && first) {
      first = false;
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    return get(url, config);
  });
  renderStaff();
  await waitFor(() => expect(resolveOld).toBeDefined());
  fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'false' } });
  await screen.findByText('No staff match these filters.');
  await act(async () => resolveOld({ data: { items: [person], total: 1, activeTotal: 1, page: 1, pageSize: 25 } }));
  expect(screen.queryByRole('rowheader', { name: person.name })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('false');
});

test('pagination keeps the facility total and moves back after deactivating the last row on a page', async () => {
  people = Array.from({ length: 26 }, (_, index) => ({ ...person, id: 'staff-' + index, name: 'Teacher ' + index }));
  renderStaff();
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
  await screen.findByText('Page 2 of 2');
  fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Teacher 25' }));
  await screen.findByText(/25 active staff across all rooms/);
  await screen.findByRole('rowheader', { name: 'Teacher 0' });
  expect(screen.queryByRole('navigation', { name: 'Staff pages' })).not.toBeInTheDocument();
});

test('failed directory loads expose retry controls and recover to actual counts', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let failStaff = true;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/staff') && failStaff) { failStaff = false; return Promise.reject(new Error('Unavailable')); }
    return get(url, config);
  });
  renderStaff();
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh staff' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh staff' }));
  await screen.findByRole('rowheader', { name: person.name });
  expect(screen.getByText(/1 active staff across all rooms/)).toBeInTheDocument();
});
