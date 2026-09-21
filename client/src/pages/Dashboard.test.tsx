import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Dashboard from './Dashboard';
import type { DashboardMetrics } from '../api/dashboard';

vi.mock('axios');
const empty = (): DashboardMetrics => ({ today: '2026-09-14', date: '2026-09-14', weekStart: '2026-09-14',
  timeZone: 'America/Los_Angeles', takenAt: '2026-09-14T17:00:00Z', sections: {
    enrollment: { data: { count: 0 } }, attendance: { data: { count: 0, reviewRequired: false } }, staff: { data: { count: 0 } },
    inventory: { data: { total: 0, low: 0, out: 0 } }, meals: { data: { savedAt: null, items: [] } },
    activities: { data: { rooms: [] } }, changes: { data: [] },
  } });
let data: DashboardMetrics;
const show = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);
beforeEach(() => { vi.resetAllMocks(); data = empty(); vi.mocked(axios.get).mockImplementation(async () => ({ data: structuredClone(data) })); });

test('empty records display real zeros, useful empty states and links without sample content', async () => {
  show();
  const enrolled = await screen.findByRole('region', { name: 'Enrolled children' });
  expect(within(enrolled).getByText('0')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Present now' })).getByText('0')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Active Staff' })).getByText('0')).toBeInTheDocument();
  expect(screen.getByText('No inventory items yet.')).toBeInTheDocument();
  expect(screen.getByText('No meals saved for this date.')).toBeInTheDocument();
  expect(screen.getByText('No rooms or saved activities for this date.')).toBeInTheDocument();
  expect(screen.getByText('No operational changes recorded yet.')).toBeInTheDocument();
  for (const [name, path] of [['Open children', '/children'], ['Open attendance', '/attendance'], ['Open staff', '/staff'],
    ['Open meal planner', '/meals'], ['Open activity planner', '/activities']]) {
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', path);
  }
  expect(screen.getByRole('link', { name: /Out of stock/ })).toHaveAttribute('href', '/inventory?status=out');
  expect(screen.getByRole('link', { name: /Running low/ })).toHaveAttribute('href', '/inventory?status=low');
  expect(screen.queryByText(/Outdoor playtime completed|42|120/)).not.toBeInTheDocument();
});

test('saved meals, unlimited room activities, legacy times and recent recorded changes are shown', async () => {
  data.sections.meals = { data: { savedAt: data.takenAt, items: [{ slot: 'breakfast', label: 'Breakfast', name: 'Saved oatmeal' }] } };
  data.sections.activities = { data: { rooms: [{ id: 'room', name: 'Sunflowers', active: false, savedAt: data.takenAt,
    entries: Array.from({ length: 8 }, (_, i) => ({ id: 'entry-' + i, name: 'Saved activity ' + i, startTime: null, endTime: null, timeBlock: 'morning' })) }] } };
  data.sections.changes = { data: [{ id: 'event', label: 'Stock amount updated', href: '/inventory', occurredAt: data.takenAt }] };
  show();
  await screen.findByText('Saved oatmeal');
  expect(screen.getAllByText(/^Saved activity/)).toHaveLength(8);
  expect(screen.getByText('Archived room')).toBeInTheDocument();
  expect(screen.getAllByText('Morning')).toHaveLength(8);
  expect(screen.getByRole('link', { name: 'Stock amount updated' })).toHaveAttribute('href', '/inventory');
});

test('an uncertain attendance count has a review action and a failed section retries without a fabricated zero', async () => {
  data.sections.attendance = { data: { count: null, reviewRequired: true } };
  data.sections.staff = { error: 'Could not load staff. Please try again.' };
  show();
  await screen.findByText('Check attendance');
  const attendance = screen.getByRole('region', { name: 'Present now' });
  expect(within(attendance).queryByText('0')).not.toBeInTheDocument();
  expect(within(attendance).getByRole('link', { name: 'Open attendance' })).toHaveAttribute('href', '/attendance');
  expect(within(screen.getByRole('region', { name: 'Active Staff' })).queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByText('No meals saved for this date.')).toBeInTheDocument();
  data.sections.staff = { data: { count: 7 } };
  fireEvent.click(screen.getByRole('button', { name: 'Retry active staff' }));
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Active Staff' })).getByText('7')).toBeInTheDocument());
});

test('refresh failures hide old counts and a retry loads the changed records', async () => {
  data.sections.enrollment = { data: { count: 9 } };
  show(); await screen.findByRole('region', { name: 'Enrolled children' });
  vi.mocked(axios.get).mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('region', { name: 'Enrolled children' })).not.toBeInTheDocument();
  data.sections.enrollment = { data: { count: 10 } };
  fireEvent.click(screen.getByRole('button', { name: 'Retry dashboard' }));
  await waitFor(() => expect(within(screen.getByRole('region', { name: 'Enrolled children' })).getByText('10')).toBeInTheDocument());
});

test('date changes cancel old responses and Today follows the server date after midnight', async () => {
  show(); await screen.findByRole('region', { name: 'Meals' });
  let resolveOld!: (value: { data: DashboardMetrics }) => void;
  vi.mocked(axios.get).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  fireEvent.change(screen.getByLabelText('Plan date'), { target: { value: '2026-09-15' } });
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/dashboard'), expect.objectContaining({ params: { date: '2026-09-15' } })));
  const oldSignal = vi.mocked(axios.get).mock.calls.at(-1)![1]!.signal!;
  data.date = '2026-09-16';
  data.sections.meals = { data: { savedAt: data.takenAt, items: [{ slot: 'lunch', label: 'Lunch', name: 'Wednesday soup' }] } };
  fireEvent.change(screen.getByLabelText('Plan date'), { target: { value: '2026-09-16' } });
  await screen.findByText('Wednesday soup');
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolveOld({ data: { ...empty(), date: '2026-09-15' } }));
  expect(screen.getByText('Wednesday soup')).toBeInTheDocument();
  data = { ...empty(), today: '2026-09-17', date: '2026-09-17' };
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  await screen.findByText('Today’s plans');
  expect(screen.getByLabelText('Plan date')).toHaveValue('2026-09-17');
  expect(vi.mocked(axios.get).mock.calls.at(-1)![1]!.params).toEqual({});
});

test('unmount aborts an outstanding request', () => {
  vi.mocked(axios.get).mockImplementation(() => new Promise(() => {}));
  const view = show();
  const signal = vi.mocked(axios.get).mock.calls.at(-1)![1]!.signal!;
  view.unmount(); expect(signal.aborted).toBe(true);
});
