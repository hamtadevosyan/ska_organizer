import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import ChildSafetyCard from './ChildSafetyCard';
import * as api from '../../api/childSafety';
import { AuthContext } from '../../auth/context';
import { testAccount } from '../../tests/authAccount';
import type { Account } from '../../auth/context';
import type { SafetyCard } from '../../api/childSafety';
vi.mock('../../api/childSafety', async original => ({ ...await original<typeof import('../../api/childSafety')>(), readSafety: vi.fn(), saveSafety: vi.fn() }));
const teacher: Account = { ...testAccount, role: 'teacher', roomId: 'own-room' };
const card: SafetyCard = { ...api.emptySafety(), version: 1, reviewedAt: '2026-10-18T08:00:00Z', allergyStatus: 'recorded', allergies: 'Peanut allergy',
  medicalAlerts: 'Approved care plan', emergencyContacts: [{ name: 'Parent Example', phone: '555-0100', relationship: 'Parent' }] };
const scoped = (value = card) => ({ state: 'assigned' as const, room: { id: 'own-room', name: 'Own class', ageMinMonths: 24, ageMaxMonths: 60, capacity: 20 }, childId: 'child', card: value });
function view(account = teacher, childId = 'child', unavailable = false) {
  return <AuthContext.Provider value={{ account, ready: true, notice: '', serverUnavailable: unavailable, signIn: vi.fn(), signOut: vi.fn(), changePassword: vi.fn(), retry: vi.fn() }}><ChildSafetyCard childId={childId} name="Synthetic Child" /></AuthContext.Provider>;
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.readSafety).mockResolvedValue(scoped()); vi.spyOn(window, 'confirm').mockReturnValue(true); });
test('teachers see essential reviewed safety information without edit or private document actions', async () => {
  render(view());
  expect(await screen.findByText('Peanut allergy')).toBeVisible();
  expect(screen.getByText('Parent Example')).toBeVisible(); expect(screen.getByText('555-0100')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Edit safety card' })).not.toBeInTheDocument();
  expect(api.readSafety).toHaveBeenCalledWith('child', true, expect.any(AbortSignal));
  expect(screen.queryByText(/contract|insurance/i)).not.toBeInTheDocument();
});
test('unreviewed cards show unknown allergies and never claim none', async () => {
  vi.mocked(api.readSafety).mockResolvedValue(scoped({ ...api.emptySafety(), version: 0, reviewedAt: null }));
  render(view());
  expect(await screen.findByText('Allergy information unknown')).toBeVisible();
  expect(screen.getByText('Not yet reviewed. Ask an administrator to complete this card.')).toBeVisible();
  expect(screen.queryByText('No allergies reported')).not.toBeInTheDocument();
});
test('Class viewers cannot fetch or render health details', () => {
  render(view({ ...teacher, role: 'viewer' }));
  expect(api.readSafety).not.toHaveBeenCalled(); expect(screen.queryByText('Health & emergency')).not.toBeInTheDocument();
});
test('a response for another class is discarded', async () => {
  vi.mocked(api.readSafety).mockResolvedValue({ ...scoped(), room: { ...scoped().room, id: 'foreign-room' } });
  render(view());
  expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByText('Peanut allergy')).not.toBeInTheDocument();
});

test('Teacher responses without an explicit child and class scope are rejected', async () => {
  vi.mocked(api.readSafety).mockResolvedValue(card);
  render(view());
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.queryByText('Peanut allergy')).not.toBeInTheDocument();
});
test('scope changes hide old clinical data and late responses cannot restore it', async () => {
  let release!: (value: ReturnType<typeof scoped>) => void;
  vi.mocked(api.readSafety).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const screenView = render(view());
  vi.mocked(api.readSafety).mockResolvedValue({ ...scoped(), childId: 'second', card: { ...card, allergies: 'New approved allergy' } });
  screenView.rerender(view(teacher, 'second'));
  expect(await screen.findByText('New approved allergy')).toBeVisible();
  await act(async () => release(scoped()));
  expect(screen.queryByText('Peanut allergy')).not.toBeInTheDocument();
});
test('outages and failed refreshes remove old safety details', async () => {
  const screenView = render(view()); expect(await screen.findByText('Peanut allergy')).toBeVisible();
  screenView.rerender(view(teacher, 'child', true));
  expect(screen.queryByText('Peanut allergy')).not.toBeInTheDocument(); expect(screen.getByRole('alert')).toHaveTextContent('emergency backup');
  vi.mocked(api.readSafety).mockRejectedValue(new Error('Synthetic outage'));
  screenView.rerender(view());
  expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.queryByText('Peanut allergy')).not.toBeInTheDocument();
});
test('administrator saves only the reviewed editable fields with optimistic version', async () => {
  vi.mocked(api.readSafety).mockResolvedValue(card); vi.mocked(api.saveSafety).mockResolvedValue({ ...card, version: 2, allergies: 'Updated allergy' });
  render(view(testAccount));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit safety card' }));
  fireEvent.change(screen.getByLabelText('Allergy details'), { target: { value: 'Updated allergy' } });
  expect(screen.getByRole('button', { name: 'Save reviewed safety card' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I verified this card against current parent and medical instructions.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed safety card' }));
  await waitFor(() => expect(api.saveSafety).toHaveBeenCalledWith('child', expect.objectContaining({ allergies: 'Updated allergy' }), 1, true));
  const draft = vi.mocked(api.saveSafety).mock.calls[0][1];
  expect(draft).not.toHaveProperty('reviewedAt'); expect(draft).not.toHaveProperty('version');
  expect(await screen.findByText('Updated allergy')).toBeVisible();
});
test('an edit requires a new review confirmation and a save conflict retains the draft', async () => {
  vi.mocked(api.readSafety).mockResolvedValue(card); vi.mocked(api.saveSafety).mockRejectedValue(new Error('Synthetic version conflict'));
  render(view(testAccount)); fireEvent.click(await screen.findByRole('button', { name: 'Edit safety card' }));
  fireEvent.click(screen.getByLabelText('I verified this card against current parent and medical instructions.'));
  fireEvent.change(screen.getByLabelText('Emergency care instructions'), { target: { value: 'Parent-approved new plan' } });
  expect(screen.getByRole('button', { name: 'Save reviewed safety card' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I verified this card against current parent and medical instructions.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed safety card' }));
  expect(await screen.findByRole('alert')).toBeVisible(); expect(screen.getByLabelText('Emergency care instructions')).toHaveValue('Parent-approved new plan');
});
test('editor can read the card but cannot edit it', async () => {
  vi.mocked(api.readSafety).mockResolvedValue(card); render(view({ ...teacher, role: 'editor', roomId: null }));
  expect(await screen.findByText('Peanut allergy')).toBeVisible(); expect(screen.queryByRole('button', { name: 'Edit safety card' })).not.toBeInTheDocument();
});

test('an administrator draft survives an outage and retains its original version after recovery', async () => {
  vi.mocked(api.readSafety).mockResolvedValueOnce(card).mockResolvedValueOnce({ ...card, version: 2 });
  vi.mocked(api.saveSafety).mockRejectedValue(new Error('Synthetic conflict'));
  const screenView = render(view(testAccount));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit safety card' }));
  fireEvent.change(screen.getByLabelText('Emergency care instructions'), { target: { value: 'Unsaved reviewed instructions' } });
  screenView.rerender(view(testAccount, 'child', true));
  expect(screen.queryByDisplayValue('Unsaved reviewed instructions')).not.toBeInTheDocument();
  screenView.rerender(view(testAccount));
  expect(await screen.findByLabelText('Emergency care instructions')).toHaveValue('Unsaved reviewed instructions');
  fireEvent.click(screen.getByLabelText('I verified this card against current parent and medical instructions.'));
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewed safety card' }));
  await waitFor(() => expect(api.saveSafety).toHaveBeenCalledWith('child', expect.objectContaining({ careInstructions: 'Unsaved reviewed instructions' }), 1, true));
});
