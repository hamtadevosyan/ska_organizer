import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import Attendance from './Attendance';
import { AttendanceCorrectionForm } from '../components/attendance/AttendanceCorrectionForm';
import type { AttendanceRecord, DailyAttendance } from '../api/attendance';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';

vi.mock('axios');
const zone = 'America/Los_Angeles';
const room = { id: 'daily-room', name: 'Daily room', active: true };
const child = { id: 'daily-child', firstName: 'Synthetic', lastName: 'Attendance', preferredName: null, roomId: room.id, active: true };
const visit: AttendanceRecord = { id: 'visit', childId: child.id, roomId: room.id, checkIn: '2026-09-08T16:00:00.000Z', checkOut: null, recordedBy: 'operator', version: 1, voided: false, needsReview: false };
const baseline = (): DailyAttendance => ({ date: '2026-09-08', today: '2026-09-08', serverNow: '2026-09-08T17:00:00.000Z', timeZone: zone,
  room: null, rooms: [room], presentCount: 0, attendedCount: 0,
  rows: [{ childId: child.id, child, records: [], openVisits: [], canCheckIn: true, checkInRoomId: room.id }] });
let daily: DailyAttendance;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); daily = baseline();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.isAxiosError).mockImplementation((error): error is import('axios').AxiosError => !!error && typeof error === 'object' && 'response' in error);
  vi.mocked(axios.get).mockImplementation(async (url) => ({ data: url.endsWith('/corrections') ? [] : url.endsWith('/visit') ? visit : structuredClone(daily) }));
  vi.mocked(axios.post).mockImplementation(async (url) => {
    const record = { ...visit, ...(url.endsWith('/checkout') ? { checkOut: '2026-09-08T17:00:00.000Z', version: 2 } : {}) };
    daily = { ...daily, attendedCount: 1, presentCount: record.checkOut ? 0 : 1, rows: [{ ...daily.rows[0], canCheckIn: !!record.checkOut, records: [record], openVisits: record.checkOut ? [] : [record] }] };
    return { data: record };
  });
});
function renderPage(viewer = false, path = '/attendance') { return render(<MemoryRouter initialEntries={[path]}><SignedIn account={viewer ? { ...testAccount, role: 'viewer' } : testAccount}><Attendance /></SignedIn></MemoryRouter>); }

test('arrivals and departures refresh status and persist through remount', async () => {
  const view = renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Synthetic Attendance' }));
  await screen.findByText('Present', { exact: true });
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/checkin'), expect.objectContaining({ childId: child.id, roomId: room.id, date: daily.today, requestId: expect.stringMatching(/^[a-f0-9]{32}$/) }));
  view.unmount(); renderPage();
  const checkout = await screen.findByRole('button', { name: 'Check out Synthetic Attendance' });
  fireEvent.click(checkout);
  await screen.findByText('Checked out', { exact: true });
  expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/visit/checkout'), { date: daily.today, version: 1 });
  expect(await screen.findByRole('button', { name: 'Check in Synthetic Attendance' })).toBeEnabled();
});

test('keeps a retry key after a network failure and uses a fresh key for a later visit', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Connection interrupted'));
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Synthetic Attendance' }));
  await screen.findByRole('alert');
  const firstKey = (vi.mocked(axios.post).mock.calls[0][1] as { requestId: string }).requestId;
  fireEvent.click(screen.getByRole('button', { name: 'Check in Synthetic Attendance' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check out Synthetic Attendance' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Synthetic Attendance' }));
  await screen.findByText('Present', { exact: true });
  const arrivals = vi.mocked(axios.post).mock.calls.filter(([url]) => url.endsWith('/checkin'));
  expect((arrivals[1][1] as { requestId: string }).requestId).toBe(firstKey);
  expect((arrivals[2][1] as { requestId: string }).requestId).not.toBe(firstKey);
});

test('disables repeated clicks while a request is pending', async () => {
  const pending = deferred<{ data: AttendanceRecord }>();
  vi.mocked(axios.post).mockReturnValueOnce(pending.promise);
  renderPage();
  const button = await screen.findByRole('button', { name: 'Check in Synthetic Attendance' });
  fireEvent.click(button); fireEvent.click(button);
  expect(button).toBeDisabled(); expect(axios.post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ data: visit }));
});

test('a late response cannot overwrite a newly selected date', async () => {
  const old = deferred<{ data: DailyAttendance }>();
  vi.mocked(axios.get).mockReturnValueOnce(old.promise);
  renderPage();
  daily = { ...baseline(), date: '2026-09-07', presentCount: null, rows: [] };
  fireEvent.change(screen.getByLabelText(/^Attendance date/), { target: { value: '2026-09-07' } });
  await screen.findByText('No children or recorded visits match these filters.');
  await act(async () => old.resolve({ data: baseline() }));
  expect(screen.queryByRole('article', { name: 'Synthetic Attendance' })).not.toBeInTheDocument();
  expect(screen.getByLabelText(/^Attendance date/)).toHaveValue('2026-09-07');
});

test('viewers can read visits and history without mutation controls', async () => {
  daily.rows[0] = { ...daily.rows[0], records: [visit], openVisits: [visit], canCheckIn: false };
  renderPage(true);
  const row = await screen.findByRole('article', { name: 'Synthetic Attendance' });
  expect(within(row).queryByRole('button', { name: /Check in|Check out/ })).not.toBeInTheDocument();
  fireEvent.click(within(row).getByText('Visit details'));
  fireEvent.click(within(row).getByRole('button', { name: 'View history' }));
  await screen.findByText('No corrections recorded.');
  expect(screen.queryByRole('button', { name: 'Save correction' })).not.toBeInTheDocument();
});

test('a correction preserves unchanged instants, requires a reason and retains edits after conflict', async () => {
  const saved = vi.fn();
  vi.mocked(axios.put).mockRejectedValueOnce({ response: { status: 409, data: { error: { message: 'Attendance changed elsewhere.' } } } });
  render(<AttendanceCorrectionForm record={visit} name="Synthetic Attendance" rooms={[room]} zone={zone} canWrite onSaved={saved} onClose={() => {}} />);
  await screen.findByText('No corrections recorded.');
  expect((screen.getByLabelText('Check-in time') as HTMLInputElement).value).toMatch(/^2026-09-08T09:00(:00)?$/);
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(axios.put).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Correction reason'), { target: { value: 'Verified room from the paper log.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  await screen.findByText('Attendance changed elsewhere.');
  expect(screen.getByLabelText('Correction reason')).toHaveValue('Verified room from the paper log.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/visit/correction'), expect.objectContaining({ checkIn: visit.checkIn, version: 1, reason: 'Verified room from the paper log.' }));
  expect(saved).not.toHaveBeenCalled();
});

test('a failed record load leaves corrections disabled until a successful retry', async () => {
  vi.mocked(axios.get).mockRejectedValue(new Error('Offline'));
  render(<AttendanceCorrectionForm record={visit} name="Synthetic Attendance" rooms={[room]} zone={zone} canWrite onSaved={() => {}} onClose={() => {}} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
  expect(screen.queryByText('No corrections recorded.')).not.toBeInTheDocument();
  vi.mocked(axios.get).mockImplementation(async (url) => ({ data: url.endsWith('/corrections') ? [] : visit }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload current record' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save correction' })).toBeEnabled());
});

test('Find a child focuses search, matches preferred names, and restores keyboard focus after arrival', async () => {
  daily.rows[0].child = { ...child, preferredName: 'Sunny' };
  renderPage(false, '/attendance?find=child');
  const search = screen.getByRole('searchbox', { name: 'Search attendance' });
  expect(search).toHaveFocus();
  await screen.findByRole('article', { name: 'Synthetic Attendance' });
  fireEvent.change(search, { target: { value: 'Sunny' } });
  const row = screen.getByRole('article', { name: 'Synthetic Attendance' });
  fireEvent.click(within(row).getByRole('button', { name: 'Check in Synthetic Attendance' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check out Synthetic Attendance' })).toHaveFocus());
  fireEvent.change(search, { target: { value: 'Missing child' } });
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toHaveFocus();
  expect(screen.getByRole('article', { name: 'Synthetic Attendance' })).toBeInTheDocument();
});

test('historical visits expose history but never offer a live arrival or departure', async () => {
  daily = { ...baseline(), date: '2026-09-07', presentCount: null };
  daily.rows[0] = { ...daily.rows[0], canCheckIn: false, records: [{ ...visit, checkIn: '2026-09-07T16:00:00Z', checkOut: '2026-09-07T20:00:00Z' }] };
  renderPage(false, '/attendance?date=2026-09-07');
  const row = await screen.findByRole('article', { name: 'Synthetic Attendance' });
  expect(within(row).queryByRole('button', { name: /Check in|Check out/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Here now')).not.toBeInTheDocument();
  fireEvent.click(within(row).getByText('Visit details'));
  expect(within(row).getByRole('button', { name: 'Correct / history' })).toBeVisible();
  expect(axios.post).not.toHaveBeenCalled();
});

test('an older open visit stays expanded for review and has only its record-specific checkout', async () => {
  const older = { ...visit, checkIn: '2026-09-07T16:00:00Z', needsReview: true };
  daily.rows[0] = { ...daily.rows[0], records: [], openVisits: [older], canCheckIn: false };
  renderPage();
  const row = await screen.findByRole('article', { name: 'Synthetic Attendance' });
  expect(within(row).getByText('Needs review')).toBeVisible();
  expect(within(row).getByText('Visit details').closest('details')).toHaveAttribute('open');
  expect(within(row).getAllByRole('button', { name: 'Check out Synthetic Attendance' })).toHaveLength(1);
  fireEvent.click(within(row).getByRole('button', { name: 'Check out Synthetic Attendance' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/visit/checkout'), { date: daily.today, version: older.version }));
});

test('a failed refresh hides the prior roster and recovery reloads it', async () => {
  renderPage();
  await screen.findByRole('article', { name: 'Synthetic Attendance' });
  vi.mocked(axios.get).mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh attendance' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check in Synthetic Attendance' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh attendance' }));
  await screen.findByRole('article', { name: 'Synthetic Attendance' });
});
