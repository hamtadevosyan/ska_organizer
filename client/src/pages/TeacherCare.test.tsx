import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import TeacherCare from './TeacherCare';
import { AuthContext } from '../auth/context';
import { testAccount } from '../tests/authAccount';
import type { Account } from '../auth/context';
import { getClassroomChildren } from '../api/classroom';
vi.mock('../api/classroom', async original => ({ ...await original<typeof import('../api/classroom')>(), getClassroomChildren: vi.fn() }));
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn() } }; });
vi.mock('../components/children/ChildSafetyCard', () => ({ default: ({ name }: { name: string }) => <p>Safety card for {name}</p> }));
const account: Account = { ...testAccount, role: 'teacher', roomId: 'own-room' };
const child = { id: 'own-child', firstName: 'Ari', lastName: 'Example', preferredName: null };
const room = { id: 'own-room', name: 'Rainbow class', capacity: 20, ageMinMonths: 24, ageMaxMonths: 60 };
const roster = { state: 'assigned', room, today: '2026-10-18', timeZone: 'America/Los_Angeles', rows: [{ child, records: [], needsAdminReview: false, canCheckIn: true, canCheckOut: false }] };
function view(user = account, section: 'attendance' | 'children' = 'attendance', unavailable = false) {
  return <AuthContext.Provider value={{ account: user, ready: true, notice: '', serverUnavailable: unavailable, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><TeacherCare section={section} /></AuthContext.Provider>;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(axios.get).mockResolvedValue({ data: { data: roster } });
  vi.mocked(axios.post).mockResolvedValue({ data: {} });
  vi.mocked(getClassroomChildren).mockResolvedValue({ state: 'assigned', room, total: 1, items: [child] });
});
test('teacher sees only class attendance and a separate signature explanation', async () => {
  render(view()); expect(await screen.findByRole('heading', { name: 'Ari Example' })).toBeVisible();
  expect(screen.getByText(/signature is handled separately/)).toBeVisible();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /correct|delete|generate/i })).not.toBeInTheDocument();
});
test('check-in uses only the child, facility date and a stable retry identifier', async () => {
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Synthetic uncertain result')).mockResolvedValueOnce({ data: {} });
  render(view()); fireEvent.click(await screen.findByRole('button', { name: 'Check in Ari' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check in Ari' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(axios.post).mock.calls[0]).toEqual(vi.mocked(axios.post).mock.calls[1]);
  expect(vi.mocked(axios.post).mock.calls[0][1]).toEqual({ date: roster.today, requestId: expect.any(String) });
  expect(String(vi.mocked(axios.post).mock.calls[0][0])).toContain('/classroom/children/own-child/checkin');
});
test('check-out sends the current visit version without client-supplied time or actor', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { data: { ...roster, rows: [{ ...roster.rows[0], canCheckIn: false, canCheckOut: true,
    records: [{ id: 'visit', checkIn: '2026-10-18T15:00:00Z', checkOut: null, version: 3, voided: false, needsReview: false }] }] } } });
  render(view()); fireEvent.click(await screen.findByRole('button', { name: 'Check out Ari' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/classroom/attendance/visit/checkout'), { date: roster.today, version: 3 }));
});
test('an administrator-review visit disables both attendance actions', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { data: { ...roster, rows: [{ ...roster.rows[0], needsAdminReview: true, canCheckIn: false, canCheckOut: false }] } } });
  render(view()); expect(await screen.findByText('Attendance needs administrator review.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check in Ari' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Check out Ari' })).toBeDisabled();
});
test('children view offers attendance and the selected safety card without global-profile actions', async () => {
  render(view(account, 'children')); fireEvent.click(await screen.findByRole('button', { name: 'Health & emergency' }));
  expect(screen.getByText('Safety card for Ari Example')).toBeVisible();
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/classroom/attendance'), expect.anything()); expect(screen.getByRole('button', { name: 'Check in Ari' })).toBeEnabled();
});
test.each(['unassigned', 'unavailable'])('%s class shows no records or attendance actions', async state => {
  vi.mocked(axios.get).mockResolvedValue({ data: { data: { ...roster, state, room: null, rows: [] } } });
  render(view()); expect(await screen.findByText('Ask an administrator to assign an active class.')).toBeVisible();
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
});
test('foreign scope and outages hide all class information', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: { ...roster, room: { ...room, id: 'foreign-room' } } } });
  const screenView = render(view()); expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
  screenView.rerender(view(account, 'attendance', true)); expect(screen.getByRole('alert')).toHaveTextContent('emergency backup');
});
test('late roster from the old scope cannot repaint a new class', async () => {
  let release!: (value: unknown) => void;
  vi.mocked(axios.get).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const screenView = render(view());
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: { ...roster, room: { ...room, id: 'new-room' }, rows: [] } } });
  screenView.rerender(view({ ...account, roomId: 'new-room' }));
  expect(await screen.findByText('No active children are assigned to your class.')).toBeVisible();
  await act(async () => release({ data: { data: roster } }));
  expect(screen.queryByRole('heading', { name: 'Ari Example' })).not.toBeInTheDocument();
});
test('Class viewer cannot mount Teacher attendance', () => {
  render(view({ ...account, role: 'viewer' })); expect(screen.getByRole('alert')).toHaveTextContent('Teacher access is required'); expect(axios.get).not.toHaveBeenCalled();
});

test('replaying an already closed arrival explains its state and a later arrival uses a fresh identifier', async () => {
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { record: { checkOut: '2026-10-18T16:00:00Z' } } } }).mockResolvedValueOnce({ data: {} });
  render(view()); fireEvent.click(await screen.findByRole('button', { name: 'Check in Ari' }));
  expect(await screen.findByText('The previous arrival was already recorded and that visit is closed. Review attendance before recording another arrival.')).toBeVisible();
  fireEvent.click(await screen.findByRole('button', { name: 'Check in Ari' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(axios.post).mock.calls[0][1]).not.toEqual(vi.mocked(axios.post).mock.calls[1][1]);
});
