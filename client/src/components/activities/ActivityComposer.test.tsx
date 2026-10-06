import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { materialOptions, saveActivity } from '../../api/activities';
import type { Activity, Entry } from '../../api/activities';
import type { Room } from '../../api/rooms';
import { ActivityComposer } from './ActivityComposer';
import { ActivityForm } from './ActivityForm';

vi.mock('../../api/activities', async (original) => ({ ...await original<object>(), materialOptions: vi.fn(), saveActivity: vi.fn() }));
const art: Activity = { id: 'art', name: 'Paint leaves', description: '', durationMinutes: 20, ageMinMonths: null, ageMaxMonths: null, roomId: null, materials: [], version: 1 };
const music: Activity = { ...art, id: 'music', name: 'Sing together', durationMinutes: 30 };
const room: Room = { id: 'room', name: 'Sunflower', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12, active: true, needsConfiguration: false, assignedChildCount: 0, availablePlaces: 12, overCapacity: false };
const entry: Entry = { id: 'entry', date: '2026-10-05', startTime: '09:00', endTime: '09:45', timeBlock: null, activityId: art.id, activity: art };
function props(extra: Partial<Parameters<typeof ActivityComposer>[0]> = {}) {
  return { date: '2026-10-05', choices: [art, music], catalogCount: 2, suggestedStart: '08:00', disabled: false,
    onApply: vi.fn(), onCancel: vi.fn(), onCatalogSaved: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn(), ...extra };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(materialOptions).mockResolvedValue([]);
  vi.mocked(saveActivity).mockResolvedValue({ ...art, id: 'new-art', name: 'New art' });
});
test('choose and confirm adds one activity with suggested times only after Add to day', () => {
  const callbacks = props(); render(<ActivityComposer {...callbacks} />);
  expect(screen.getByLabelText('Search saved activities')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Choose Paint leaves' }));
  expect(screen.getByLabelText('Start time', { exact: true })).toHaveValue('08:00');
  expect(screen.getByLabelText('Start time', { exact: true })).toHaveFocus();
  expect(screen.getByLabelText('End time', { exact: true })).toHaveValue('08:20');
  expect(callbacks.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add to day' }));
  expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith({ activity: art, startTime: '08:00', endTime: '08:20', timeBlock: null });
});
test('switching day or view without remount preserves selection and edited time', () => {
  const callbacks = props(); const { rerender } = render(<ActivityComposer {...callbacks} />);
  fireEvent.change(screen.getByLabelText('Search saved activities'), { target: { value: 'paint' } });
  expect(screen.queryByRole('button', { name: 'Choose Sing together' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Choose Paint leaves' }));
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:15' } });
  screen.getByLabelText('End time').focus();
  rerender(<ActivityComposer {...callbacks} date="2026-10-06" suggestedStart="14:00" />);
  expect(screen.getByRole('heading', { name: 'Add activity to Tuesday' })).toBeInTheDocument();
  expect(screen.getByLabelText('Start time')).toHaveValue('10:15');
  expect(screen.getByLabelText('End time')).toHaveValue('10:35');
  expect(screen.getByLabelText('End time')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Change activity' }));
  expect(screen.getByLabelText('Search saved activities')).toHaveValue('paint');
  expect(screen.getByLabelText('Search saved activities')).toHaveFocus();
  expect(callbacks.onApply).not.toHaveBeenCalled();
});
test('empty choices explain room suitability and a search miss keeps Create an activity available', () => {
  const callbacks = props({ choices: [] }); const { rerender } = render(<ActivityComposer {...callbacks} />);
  expect(screen.getByText(/No saved activities fit this room’s ages/)).toBeInTheDocument();
  rerender(<ActivityComposer {...callbacks} choices={[art]} />);
  fireEvent.change(screen.getByLabelText('Search saved activities'), { target: { value: 'unknown' } });
  expect(screen.getByText(/No saved activities match your search/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create an activity' })).toBeVisible();
});
test('editing keeps the saved snapshot when the same activity is chosen from an updated library', () => {
  const latest = { ...art, name: 'Updated paint', durationMinutes: 5, version: 2 };
  const callbacks = props({ entry, choices: [latest] }); render(<ActivityComposer {...callbacks} />);
  expect(screen.getByLabelText('Start time')).toHaveFocus();
  expect(screen.getByText('Paint leaves', { exact: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change activity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Updated paint' }));
  expect(screen.getByLabelText('End time')).toHaveValue('09:45');
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith({ activity: art, startTime: '09:00', endTime: '09:45', timeBlock: null });
});
test('a legacy untimed entry keeps its time block until a time is entered', () => {
  const callbacks = props({ entry: { ...entry, startTime: null, endTime: null, timeBlock: 'morning' } });
  render(<ActivityComposer {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  expect(callbacks.onApply).toHaveBeenLastCalledWith({ activity: art, startTime: null, endTime: null, timeBlock: 'morning' });
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:45' } });
  expect(screen.getByLabelText('End time')).toHaveValue('09:05');
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  expect(callbacks.onApply).toHaveBeenLastCalledWith({ activity: art, startTime: '08:45', endTime: '09:05', timeBlock: null });
});
test('invalid times retain exact labels and can be corrected; midnight means 24:00', () => {
  const callbacks = props({ entry }); render(<ActivityComposer {...callbacks} />);
  fireEvent.change(screen.getByLabelText('End time'), { target: { value: '08:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  const end = screen.getByLabelText('End time', { exact: true });
  expect(end).toHaveAccessibleName('End time');
  expect(end).toHaveAttribute('aria-invalid', 'true');
  expect(end).toHaveAccessibleDescription('End time must be after start time.');
  expect(callbacks.onApply).not.toHaveBeenCalled();
  fireEvent.change(end, { target: { value: '00:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }));
  expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith({ activity: art, startTime: '09:00', endTime: '24:00', timeBlock: null });
});
test('dirty cancel offers Keep editing or Discard changes without applying', () => {
  const callbacks = props(); render(<ActivityComposer {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose Paint leaves' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const prompt = screen.getByRole('group', { name: 'Discard scheduled activity changes' });
  fireEvent.click(within(prompt).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Start time')).toHaveValue('08:00');
  expect(callbacks.onCancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(callbacks.onCancel).toHaveBeenCalledOnce();
  expect(callbacks.onApply).not.toHaveBeenCalled();
});
test('beforeunload warns for an unsaved composer and stops warning after unmount', () => {
  const callbacks = props(); const { unmount } = render(<ActivityComposer {...callbacks} />);
  fireEvent.change(screen.getByLabelText('Search saved activities'), { target: { value: 'paint' } });
  const warn = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(warn);
  expect(warn.defaultPrevented).toBe(true);
  expect(callbacks.onDirtyChange).toHaveBeenLastCalledWith(true);
  unmount();
  const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});
test('creating saves the library before timing confirmation, preserving the scheduler draft', async () => {
  let resolve!: (value: Activity) => void;
  vi.mocked(saveActivity).mockReturnValue(new Promise((done) => { resolve = done; }));
  const callbacks = props(); const { rerender } = render(<ActivityComposer {...callbacks} room={room} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create an activity' }));
  const form = screen.getByRole('form', { name: 'New activity' });
  fireEvent.change(within(form).getByLabelText('Activity name'), { target: { value: 'New art' } });
  rerender(<ActivityComposer {...callbacks} room={room} date="2026-10-06" />);
  expect(within(form).getByLabelText('Activity name')).toHaveValue('New art');
  fireEvent.click(within(form).getByRole('button', { name: 'Save activity & choose time' }));
  expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(callbacks.onBusyChange).toHaveBeenLastCalledWith(true);
  expect(callbacks.onApply).not.toHaveBeenCalled();
  const saved = { ...art, id: 'new-art', name: 'New art' };
  await act(async () => resolve(saved));
  await screen.findByRole('form', { name: 'Schedule activity' });
  expect(callbacks.onCatalogSaved).toHaveBeenCalledExactlyOnceWith(saved);
  expect(screen.getByText('New art', { exact: true })).toBeInTheDocument();
  expect(screen.getByLabelText('Start time')).toHaveValue('08:00');
  expect(callbacks.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add to day' }));
  expect(callbacks.onApply).toHaveBeenCalledExactlyOnceWith({ activity: saved, startTime: '08:00', endTime: '08:20', timeBlock: null });
  expect(callbacks.onBusyChange).toHaveBeenLastCalledWith(false);
});
test('an unsuccessful library save retains details and cannot add a scheduled entry', async () => {
  vi.mocked(saveActivity).mockRejectedValue(new Error('Synthetic failure'));
  const callbacks = props(); render(<ActivityComposer {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create an activity' }));
  fireEvent.change(screen.getByLabelText('Activity name'), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save activity & choose time' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Activity name', { exact: true })).toHaveValue('Keep this draft');
  expect(callbacks.onCatalogSaved).not.toHaveBeenCalled();
  expect(callbacks.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard activity' }));
  expect(screen.getByRole('form', { name: 'Schedule activity' })).toBeInTheDocument();
  expect(callbacks.onCancel).not.toHaveBeenCalled();
});
test('activity name, duration and age errors keep names stable and remain linked to fields', async () => {
  render(<ActivityForm activity={null} onSaved={vi.fn()} onClose={vi.fn()} onBusyChange={vi.fn()} />);
  await waitFor(() => expect(materialOptions).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  expect(screen.getByLabelText('Activity name', { exact: true })).toHaveAccessibleDescription('Enter an activity name of up to 100 characters.');
  expect(screen.getByLabelText('Minutes', { exact: true })).toHaveAccessibleDescription('Enter a duration from 1 to 1440 minutes.');
  fireEvent.change(screen.getByLabelText('Activity name'), { target: { value: 'Art' } });
  fireEvent.change(screen.getByLabelText('Minutes'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('Minimum age (months)'), { target: { value: '24' } });
  fireEvent.change(screen.getByLabelText('Maximum age (months)'), { target: { value: '24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  for (const label of ['Minimum age (months)', 'Maximum age (months)']) {
    const field = screen.getByLabelText(label, { exact: true });
    expect(field).toHaveAccessibleName(label); expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter both ages in months, with maximum greater than minimum, or leave both empty for all ages.');
  }
  expect(saveActivity).not.toHaveBeenCalled();
});
test('material quantities, duplicate choices and pending selections still prevent incorrect library saves', async () => {
  vi.mocked(materialOptions).mockResolvedValue([{ id: 'paper', name: 'Colored paper', location: 'Art shelf', unit: 'count',
    category: 'supplies', groupId: 'supplies', group: { id: 'supplies', name: 'Art', kind: 'supplies', description: '', createdAt: '', updatedAt: '' },
    ingredientId: null, ingredient: null, quantity: '10', reorderThreshold: '0', version: 1, status: 'available', createdAt: '', updatedAt: '' }]);
  render(<ActivityForm activity={null} onSaved={vi.fn()} onClose={vi.fn()} onBusyChange={vi.fn()} />);
  await screen.findByRole('option', { name: 'Colored paper — Art shelf (items)' });
  fireEvent.change(screen.getByLabelText('Activity name'), { target: { value: 'Paper art' } });
  fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'paper' } });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add material' }));
  expect(screen.getByLabelText('Amount', { exact: true })).toHaveAccessibleDescription('Enter a quantity greater than zero.');
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add material' }));
  expect(screen.getByText('Colored paper — 2 items')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'paper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add material' }));
  expect(screen.getByLabelText('Material', { exact: true })).toHaveAccessibleDescription('That material is already listed.');
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  expect(screen.getByLabelText('Material', { exact: true })).toHaveAccessibleDescription('Click Add material for the selected item, or clear the selection before saving.');
  expect(saveActivity).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Material'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save activity' }));
  await waitFor(() => expect(saveActivity).toHaveBeenCalledExactlyOnceWith(null, expect.objectContaining({
    materials: [expect.objectContaining({ itemId: 'paper', quantity: '2', reusable: false })] })));
});
