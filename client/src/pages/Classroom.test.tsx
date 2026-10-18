import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import Classroom from './Classroom';
import * as api from '../api/classroom';
import type { ClassroomOverview } from '../api/classroom';
import { AuthContext } from '../auth/context';
import type { Account } from '../auth/context';
import { testAccount } from '../tests/authAccount';

vi.mock('../api/classroom');
const room = { id: 'own-class', name: 'Rainbow class', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 };
const account: Account = { ...testAccount, role: 'viewer', roomId: room.id };
const overview: ClassroomOverview = { state: 'assigned', room, today: '2026-10-14', timeZone: 'America/Los_Angeles', activeChildCount: 2 };
const children = { state: 'assigned' as const, room, total: 1, items: [{ id: 'child-one', firstName: 'Ari', lastName: 'Example', preferredName: 'Sunny' }] };
const activities = { state: 'assigned' as const, room, weekStart: '2026-10-12', hasPlan: true, version: 1, savedAt: null,
  entries: [{ id: 'entry-one', date: '2026-10-12', startTime: '09:00', endTime: '09:30', timeBlock: null, activity: { name: 'Story circle', description: 'Read together.', durationMinutes: 30 } }] };
const meals = { state: 'assigned' as const, room, weekStart: '2026-10-12', hasPlan: true, version: 1, savedAt: null, scope: 'facility' as const,
  week: [{ day: 'Monday', meals: [{ slot: 'lunch', name: 'Vegetable rice', type: 'lunch' }] }] };
function view(section: 'overview' | 'children' | 'activities' | 'meals' = 'overview', user = account, unavailable = false) {
  return <AuthContext.Provider value={{ account: user, ready: true, notice: '', serverUnavailable: unavailable, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><Classroom section={section} /></AuthContext.Provider>;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getClassroomOverview).mockResolvedValue(overview);
  vi.mocked(api.getClassroomChildren).mockResolvedValue(children);
  vi.mocked(api.getClassroomActivities).mockResolvedValue(activities);
  vi.mocked(api.getClassroomMeals).mockResolvedValue(meals);
});
test('overview shows only the assigned class count and configuration', async () => {
  render(view());
  expect(await screen.findByRole('heading', { name: room.name })).toBeVisible();
  expect(screen.getByText('2 active children')).toBeVisible();
  expect(screen.getByText('24–60 months')).toBeVisible();
  expect(api.getClassroomChildren).not.toHaveBeenCalled();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});
test('children render basic names without profile or management actions', async () => {
  vi.mocked(api.getClassroomChildren).mockResolvedValue({ ...children, items: [{ ...children.items[0], medical: 'private health sentinel', notes: 'private notes sentinel' } as typeof children.items[0]] });
  render(view('children'));
  expect(await screen.findByText('Ari Example')).toBeVisible();
  expect(screen.getByText('Goes by Sunny')).toBeVisible();
  expect(screen.queryByText(/private.*sentinel/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /edit|add|save|generate/i })).not.toBeInTheDocument();
});
test('unassigned viewers receive no detail requests or global fallback', async () => {
  vi.mocked(api.getClassroomOverview).mockResolvedValue({ ...overview, state: 'unassigned', room: null, activeChildCount: 0 });
  render(view('children', { ...account, roomId: null }));
  expect(await screen.findByText('No class assigned yet')).toBeVisible();
  expect(api.getClassroomChildren).not.toHaveBeenCalled();
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
});
test('unavailable class shows a neutral administrator instruction', async () => {
  vi.mocked(api.getClassroomOverview).mockResolvedValue({ ...overview, state: 'unavailable', room: null, activeChildCount: 0 });
  render(view('meals'));
  expect(await screen.findByText('Class currently unavailable')).toBeVisible();
  expect(screen.getByText('Ask an administrator to assign you to an active class.')).toBeVisible();
  expect(api.getClassroomMeals).not.toHaveBeenCalled();
});
test('activities default to Monday in the facility date, and show only saved entries', async () => {
  render(view('activities'));
  expect(await screen.findByText('Story circle')).toBeVisible();
  expect(api.getClassroomActivities).toHaveBeenCalledWith('2026-10-12', expect.any(AbortSignal));
  expect(screen.getByText('Read together.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /generate|save|copy|materials/i })).not.toBeInTheDocument();
});
test('meal view clearly identifies the saved academy menu', async () => {
  render(view('meals'));
  expect(await screen.findByText('Vegetable rice')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Shared academy menu for your class' })).toBeVisible();
  expect(api.getClassroomMeals).toHaveBeenCalledWith('2026-10-12', expect.any(AbortSignal));
  expect(screen.queryByRole('button', { name: /generate|save|stock|shopping/i })).not.toBeInTheDocument();
});
test('a missing saved activity plan remains empty', async () => {
  vi.mocked(api.getClassroomActivities).mockResolvedValue({ ...activities, hasPlan: false, entries: [] });
  render(view('activities'));
  expect(await screen.findByText('No activities have been saved for your class for this week.')).toBeVisible();
  expect(screen.queryByText('Story circle')).not.toBeInTheDocument();
});
test('a missing menu does not generate or reuse a legacy week', async () => {
  vi.mocked(api.getClassroomMeals).mockResolvedValue({ ...meals, hasPlan: false, week: [] });
  render(view('meals'));
  expect(await screen.findByText('No menu has been saved for this week.')).toBeVisible();
  expect(screen.queryByText('Vegetable rice')).not.toBeInTheDocument();
});
test('changing week clears old contents until the newly requested week loads', async () => {
  let resolve!: (value: typeof activities) => void;
  vi.mocked(api.getClassroomActivities).mockResolvedValueOnce(activities).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(view('activities')); await screen.findByText('Story circle');
  fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
  expect(screen.queryByText('Story circle')).not.toBeInTheDocument();
  await waitFor(() => expect(api.getClassroomActivities).toHaveBeenLastCalledWith('2026-10-19', expect.any(AbortSignal)));
  await act(async () => resolve({ ...activities, weekStart: '2026-10-19', entries: [] }));
  expect(await screen.findByText('No activities are scheduled for this week.')).toBeVisible();
});
test('class reassignment clears names immediately and ignores a late old response', async () => {
  let resolveOld!: (value: typeof children) => void;
  vi.mocked(api.getClassroomChildren).mockImplementationOnce(() => new Promise(done => { resolveOld = done; })).mockResolvedValueOnce({ ...children, room: { ...room, id: 'new-class' }, items: [{ id: 'other', firstName: 'New', lastName: 'Child', preferredName: null }] });
  const rendered = render(view('children'));
  await waitFor(() => expect(api.getClassroomChildren).toHaveBeenCalledTimes(1));
  vi.mocked(api.getClassroomOverview).mockResolvedValue({ ...overview, room: { ...room, id: 'new-class' } });
  rendered.rerender(view('children', { ...account, roomId: 'new-class' }));
  expect(await screen.findByText('New Child')).toBeVisible();
  await act(async () => resolveOld(children));
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
});
test('a response from a different room fails closed', async () => {
  vi.mocked(api.getClassroomChildren).mockResolvedValue({ ...children, room: { ...room, id: 'other-class' } });
  render(view('children'));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
});
test('a weekly response for a different week is not displayed', async () => {
  vi.mocked(api.getClassroomMeals).mockResolvedValue({ ...meals, weekStart: '2026-10-19' });
  render(view('meals'));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByText('Vegetable rice')).not.toBeInTheDocument();
});
test('a failed refresh removes previously loaded names', async () => {
  render(view('children')); await screen.findByText('Ari Example');
  vi.mocked(api.getClassroomChildren).mockRejectedValue(new Error('Synthetic failure'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh class' }));
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your class.');
});
test('an outage hides loaded class records and does not issue more reads', async () => {
  const rendered = render(view('children')); await screen.findByText('Ari Example');
  const calls = vi.mocked(api.getClassroomOverview).mock.calls.length;
  rendered.rerender(view('children', account, true));
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('connection is interrupted');
  expect(api.getClassroomOverview).toHaveBeenCalledTimes(calls);
});
test('focus refreshes current assignment before showing records again', async () => {
  render(view('children')); await screen.findByText('Ari Example');
  vi.mocked(api.getClassroomOverview).mockResolvedValue({ ...overview, state: 'unavailable', room: null, activeChildCount: 0 });
  fireEvent.focus(window);
  expect(screen.queryByText('Ari Example')).not.toBeInTheDocument();
  expect(await screen.findByText('Class currently unavailable')).toBeVisible();
});
test('a class becoming unavailable during a detail read clears all content', async () => {
  vi.mocked(api.getClassroomChildren).mockResolvedValue({ ...children, state: 'unavailable', room: null, items: [], total: 0 });
  render(view('children'));
  expect(await screen.findByText('Class currently unavailable')).toBeVisible();
  expect(screen.queryByText('Rainbow class')).not.toBeInTheDocument();
});
test('an administrative account cannot use this component to fetch a class', () => {
  render(view('children', testAccount));
  expect(screen.getByRole('alert')).toHaveTextContent('Class viewer access is required.');
  expect(api.getClassroomOverview).not.toHaveBeenCalled();
});
