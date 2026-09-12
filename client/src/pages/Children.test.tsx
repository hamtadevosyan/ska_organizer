import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Children from './Children';
import { ChildForm } from '../components/children/ChildForm';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { ChildRecord } from '../api/children';
import type { Room } from '../api/rooms';

vi.mock('axios');
const room: Room = { id: 'room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 72, active: true,
  capacity: 2, assignedChildCount: 1, availablePlaces: 1, overCapacity: false, needsConfiguration: false };
const child: ChildRecord = { id: 'child', firstName: 'Synthetic', lastName: 'Child', dateOfBirth: '2022-01-15',
  preferredName: 'Sunny', active: true, roomId: room.id, notes: 'Uses a blue cup.' };
let roster: ChildRecord[];
beforeEach(() => {
  vi.resetAllMocks(); roster = [{ ...child }];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.isAxiosError).mockImplementation((error): error is import('axios').AxiosError => !!error && typeof error === 'object' && 'response' in error);
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/rooms')) return { data: { data: [room] } };
    if (url.endsWith('/profile')) return { data: { child: roster.find((row) => url.includes('/' + row.id + '/')), room, recentAttendance: [] } };
    const { q = '', roomId, active = 'true', page = 1, pageSize = 25 } = config?.params || {};
    const matches = roster.filter((row) => (active === 'all' || row.active === (active === 'true')) &&
      (!roomId || (roomId === 'unassigned' ? row.roomId === null : row.roomId === roomId)) &&
      (row.firstName + ' ' + row.lastName + ' ' + row.preferredName).toLowerCase().includes(q.toLowerCase()));
    return { data: { items: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length } };
  });
  vi.mocked(axios.post).mockImplementation(async (_url, values) => {
    const saved = { id: 'new-child', ...values as object } as ChildRecord; roster.push(saved); return { data: saved };
  });
  vi.mocked(axios.put).mockImplementation(async (url, values) => {
    const previous = roster.find((row) => url.endsWith('/' + row.id) || url.endsWith('/' + row.id + '/enrollment'))!;
    const saved = { ...previous, ...values as object }; roster = roster.map((row) => row.id === saved.id ? saved : row); return { data: saved };
  });
});
function fillNames(firstName = 'New', lastName = 'Child') {
  fireEvent.change(screen.getByRole('textbox', { name: /^First name/ }), { target: { value: firstName } });
  fireEvent.change(screen.getByRole('textbox', { name: /^Last name/ }), { target: { value: lastName } });
  fireEvent.change(screen.getByLabelText(/^Date of birth/), { target: { value: '2023-03-15' } });
}

test('adding a child validates required fields and birth date before saving', async () => {
  render(<SignedIn><Children /></SignedIn>);
  await screen.findByRole('row', { name: 'Synthetic Child' });
  fireEvent.click(screen.getByRole('button', { name: 'Add child' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Correct the highlighted');
  fillNames();
  fireEvent.change(screen.getByLabelText(/^Date of birth/), { target: { value: '9999-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/^Date of birth/), { target: { value: '2023-03-15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  await screen.findByText('New Child saved.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/children'), expect.objectContaining({ firstName: 'New', dateOfBirth: '2023-03-15', roomId: null, active: true }));
  await screen.findByRole('row', { name: 'New Child' });
});

test('filters query preferred names, rooms and inactive enrollment', async () => {
  roster.push({ ...child, id: 'inactive', firstName: 'Inactive', active: false });
  render(<SignedIn><Children /></SignedIn>);
  await screen.findByRole('row', { name: 'Synthetic Child' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Enrollment' }), { target: { value: 'false' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter by room' }), { target: { value: room.id } });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search children' }), { target: { value: 'sunny' } });
  await screen.findByRole('row', { name: 'Inactive Child' });
  expect(screen.queryByRole('row', { name: 'Synthetic Child' })).not.toBeInTheDocument();
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/api/children'), expect.objectContaining({ params: expect.objectContaining({ q: 'sunny', roomId: room.id, active: 'false', page: 1 }) }));
});

test('possible duplicates require review and allow deliberate same-name records', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 409, data: { error: { code: 'CHILD_DUPLICATE_WARNING', message: 'Review duplicates.', duplicates: [child] } } } });
  render(<SignedIn><Children /></SignedIn>);
  await screen.findByRole('row', { name: 'Synthetic Child' });
  fireEvent.click(screen.getByRole('button', { name: 'Add child' })); fillNames('Synthetic');
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  await screen.findByText('Review possible duplicate records');
  const save = screen.getByRole('button', { name: 'Save child' });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the matching records/ }));
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText(/^Date of birth/), { target: { value: '2023-03-16' } });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the matching records/ }));
  fireEvent.click(save);
  await screen.findByText('Synthetic Child saved.');
  expect(axios.post).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ confirmDuplicate: true, dateOfBirth: '2023-03-16' }));
});

test('ending enrollment preserves the record for the inactive roster and profile', async () => {
  render(<SignedIn><Children /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'End enrollment for Synthetic Child' }));
  await screen.findByText('Enrollment ended for Synthetic Child. History was preserved.');
  await waitFor(() => expect(screen.queryByRole('row', { name: 'Synthetic Child' })).not.toBeInTheDocument());
  fireEvent.change(screen.getByRole('combobox', { name: 'Enrollment' }), { target: { value: 'false' } });
  const row = await screen.findByRole('row', { name: 'Synthetic Child' });
  expect(within(row).getByText('Inactive')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'View Synthetic Child' }));
  await screen.findByText('Uses a blue cup.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/api/children/child/enrollment'), { active: false });
});

test('read-only accounts can view a profile without enrollment edit controls', async () => {
  render(<SignedIn account={{ ...testAccount, role: 'viewer' }}><Children /></SignedIn>);
  const row = await screen.findByRole('row', { name: 'Synthetic Child' });
  expect(screen.queryByRole('button', { name: 'Add child' })).not.toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: /Edit|End enrollment/ })).not.toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'View Synthetic Child' }));
  await screen.findByText('Uses a blue cup.');
});

test('reactivation prompts when the retained room has become full', async () => {
  roster = [{ ...child, active: false }];
  const onSaved = vi.fn();
  render(<ChildForm child={roster[0]} rooms={[{ ...room, capacity: 1 }]} loadingRooms={false} onSaved={onSaved} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Active enrollment' }));
  expect(screen.getByText('This enrollment exceeds the room capacity.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save child' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I acknowledge the capacity warning/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/api/children/child'), expect.objectContaining({ active: true, roomId: room.id, confirmOverCapacity: true }));
});

test('reactivation requires an available room or an explicit unassigned selection', async () => {
  roster = [{ ...child, active: false }];
  render(<ChildForm child={roster[0]} rooms={[{ ...room, active: false }]} loadingRooms={false} onSaved={() => {}} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Active enrollment' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  expect(axios.put).not.toHaveBeenCalled();
  expect(screen.getByText('Choose an active room or leave this child unassigned.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: /^Room/ }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save child' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/api/children/child'), expect.objectContaining({ active: true, roomId: null })));
});

test('pagination can reach children after the first page', async () => {
  roster = Array.from({ length: 26 }, (_, index) => ({ ...child, id: 'child-' + index, firstName: 'Child' + index }));
  render(<SignedIn><Children /></SignedIn>);
  await screen.findByRole('row', { name: 'Child0 Child' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('row', { name: 'Child25 Child' });
  expect(screen.queryByRole('row', { name: 'Child0 Child' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});
