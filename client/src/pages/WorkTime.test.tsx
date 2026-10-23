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
function view(role: Role = 'editor', alerts = false, entry = '/') {
  return <AuthContext.Provider value={{ account: { ...testAccount, role }, ready: true, notice: '', serverUnavailable: false,
    signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}>
    <MemoryRouter initialEntries={[entry]}>{alerts ? <ExtraTimeAlerts /> : <WorkTime />}</MemoryRouter>
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
  expect(day.getByText('Oct 21, 2026, 8:00:00 AM')).toBeVisible();
  expect(day.getByText('Oct 21, 2026, 5:30:00 PM')).toBeVisible();
  expect(day.getByText('Earlier record summary (individual sessions unavailable)')).toBeVisible();
  expect(day.getByText('First recorded arrival')).toBeVisible();
  expect(day.getByText('Last recorded departure')).toBeVisible();
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

test('separate clock sessions appear in chronological order without pairing aggregate endpoints', async () => {
  data.items[0] = { ...data.items[0], checkin: '2026-10-18T15:00:00Z', checkout: '2026-10-23T00:30:00Z',
    status: 'within-schedule', extraMillis: 0, lateMillis: 0, outsideMillis: 0,
    sessions: [
      { id: 'second', start: '2026-10-21T20:00:00Z', end: '2026-10-21T23:00:00Z', dayStart: '2026-10-21T20:00:00Z', dayEnd: '2026-10-21T23:00:00Z', originalStart: '2026-10-21T20:00:00Z', originalEnd: '2026-10-21T23:00:00Z' },
      { id: 'first', start: '2026-10-21T15:00:00Z', end: '2026-10-21T19:00:00Z', dayStart: '2026-10-21T15:00:00Z', dayEnd: '2026-10-21T19:00:00Z', originalStart: '2026-10-21T15:00:00Z', originalEnd: '2026-10-21T19:00:00Z' },
    ] };
  render(view()); await chooseEmployee();
  const day = within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-21' }));
  const sessions = within(day.getByRole('list', { name: 'Recorded sessions for 2026-10-21' })).getAllByRole('listitem');
  expect(sessions).toHaveLength(2);
  expect(sessions[0]).toHaveAccessibleName('Recorded session 1 for 2026-10-21');
  expect(within(sessions[0]).getByText('Check-in')).toBeVisible();
  expect(within(sessions[0]).getByText('Oct 21, 2026, 8:00:00 AM')).toBeVisible();
  expect(within(sessions[0]).getByText('Checkout')).toBeVisible();
  expect(within(sessions[0]).getByText('Oct 21, 2026, 12:00:00 PM')).toBeVisible();
  expect(sessions[1]).toHaveAccessibleName('Recorded session 2 for 2026-10-21');
  expect(within(sessions[1]).getByText('Oct 21, 2026, 1:00:00 PM')).toBeVisible();
  expect(within(sessions[1]).getByText('Oct 21, 2026, 4:00:00 PM')).toBeVisible();
  expect(day.queryByText('Earlier record summary (individual sessions unavailable)')).not.toBeInTheDocument();
  expect(day.queryByText('Oct 18, 2026, 8:00:00 AM')).not.toBeInTheDocument();
  expect(day.queryByText('Oct 22, 2026, 5:30:00 PM')).not.toBeInTheDocument();
  expect(day.queryByText(/Time counted on/)).not.toBeInTheDocument();
});

test('an open session keeps its missing checkout beside its own arrival after an earlier completed session', async () => {
  data.items[0] = { ...data.items[0], checkout: null, incomplete: true, status: 'incomplete', canCorrect: false,
    sessions: [
      { id: 'afternoon-open', start: '2026-10-21T21:00:00Z', end: null, dayStart: '2026-10-21T21:00:00Z', dayEnd: null, originalStart: '2026-10-21T21:00:00Z', originalEnd: null },
      { id: 'morning-closed', start: '2026-10-21T15:00:00Z', end: '2026-10-21T20:00:00Z', dayStart: '2026-10-21T15:00:00Z', dayEnd: '2026-10-21T20:00:00Z', originalStart: '2026-10-21T15:00:00Z', originalEnd: '2026-10-21T20:00:00Z' },
    ] };
  render(view()); await chooseEmployee();
  const day = within(screen.getByRole('article', { name: 'Ari Employee time on 2026-10-21' }));
  const sessions = within(day.getByRole('list', { name: 'Recorded sessions for 2026-10-21' })).getAllByRole('listitem');
  expect(sessions).toHaveLength(2);
  expect(within(sessions[0]).getByText('Oct 21, 2026, 8:00:00 AM')).toBeVisible();
  expect(within(sessions[0]).getByText('Oct 21, 2026, 1:00:00 PM')).toBeVisible();
  expect(within(sessions[0]).queryByText('Checkout missing')).not.toBeInTheDocument();
  expect(within(sessions[1]).getByText('Oct 21, 2026, 2:00:00 PM')).toBeVisible();
  expect(within(sessions[1]).getByText('Checkout missing')).toBeVisible();
  expect(within(sessions[1]).queryByText('Oct 21, 2026, 1:00:00 PM')).not.toBeInTheDocument();
  expect(screen.queryByText(/break/i)).not.toBeInTheDocument();
});

test('an overnight session shows both actual dates on each day and labels the counted daily portions separately', async () => {
  const overnight = { id: 'overnight', start: '2026-10-21T06:00:00Z', end: '2026-10-21T09:00:00Z',
    originalStart: '2026-10-21T06:00:00Z', originalEnd: '2026-10-21T09:00:00Z' };
  data.items = [
    { ...data.items[0], date: '2026-10-20', checkin: overnight.start, checkout: '2026-10-21T07:00:00Z',
      status: 'within-schedule', paidMillis: 3600000, extraMillis: 0, lateMillis: 0, outsideMillis: 0,
      sessions: [{ ...overnight, dayStart: overnight.start, dayEnd: '2026-10-21T07:00:00Z' }] },
    { ...data.items[0], checkin: '2026-10-21T07:00:00Z', checkout: overnight.end,
      status: 'within-schedule', paidMillis: 7200000, extraMillis: 0, lateMillis: 0, outsideMillis: 0,
      sessions: [{ ...overnight, dayStart: '2026-10-21T07:00:00Z', dayEnd: overnight.end }] },
  ];
  render(view()); await chooseEmployee();
  for (const date of ['2026-10-20', '2026-10-21']) {
    const day = within(screen.getByRole('article', { name: 'Ari Employee time on ' + date }));
    const session = within(day.getByRole('list', { name: 'Recorded sessions for ' + date })).getByRole('listitem');
    const punches = within(session).getAllByRole('definition');
    expect(punches).toHaveLength(2);
    expect(punches[0]).toHaveTextContent('Oct 20, 2026, 11:00:00 PM');
    expect(punches[1]).toHaveTextContent('Oct 21, 2026, 2:00:00 AM');
    const portion = within(session).getByText(new RegExp('Time counted on ' + date + ':'));
    expect(portion).toHaveTextContent('Oct 21, 2026, 12:00:00 AM');
    expect(portion).toHaveTextContent(date === '2026-10-20' ? 'Oct 20, 2026, 11:00:00 PM' : 'Oct 21, 2026, 2:00:00 AM');
  }
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
  expect(day.getByText('Oct 21, 2026, 8:00:00 AM')).toBeVisible();
  expect(day.getByText('Oct 21, 2026, 5:30:00 PM')).toBeVisible();
  expect(day.getByText('Recorded time zone: America/Los_Angeles')).toBeVisible();
});

test('a pay-review link opens its employee and exact date without searching recent days', async () => {
  render(view('admin', false, '/staff/work-time?staff=a&date=2026-10-21'));
  await screen.findByRole('heading', { name: 'Ari Employee · 2026-10-21' });
  expect(screen.getByLabelText('Work-time employee')).toHaveValue('a');
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/api/work-time?start=2026-10-21&end=2026-10-21'), expect.anything());
  expect(screen.getByRole('link', { name: 'Show recent workdays' })).toHaveAttribute('href', '/staff/work-time?staff=a');
  expect(screen.getByRole('button', { name: 'Confirm extra time was worked' })).toBeVisible();
});

test('an invalid linked date cannot create an invalid API date range', async () => {
  render(view('editor', false, '/staff/work-time?staff=a&date=2026-02-30'));
  await screen.findByRole('heading', { name: 'Ari Employee · 2026-10-21' });
  expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/work-time$/), expect.anything());
  expect(screen.queryByRole('link', { name: 'Show recent workdays' })).not.toBeInTheDocument();
});

test('the home alert tells an editor that extra-time review is pending', async () => {
  render(view('editor', true));
  expect(await screen.findByText('1 workday needs extra-time review.')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review work time' })).toHaveAttribute('href', '/staff/work-time');
});

test('the administrator sees second-short-day warnings and overtime still awaiting a pay decision', async () => {
  data.items[0].status = 'confirmed';
  data.overtimeReviewCount = 1;
  data.shortDayWarnings = [{ staffId: 'a', name: 'Ari Employee', weekStart: '2026-10-19', weekEnd: '2026-10-25', count: 2, dates: ['2026-10-19', '2026-10-20'] }];
  render(view('admin', true));
  const warning = await screen.findByRole('region', { name: 'Short workday warnings' });
  expect(within(warning).getByText('Ari Employee: 2 short days')).toBeVisible();
  expect(warning).toHaveTextContent('2026-10-19, 2026-10-20');
  expect(warning).toHaveTextContent('Two or more completed short days in one workweek need your attention.');
  expect(screen.getByRole('heading', { name: 'Overtime needs your review' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Review pay decisions' })).toHaveAttribute('href', '/staff/payroll');
  expect(screen.getByText('No extra time waiting for review.')).toBeVisible();
});

test('editors do not see administrator short-day or pay-decision alerts', async () => {
  data.overtimeReviewCount = 2;
  data.shortDayWarnings = [{ staffId: 'a', name: 'Ari Employee', weekStart: '2026-10-19', weekEnd: '2026-10-25', count: 3, dates: ['2026-10-19', '2026-10-20', '2026-10-21'] }];
  render(view('editor', true));
  await screen.findByText('1 workday needs extra-time review.');
  expect(screen.queryByRole('region', { name: 'Short workday warnings' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Overtime needs your review' })).not.toBeInTheDocument();
});

test('Home does not repeat a previous workweek short-day warning as a current warning', async () => {
  data.shortDayWarnings = [{ staffId: 'a', name: 'Ari Employee', weekStart: '2026-10-12', weekEnd: '2026-10-18', count: 3, dates: ['2026-10-12', '2026-10-13', '2026-10-14'] }];
  render(view('admin', true));
  await screen.findByText('1 workday needs extra-time review.');
  expect(screen.queryByRole('region', { name: 'Short workday warnings' })).not.toBeInTheDocument();
});
