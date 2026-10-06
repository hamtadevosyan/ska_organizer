import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { MemoryRouter } from 'react-router-dom';
import Rooms from './Rooms';
import Activities from './Activities';
import { RoomSelect } from '../components/rooms/RoomSelect';
import { RoomAssignments } from '../components/rooms/RoomAssignments';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import type { Room } from '../api/rooms';

vi.mock('axios');
const sunflower: Room = { id: 'database-room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 1,
  active: true, needsConfiguration: false, assignedChildCount: 1, availablePlaces: 0, overCapacity: false };
let catalog: Room[];
const response = (data: unknown) => ({ data: { data } });
beforeEach(() => {
  vi.resetAllMocks();
  catalog = [{ ...sunflower }];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.get).mockImplementation(async (url) => {
    if (url.endsWith('/assignment-preview')) return response({ room: sunflower, childId: 'child', proposedChildCount: 2, exceedsCapacity: true, alreadyAssigned: false });
    if (url.endsWith('/children')) return { data: { items: [{ id: 'child', firstName: 'Synthetic', lastName: 'Child', roomId: null }], total: 1 } };
    if (url.endsWith('/activity/generate')) return response([{ day: 'Monday', activity: 'Room activity' }]);
    return response(catalog);
  });
  vi.mocked(axios.post).mockImplementation(async (_url, values) => {
    const saved = { ...sunflower, ...values as object, id: 'new-room', assignedChildCount: 0 };
    catalog.push(saved); return response(saved);
  });
  vi.mocked(axios.put).mockImplementation(async (_url, values) => {
    catalog = [{ ...catalog[0], ...values as object }];
    return response(catalog[0]);
  });
});

test('room form validates fields before saving numeric settings and refreshes the list', async () => {
  render(<SignedIn><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  await screen.findByRole('article', { name: 'Sunflower' });
  fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Correct the highlighted');
  fireEvent.change(screen.getByRole('textbox', { name: /^Room name/ }), { target: { value: '  New class  ' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /^Minimum age/ }), { target: { value: '24' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /^Maximum age/ }), { target: { value: '60' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /^Configured capacity/ }), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  await screen.findByText('Room created.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/rooms'), { name: 'New class', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, active: true });
  await screen.findByRole('article', { name: 'New class' });
});

test('archiving keeps the room in the archive view and preserves its assigned count', async () => {
  render(<SignedIn><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  const archive = await screen.findByRole('button', { name: 'Archive Sunflower' });
  await waitFor(() => expect(archive).toBeEnabled());
  fireEvent.click(archive);
  await screen.findByText('Room archived. Existing assignments and history were preserved.');
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Sunflower' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived rooms' }));
  const card = await screen.findByRole('article', { name: 'Sunflower' });
  expect(within(card).getByText('Archived')).toBeInTheDocument();
  expect(card).toHaveTextContent('1 / 1 children assigned');
});

test('read-only users can see room counts without management or assignment controls', async () => {
  render(<SignedIn account={{ ...testAccount, role: 'viewer' }}><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  await screen.findByRole('article', { name: 'Sunflower' });
  expect(screen.getByRole('link', { name: 'View children in Sunflower' })).toHaveAttribute('href', '/rooms/database-room');
  expect(screen.queryByRole('button', { name: 'Add room' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit Sunflower' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Assign child' })).not.toBeInTheDocument();
});

test('archived selections are retained but cannot be newly assigned', () => {
  render(<RoomSelect aria-label="Room" rooms={[sunflower, { ...sunflower, id: 'old', name: 'Old room', active: false }]} value="old" onChange={() => {}} />);
  expect(screen.getByRole('combobox')).toHaveValue('old');
  expect(screen.getByRole('option', { name: 'Old room (archived)' })).toBeDisabled();
});

test('a capacity warning must be acknowledged before assigning a child', async () => {
  render(<RoomAssignments rooms={[sunflower]} onChanged={async () => {}} />);
  await screen.findByRole('option', { name: 'Synthetic Child' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Child' }), { target: { value: 'child' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Room for assignment' }), { target: { value: sunflower.id } });
  await screen.findByText('This assignment exceeds the configured room capacity.');
  expect(screen.getByRole('button', { name: 'Assign child' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I acknowledge the capacity warning/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Assign child' }));
  await screen.findByText('Room assignment saved.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/api/children/child/room'), { roomId: sunflower.id, confirmOverCapacity: true });
});

test('activity plans wait for a persisted room selection and send its ID', async () => {
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/activity')) return response([]);
    if (url.endsWith('/schedule/plan')) return response({ roomId: sunflower.id, weekStart: config?.params.weekStart, version: 0, savedAt: null, entries: [], materials: [] });
    return response(catalog);
  });
  vi.mocked(axios.post).mockResolvedValue(response({ materials: [] }));
  render(<SignedIn><Activities /></SignedIn>);
  await screen.findByRole('option', { name: 'Sunflower' });
  expect(vi.mocked(axios.get).mock.calls.some(([url]) => url.endsWith('/schedule/plan'))).toBe(false);
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: sunflower.id } });
  await screen.findByText('No schedule saved yet');
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/api/schedule/plan'),
    expect.objectContaining({ params: expect.objectContaining({ roomId: sunflower.id }) }));
});

test.each([[0, 0], [24, 24], [60, 24]])('create and edit prevent invalid room ages %i–%i before calling the API', async (minimum, maximum) => {
  render(<SignedIn><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  await screen.findByRole('article', { name: 'Sunflower' });
  fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
  fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Synthetic invalid room' } });
  fireEvent.change(screen.getByLabelText('Minimum age (months)'), { target: { value: String(minimum) } });
  fireEvent.change(screen.getByLabelText('Maximum age (months)'), { target: { value: String(maximum) } });
  fireEvent.change(screen.getByLabelText('Configured capacity'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Maximum age (months)', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Maximum age (months)', { exact: true })).toHaveAccessibleName('Maximum age (months)');
  expect(screen.getByLabelText('Maximum age (months)', { exact: true })).toHaveAccessibleDescription('Maximum age must be greater than minimum age.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Sunflower' }));
  fireEvent.change(screen.getByLabelText('Minimum age (months)'), { target: { value: String(minimum) } });
  fireEvent.change(screen.getByLabelText('Maximum age (months)'), { target: { value: String(maximum) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  expect(axios.put).not.toHaveBeenCalled();
  expect(screen.getByRole('article', { name: 'Sunflower' })).toHaveTextContent('24–60 months');
});

test('valid zero minimum creates a room and corrects a legacy equal-age room under its existing ID', async () => {
  catalog = [{ ...sunflower, ageMinMonths: 24, ageMaxMonths: 24, needsConfiguration: true }];
  render(<SignedIn><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  const card = await screen.findByRole('article', { name: 'Sunflower' });
  expect(card).toHaveTextContent('Needs setup');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Sunflower' }));
  fireEvent.change(screen.getByLabelText('Maximum age (months)'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  await screen.findByText('Room updated.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/api/rooms/database-room'), expect.objectContaining({ ageMinMonths: 24, ageMaxMonths: 60 }));
  expect(card).toHaveTextContent('1 / 1 children assigned');
  fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
  fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Synthetic infant room' } });
  fireEvent.change(screen.getByLabelText('Minimum age (months)'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Maximum age (months)'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Configured capacity'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  await screen.findByText('Room created.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/rooms'), expect.objectContaining({ ageMinMonths: 0, ageMaxMonths: 12 }));
});

test('all room field names stay stable when errors appear and correcting the same form succeeds', async () => {
  render(<SignedIn><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  await screen.findByRole('article', { name: 'Sunflower' });
  fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  for (const label of ['Room name', 'Minimum age (months)', 'Maximum age (months)', 'Configured capacity']) {
    const input = screen.getByLabelText(label, { exact: true });
    expect(input).toHaveAccessibleName(label);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription();
  }
  fireEvent.change(screen.getByLabelText('Room name', { exact: true }), { target: { value: 'Corrected synthetic room' } });
  fireEvent.change(screen.getByLabelText('Minimum age (months)', { exact: true }), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Maximum age (months)', { exact: true }), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Configured capacity', { exact: true }), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  await screen.findByText('Room created.');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/rooms'), expect.objectContaining({ ageMinMonths: 0, ageMaxMonths: 12 }));
});

test('editing can correct an age validation error through its unchanged exact label', async () => {
  render(<SignedIn><MemoryRouter><Rooms /></MemoryRouter></SignedIn>);
  await screen.findByRole('article', { name: 'Sunflower' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit Sunflower' }));
  fireEvent.change(screen.getByLabelText('Maximum age (months)', { exact: true }), { target: { value: '24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  const maximum = screen.getByLabelText('Maximum age (months)', { exact: true });
  expect(maximum).toHaveAccessibleName('Maximum age (months)');
  expect(maximum).toHaveAccessibleDescription('Maximum age must be greater than minimum age.');
  expect(axios.put).not.toHaveBeenCalled();
  fireEvent.change(maximum, { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
  await screen.findByText('Room updated.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/api/rooms/database-room'), expect.objectContaining({ ageMinMonths: 24, ageMaxMonths: 60 }));
});
