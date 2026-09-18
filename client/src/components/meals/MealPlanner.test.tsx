import { SignedIn } from '../../tests/authFixture';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import MealPlanner from './MealPlanner';
import Meals from '../../pages/Meals';
import type { Meal, Plan } from './weeklyPlan';

vi.mock('axios');
vi.mock('./MealSetup', () => ({ default: () => <div>Recipe editor</div> }));
let recordedStock = 2;
const firstWeek = '2026-09-07';
const secondWeek = '2026-09-14';
const eggMeal: Meal = { id: 'eggs', name: 'Scrambled Eggs', type: 'breakfast' };
const oats: Meal = { id: 'oats', name: 'Oatmeal', type: 'breakfast' };
const savedPlan = (weekStart = firstWeek): Plan => ({ weekStart, version: 1, savedAt: '2026-09-07T12:00:00Z',
  week: ['Monday', 'Tuesday', 'Wednesday'].map((day) => ({ day, menu: { breakfast: eggMeal } })),
  childrenCount: 4, staffCount: 1, inHouse: { egg: 2 },
  items: [{ ingredient: { id: 'egg', name: 'Eggs', unit: 'count' }, quantity: 15, inStorage: 2, toBuy: 13 }] });
const response = (data: unknown) => ({ data: { data } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await act(async () => {}); await act(async () => { await vi.advanceTimersByTimeAsync(310); }); };
const input = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Save Menu' });
const printButton = () => screen.getByRole('button', { name: 'Print List' });
const table = () => screen.getByRole('table');

it('reviews attendance explicitly, changes only today, and preserves other daily drafts and future weeks', async () => {
  render(<MealPlanner canWrite />);
  await flush();
  input('Children for Wednesday', '6');
  fireEvent.click(screen.getByRole('button', { name: 'Review today’s attendance count' }));
  await act(async () => {});
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(4);
  fireEvent.click(screen.getByRole('button', { name: 'Apply count to 2026-09-08 only' }));
  await flush();
  expect(screen.getByLabelText('Children')).toHaveValue(4);
  expect(screen.getByLabelText('Staff')).toHaveValue(1);
  expect(screen.getByLabelText('Children for Monday')).toHaveValue(4);
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(2);
  expect(screen.getByLabelText('Children for Wednesday')).toHaveValue(6);
  expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/preview'), expect.objectContaining({ dailyChildrenCounts: { '2026-09-08': 2, '2026-09-09': 6 } }), expect.anything());
  expect(axios.put).not.toHaveBeenCalled();
  input('Week starting Monday', secondWeek);
  await flush();
  expect(screen.getByRole('button', { name: 'Review today’s attendance count' })).toBeDisabled();
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(4);
  input('Children', '9');
  input('Week starting Monday', firstWeek); await flush();
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(2);
  expect(screen.getByLabelText('Children for Wednesday')).toHaveValue(6);
});

it('rejects a midnight attendance sample and ignores a response from a week that was left', async () => {
  render(<MealPlanner canWrite />); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Review today’s attendance count' }));
  await act(async () => {});
  const beforeMidnight = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation((path, config) => path.endsWith('/attendance/config')
    ? Promise.resolve({ data: { today: '2026-09-09', timeZone: 'America/Los_Angeles' } })
    : beforeMidnight(path, config));
  fireEvent.click(screen.getByRole('button', { name: 'Apply count to 2026-09-08 only' }));
  await act(async () => {});
  expect(screen.getByText('The facility date changed. Read today’s attendance again.')).toBeInTheDocument();
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(4);
  expect(screen.queryByRole('button', { name: 'Apply count to 2026-09-08 only' })).not.toBeInTheDocument();
  const late = deferred<{ data: { date: string; timeZone: string; takenAt: string; childrenCount: number } }>();
  const beforeSlowRequest = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation((path, config) => path.endsWith('/attendance/today-headcount')
    ? late.promise : beforeSlowRequest(path, config));
  fireEvent.click(screen.getByRole('button', { name: 'Review today’s attendance count' }));
  input('Week starting Monday', secondWeek); await flush();
  await act(async () => late.resolve({ data: { date: '2026-09-08', timeZone: 'America/Los_Angeles', takenAt: '2026-09-08T17:00:00Z', childrenCount: 2 } }));
  expect(screen.queryByRole('button', { name: 'Apply count to 2026-09-08 only' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(4);
});

it('explains an attendance sample outside the selected menu without changing its counts', async () => {
  render(<MealPlanner canWrite />); await flush();
  const defaultGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation((path, config) => path.endsWith('/attendance/today-headcount')
    ? Promise.resolve({ data: { date: secondWeek, timeZone: 'America/Los_Angeles', takenAt: '2026-09-14T17:00:00Z', childrenCount: 2 } })
    : defaultGet(path, config));
  fireEvent.click(screen.getByRole('button', { name: 'Review today’s attendance count' }));
  await act(async () => {});
  expect(screen.getByText('Choose the week containing today and generate its menu before using attendance.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Apply count to/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Children for Tuesday')).toHaveValue(4);
  expect(screen.getByLabelText('Week starting Monday')).toHaveValue(firstWeek);
  expect(axios.put).not.toHaveBeenCalled();
});

beforeEach(() => {
  recordedStock = 2;
  vi.useFakeTimers();
  vi.resetAllMocks();
  localStorage.clear();
  localStorage.setItem('skao.planner.week', firstWeek);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.isAxiosError).mockImplementation((error): error is import('axios').AxiosError => !!error && typeof error === 'object' && 'response' in error);
  vi.mocked(axios.get).mockImplementation(async (path) => path.endsWith('/attendance/config')
    ? { data: { today: '2026-09-08', timeZone: 'America/Los_Angeles' } }
    : path.endsWith('/attendance/today-headcount')
      ? { data: { date: '2026-09-08', timeZone: 'America/Los_Angeles', takenAt: '2026-09-08T17:00:00Z', childrenCount: 2 } }
      : path.endsWith('/api/meals') ? response([eggMeal, oats]) : response(savedPlan(path.endsWith(secondWeek) ? secondWeek : firstWeek)));
  vi.mocked(axios.post).mockImplementation(async (path, body) => {
    const draft = body as { childrenCount: number; staffCount: number; dailyChildrenCounts?: Record<string, number> };
    const monday = path.includes(secondWeek) ? secondWeek : firstWeek;
    const quantity = [0, 1, 2].reduce((sum, offset) => {
      const date = new Date(monday + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + offset);
      return sum + (draft.dailyChildrenCounts?.[date.toISOString().slice(0, 10)] ?? draft.childrenCount) + draft.staffCount;
    }, 0);
    const inStorage = recordedStock;
    return response({ ...savedPlan(path.includes(secondWeek) ? secondWeek : firstWeek), ...draft,
      stockSource: 'inventory', stockTakenAt: '2026-09-08T17:00:00Z', inHouse: { egg: inStorage },
      previewToken: `reviewed-${draft.childrenCount}-${inStorage}`,
      items: [{ ingredient: { id: 'egg', name: 'Eggs', unit: 'count' }, quantity, inStorage, toBuy: Math.max(0, quantity - inStorage) }] });
  });
  vi.mocked(axios.put).mockResolvedValue(response({ ...savedPlan(), version: 2 }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('saved weekly planner', () => {
  it('reopens counts and stock with 15 needed and 13 to buy, including a browser reload', async () => {
    const view = render(<MealPlanner canWrite />);
    expect(saveButton()).toBeDisabled();
    await flush();
    expect(screen.getByLabelText('Children')).toHaveValue(4);
    expect(screen.getByLabelText('Staff')).toHaveValue(1);
    expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('2 count');
    expect(screen.getAllByLabelText('Breakfast')[0]).toHaveValue('eggs');
    expect(within(table()).getByText('15 count')).toBeInTheDocument();
    expect(within(table()).getByText('13 count')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(printButton()).toBeEnabled();
    expect(axios.post).not.toHaveBeenCalled();
    view.unmount();
    render(<MealPlanner canWrite />);
    await flush();
    expect(screen.getByLabelText('Children')).toHaveValue(4);
    expect(within(table()).getByText('13 count')).toBeInTheDocument();
  });

  it('blocks stale Save and Print immediately, including the debounce interval', async () => {
    render(<MealPlanner canWrite />);
    await flush();
    input('Children', '6');
    expect(saveButton()).toBeDisabled();
    expect(printButton()).toBeDisabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(axios.put).not.toHaveBeenCalled();
    await flush();
    expect(within(table()).getByText('21 count')).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(axios.put).toHaveBeenCalledWith(expect.stringContaining(firstWeek), { previewToken: 'reviewed-6-2' });
  });

  it('ignores a late older calculation even when transport cancellation is ignored', async () => {
    render(<MealPlanner canWrite />);
    await flush();
    const older = deferred<ReturnType<typeof response>>();
    const newer = deferred<ReturnType<typeof response>>();
    vi.mocked(axios.post).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    input('Children', '5');
    await flush();
    input('Children', '6');
    await flush();
    await act(async () => newer.resolve(response({ ...savedPlan(), previewToken: 'new', items: [{ ...savedPlan().items[0], quantity: 21, toBuy: 19 }] })));
    expect(within(table()).getByText('21 count')).toBeInTheDocument();
    await act(async () => older.resolve(response({ ...savedPlan(), previewToken: 'old', items: [{ ...savedPlan().items[0], quantity: 18, toBuy: 16 }] })));
    expect(within(table()).getByText('21 count')).toBeInTheDocument();
    fireEvent.click(saveButton());
    expect(axios.put).toHaveBeenCalledWith(expect.any(String), { previewToken: 'new' });
  });

  it('keeps edits through both week selection and Meal Setup tabs', async () => {
    render(<SignedIn><Meals /></SignedIn>);
    await flush();
    input('Children', '6');
    recordedStock = 3;
    fireEvent.change(screen.getAllByLabelText('Breakfast')[0], { target: { value: 'oats' } });
    fireEvent.click(screen.getByRole('button', { name: 'Meal Setup' }));
    expect(screen.getByText('Recipe editor')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Planner' }));
    expect(screen.getByLabelText('Children')).toHaveValue(6);
    input('Week starting Monday', secondWeek);
    await flush();
    expect(screen.getByLabelText('Children')).toHaveValue(4);
    input('Week starting Monday', firstWeek);
    await flush();
    expect(screen.getByLabelText('Children')).toHaveValue(6);
    expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('3 count');
    expect(screen.getAllByLabelText('Breakfast')[0]).toHaveValue('oats');
    expect(axios.put).not.toHaveBeenCalled();
  });

  it('ignores a slow load for a week the user has left', async () => {
    const older = deferred<ReturnType<typeof response>>();
    const defaultGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation((path, config) => path.endsWith('/api/menu/plans/' + firstWeek) ? older.promise
      : path.endsWith('/api/menu/plans/' + secondWeek) ? Promise.resolve(response({ ...savedPlan(secondWeek), childrenCount: 9 }))
        : defaultGet(path, config));
    render(<MealPlanner canWrite />);
    await act(async () => {});
    input('Week starting Monday', secondWeek);
    await flush();
    await act(async () => older.resolve(response(savedPlan())));
    expect(screen.getByLabelText('Children')).toHaveValue(9);
    expect(screen.getByLabelText('Week starting Monday')).toHaveValue(secondWeek);
  });

  it('keeps failed calculations disabled until a successful retry', async () => {
    render(<MealPlanner canWrite />);
    await flush();
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('Preview unavailable'));
    input('Children', '7');
    await flush();
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(printButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry calculation' }));
    await flush();
    expect(saveButton()).toBeEnabled();
    expect(within(table()).getByText('24 count')).toBeInTheDocument();
  });

  it('preserves the editable draft after a failed atomic save', async () => {
    render(<MealPlanner canWrite />);
    await flush();
    input('Children', '6');
    recordedStock = 8;
    await flush();
    vi.mocked(axios.put).mockRejectedValueOnce(new Error('Storage unavailable'));
    fireEvent.click(saveButton());
    await flush();
    expect(screen.getByText('Storage unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Children')).toHaveValue(6);
    expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('8 count');
    expect(screen.getByText('Draft — unsaved changes')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it.each(['-1', '1.5', ''])('rejects invalid headcount %s without requests', async (value) => {
    render(<MealPlanner canWrite />);
    await flush();
    const previous = vi.mocked(axios.post).mock.calls.length;
    input('Children', value);
    await flush();
    expect(saveButton()).toBeDisabled();
    expect(printButton()).toBeDisabled();
    expect(axios.post).toHaveBeenCalledTimes(previous);
    expect(screen.queryByRole('spinbutton', { name: /in house/i })).not.toBeInTheDocument();
  });

  it('asks before discarding a draft and keeps it if the user cancels', async () => {
    render(<MealPlanner canWrite />);
    await flush();
    input('Children', '6');
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen saved week' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('Children')).toHaveValue(6);
  });

  it('accepts another date in the same week without stranding a pending calculation', async () => {
    render(<MealPlanner canWrite />);
    await flush();
    input('Children', '6');
    input('Week starting Monday', '2026-09-09');
    await flush();
    expect(screen.getByLabelText('Week starting Monday')).toHaveValue(firstWeek);
    expect(saveButton()).toBeEnabled();
    expect(within(table()).getByText('21 count')).toBeInTheDocument();
  });
});

it('blocks Save and Print with named recipe warnings and opens that meal for repair', async () => {
  vi.mocked(axios.post).mockResolvedValueOnce(response({ ...savedPlan(), warnings: [{
    day: 'Monday', slot: 'breakfast', mealId: 'eggs', mealName: 'Scrambled Eggs', message: 'Add recipe ingredients and quantities.',
  }], previewToken: undefined }));
  const edit = vi.fn();
  render(<MealPlanner canWrite onEditRecipe={edit} />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Update shopping list' }));
  await flush();
  expect(screen.getByRole('alert')).toHaveTextContent('Monday — Scrambled Eggs');
  expect(screen.getByText('Complete the recipes before saving or printing this shopping list.')).toBeInTheDocument();
  expect(saveButton()).toBeDisabled(); expect(printButton()).toBeDisabled();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('Updating the shopping list…')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit recipe for Scrambled Eggs' }));
  expect(edit).toHaveBeenCalledWith('eggs');
});

it('refreshes the catalog and calculation when returning from Meal Setup without losing the draft', async () => {
  render(<SignedIn><Meals /></SignedIn>); await flush();
  input('Children', '6'); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Meal Setup' }));
  const defaultGet = vi.mocked(axios.get).getMockImplementation()!;
  // The attendance panel also loads on return; match the catalog by URL, not request order.
  vi.mocked(axios.get).mockImplementation((path, config) =>
    path.endsWith('/api/meals')
      ? Promise.resolve(response([eggMeal, { ...oats, name: 'Corrected oatmeal' }]))
      : defaultGet(path, config));
  const prior = vi.mocked(axios.post).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Planner' }));
  expect(saveButton()).toBeDisabled(); await flush();
  expect(screen.getByLabelText('Children')).toHaveValue(6);
  expect(vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(prior);
  expect(screen.getAllByRole('option', { name: 'Corrected oatmeal' })).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Review today’s attendance count' })).toBeEnabled();
  expect(saveButton()).toBeEnabled();
});

it('keeps recipe refresh explicit for saved weeks and recalculates before saving corrections', async () => {
  render(<MealPlanner canWrite />); await flush();
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use current recipes' }));
  expect(saveButton()).toBeDisabled(); await flush();
  expect(vi.mocked(axios.post).mock.calls.at(-1)?.[1]).toHaveProperty('refreshRecipes', true);
  expect(screen.getByText('Draft — unsaved changes')).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
});

it('keeps saved stock historical until an explicit refresh and never writes inventory from the planner', async () => {
  recordedStock = 8;
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  render(<MealPlanner canWrite />); await flush();
  expect(within(table()).getByText('13 count')).toBeInTheDocument();
  expect(screen.getByText('This is your saved shopping list. Update it to use today’s amounts.', { exact: false })).toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(printButton()); expect(print).toHaveBeenCalledOnce();
  expect(axios.put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Update shopping list' }));
  expect(printButton()).toBeDisabled(); await flush();
  expect(within(table()).getByText('7 count')).toBeInTheDocument();
  expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('8 count');
  expect(screen.queryByRole('spinbutton', { name: /in house/i })).not.toBeInTheDocument();
  expect(vi.mocked(axios.post).mock.calls[0][1]).not.toHaveProperty('inHouse');
  expect(vi.mocked(axios.post).mock.calls.every(([path]) => path.endsWith('/preview'))).toBe(true);
  expect(axios.put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen saved week' })); await flush();
  expect(within(table()).getByText('13 count')).toBeInTheDocument();
});

it('refreshes a draft when returning from Inventory but keeps saved shopping unchanged', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  render(<MealPlanner canWrite />); await flush();
  recordedStock = 6; fireEvent(window, new Event('focus')); await flush();
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('2 count');
  input('Children', '5'); await flush();
  expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('6 count');
  recordedStock = 8; fireEvent(window, new Event('focus')); await flush();
  expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('8 count');
  expect(screen.getByLabelText('Children')).toHaveValue(5);
  recordedStock = 9; fireEvent(window, new StorageEvent('storage', { key: 'skao.inventory.changed', newValue: 'changed' })); await flush();
  expect(screen.getByLabelText('Eggs recorded stock')).toHaveTextContent('9 count');
  expect(axios.put).not.toHaveBeenCalled();
});
