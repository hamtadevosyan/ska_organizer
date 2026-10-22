import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import WorkTime, { ExtraTimeAlerts } from './WorkTime';
import type { WorkData } from './WorkTime';
import { AuthContext } from '../auth/context';
import { testAccount } from '../tests/authAccount';
import type { Role } from '../auth/context';

vi.mock('axios', async original => {
  const real = await original<typeof import('axios')>();
  return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } };
});
const fixture: WorkData = {
  today: '2026-10-21', timeZone: 'America/Los_Angeles',
  staff: [{ id: 'a', name: 'Ari Employee', active: true, scheduleVersion: 3, defaultMinutes: 480,
    entries: [{ effectiveOn: '2026-10-20', minutes: 540, startTime: '08:00', endTime: '17:00', timeZone: 'America/Los_Angeles', reason: 'Regular school day' }] }],
  items: [{ staffId: 'a', name: 'Ari Employee', date: '2026-10-21', version: 2, plannedMinutes: 540,
    plannedStart: '08:00', plannedEnd: '17:00', scheduleTimeZone: 'America/Los_Angeles',
    checkin: '2026-10-21T15:00:00Z', checkout: '2026-10-22T00:30:00Z', paidMillis: 34200000,
    extraMillis: 1800000, earlyMillis: 0, lateMillis: 1800000, outsideMillis: 1800000,
    incomplete: false, status: 'pending', reason: '', canCorrect: true }],
};
let data: WorkData;
function view(role: Role = 'editor', alerts = false) {
  return <AuthContext.Provider value={{ account: { ...testAccount, role }, ready: true, notice: '', serverUnavailable: false,
    signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}>
    <MemoryRouter>{alerts ? <ExtraTimeAlerts /> : <WorkTime />}</MemoryRouter>
  </AuthContext.Provider>;
}
async function chooseEmployee() {
  await screen.findByRole('option', { name: 'Ari Employee' });
  fireEvent.change(screen.getByLabelText('Work-time employee'), { target: { value: 'a' } });
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); data = structuredClone(fixture);
  vi.mocked(axios.get).mockImplementation(async () => ({ data: { data } }));
  vi.mocked(axios.post).mockResolvedValue({ data: { data: { saved: true } } });
});

test.each(['viewer', 'teacher'] as const)('%s cannot load manager work-time data', role => {
  render(view(role));
  expect(screen.getByRole('alert')).toHaveTextContent('Manager work-time access');
  expect(axios.get).not.toHaveBeenCalled();
});

test('an editor saves an approved start and end time with a clear nine-hour span', async () => {
  render(view()); await chooseEmployee();
  expect(screen.getByLabelText('Approved start time')).toHaveValue('08:00');
  expect(screen.getByLabelText('Approved end time')).toHaveValue('17:00');
  expect(screen.getByText('8:00 AM–5:00 PM · 9 hr scheduled. No automatic deductions.')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Approved start time'), { target: { value: '08:30' } });
  fireEvent.change(screen.getByLabelText('Approved end time'), { target: { value: '16:00' } });
  fireEvent.change(screen.getByLabelText('Reason for schedule change'), { target: { value: 'Approved school-day shift' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save approved schedule' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/staff/a/schedule'), {
    version: 3, startTime: '08:30', endTime: '16:00', effectiveOn: '2026-10-21', reason: 'Approved school-day shift',
  }));
  expect(screen.queryByLabelText(/SSN|Bank|rate|Approved hours per day/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Continue to pay calculation' })).not.toBeInTheDocument();
});

test.each(['08:00', '07:59'])('a same-day schedule rejects an end at %s without losing the draft', async endTime => {
  render(view()); await chooseEmployee();
  fireEvent.change(screen.getByLabelText('Approved end time'), { target: { value: endTime } });
  fireEvent.change(screen.getByLabelText('Reason for schedule change'), { target: { value: 'Regular shift' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save approved schedule' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose an approved end time after the start time');
  expect(screen.getByLabelText('Approved end time')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Approved end time')).toHaveValue(endTime);
  expect(screen.getByLabelText('Reason for schedule change')).toHaveValue('Regular shift');
  expect(axios.post).not.toHaveBeenCalled();
});

test('the employee day log separates the approved window, actual clocks, and outside time', async () => {
  data.items.push({ ...data.items[0], date: '2026-10-20', status: 'within-schedule', checkout: '2026-10-21T00:00:00Z',
    checkin: '2026-10-20T15:00:00Z', paidMillis: 32400000, extraMillis: 0, lateMillis: 0, outsideMillis: 0 });
  render(view()); await chooseEmployee();
  const day = within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-21' }));
  expect(day.getByText('8:00 AM–5:00 PM')).toBeVisible();
  expect(day.getByText('8:00:00 AM')).toBeVisible();
  expect(day.getByText('5:30:00 PM')).toBeVisible();
  expect(day.getByText('9 hr 30 min')).toBeVisible();
  expect(day.getByText('Time outside approved schedule')).toBeVisible();
  expect(day.getByText('30 min')).toBeVisible();
  expect(day.getByText('After approved end: 30 min')).toBeVisible();
  expect(day.getByText('Needs manager review')).toBeVisible();
  expect(within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-20' })).getByText('Within approved schedule')).toBeVisible();
});

test('earlier daily-hour records do not acquire an invented clock window or lose their extra duration', async () => {
  data.staff[0].entries = [{ effectiveOn: '2026-10-01', minutes: 480, reason: 'Earlier policy' }];
  data.items = [{ ...data.items[0], plannedStart: null, plannedEnd: null, checkin: null,
    plannedMinutes: 480, paidMillis: 32400000, extraMillis: 3600000, outsideMillis: 0, lateMillis: 0 }];
  render(view()); await chooseEmployee();
  expect(screen.getByLabelText('Approved start time')).toHaveValue('');
  expect(screen.getByLabelText('Approved end time')).toHaveValue('');
  const day = within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-21' }));
  expect(day.getByText('Earlier daily-hours schedule · 8 hr')).toBeVisible();
  expect(day.getByText('Time over earlier daily-hours limit')).toBeVisible();
  expect(day.getByText('1 hr')).toBeVisible();
  expect(day.getByText('Not available in earlier records')).toBeVisible();
  expect(day.queryByText('8:00 AM–5:00 PM')).not.toBeInTheDocument();
});

test('an incomplete clock record stays visible without any break instruction', async () => {
  data.items = [{ ...data.items[0], checkout: null, incomplete: true, paidMillis: 3600000, extraMillis: 0,
    outsideMillis: 0, lateMillis: 0, status: 'incomplete', canCorrect: false }];
  render(view()); await chooseEmployee();
  const day = within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-21' }));
  expect(day.getAllByText('Checkout missing')).toHaveLength(2);
  expect(day.getByText('1 hr')).toBeVisible();
  expect(screen.queryByText(/break/i)).not.toBeInTheDocument();
  expect(screen.getByText('No extra time is waiting for review.')).toBeVisible();
});

test('schedule history includes future windows while the form starts with the current window', async () => {
  data.staff[0].entries.push({ effectiveOn: '2026-11-01', minutes: 480, startTime: '09:00', endTime: '17:00', reason: 'November schedule' });
  render(view()); await chooseEmployee();
  expect(screen.getByLabelText('Approved start time')).toHaveValue('08:00');
  fireEvent.click(screen.getByText('Schedule history'));
  expect(screen.getByText('From 2026-11-01')).toBeVisible();
  expect(screen.getByText(/9:00 AM–5:00 PM/)).toBeVisible();
  expect(screen.getByText('November schedule')).toBeVisible();
});

test('canceling a refresh preserves the schedule draft and a later discard resets it', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(view()); await chooseEmployee();
  fireEvent.change(screen.getByLabelText('Approved start time'), { target: { value: '09:15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh work time' }));
  expect(confirm).toHaveBeenCalledWith('Discard unsaved work-time form changes?');
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Approved start time')).toHaveValue('09:15');
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
  expect(screen.getByLabelText('Approved start time')).toHaveValue('08:00');
});

test('a manager confirms outside work explicitly without changing checkouts or capping pay', async () => {
  render(view()); await screen.findByRole('heading', { name: 'Ari Employee · 2026-10-21' });
  fireEvent.change(screen.getByLabelText('Extra-work review note'), { target: { value: 'Stayed to assist with pickup' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm extra time was worked' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/staff/a/review'), {
    version: 2, date: '2026-10-21', decision: 'worked', reason: 'Stayed to assist with pickup',
  }));
});

test('early arrival asks for a review without offering a late-checkout correction', async () => {
  data.items[0] = { ...data.items[0], checkin: '2026-10-21T14:30:00Z', checkout: '2026-10-22T00:00:00Z', earlyMillis: 1800000, lateMillis: 0 };
  render(view()); await screen.findByRole('heading', { name: 'Ari Employee · 2026-10-21' });
  expect(screen.getByText('Before approved start: 30 min')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm extra time was worked' })).toBeEnabled();
  expect(screen.queryByText('Correct a late clock-out mistake')).not.toBeInTheDocument();
});

test('historical clock times retain their recorded time zone after a facility time-zone change', async () => {
  data.timeZone = 'America/New_York';
  data.items[0].timeZone = 'America/Los_Angeles';
  render(view()); await chooseEmployee();
  const day = within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-21' }));
  expect(day.getByText('8:00:00 AM')).toBeVisible();
  expect(day.getByText('5:30:00 PM')).toBeVisible();
  expect(day.getByText('Recorded time zone: America/Los_Angeles')).toBeVisible();
});

test('the home alert tells an editor that extra-time review is pending', async () => {
  render(view('editor', true));
  expect(await screen.findByText('1 workday needs extra-time review.')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review work time' })).toHaveAttribute('href', '/staff/work-time');
});
