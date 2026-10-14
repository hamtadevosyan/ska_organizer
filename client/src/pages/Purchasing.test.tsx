import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Purchasing from './Purchasing';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import { UnsavedChangesContext } from '../components/UnsavedChangesContext';
import { getPurchasingList, getPurchasingOptions, previewPurchasingList, purchasingCsv, savePurchasingList } from '../api/purchasing';
import type { PurchasingList, PurchasingOptions } from '../api/purchasing';

vi.mock('../api/purchasing', async importOriginal => ({ ...await importOriginal<typeof import('../api/purchasing')>(),
  getPurchasingList: vi.fn(), getPurchasingOptions: vi.fn(), previewPurchasingList: vi.fn(), savePurchasingList: vi.fn(),
}));
const week = '2027-02-01';
const report = vi.fn();
const choices: PurchasingOptions = { rooms: [{ id: 'room-one', name: 'Sunflowers', archived: false }, { id: 'room-two', name: 'Stars', archived: false }],
  lowStock: [{ id: 'stock-one', name: 'Flour stock', location: 'Kitchen', unit: 'g', quantity: '5', reorderThreshold: '8', version: 1 }] };
const snapshot = (): PurchasingList => ({ weekStart: week, version: 1, savedAt: '2027-01-30T12:00:00.000Z', stockTakenAt: '2027-01-30T11:59:00.000Z',
  includeMeals: true, roomIds: ['room-one'], lowStockTargets: [], mealPlan: { version: 2, savedAt: '2027-01-29T12:00:00.000Z' },
  activityPlans: [{ roomId: 'room-one', roomName: 'Sunflowers', version: 3, savedAt: '2027-01-29T13:00:00.000Z' }], issues: [], lines: [
    { id: 'stock:stock-one', itemId: 'stock-one', ingredientId: 'flour', name: 'Flour stock', location: 'Kitchen', unit: 'g',
      needed: '10', inStorage: '5', toBuy: '5', buyQuantity: '5', selected: true, checked: false,
      stockItems: [{ id: 'stock-one', name: 'Flour stock', location: 'Kitchen', unit: 'g', quantity: '5', version: 1, allocated: '5' }],
      sources: [{ kind: 'meal', label: 'Monday lunch', quantity: '6', unit: 'g' }, { kind: 'activity', label: 'Sunflowers art', quantity: '4', unit: 'g', date: week, roomId: 'room-one' }], notes: [] },
    { id: 'stock:stock-two', itemId: 'stock-two', ingredientId: null, name: 'Paint brushes', location: 'Art room', unit: 'count',
      needed: '5', inStorage: '2', toBuy: '3', buyQuantity: '3', selected: true, checked: false, stockItems: [],
      sources: [{ kind: 'activity', label: 'Sunflowers painting', quantity: '5', unit: 'count', reusable: true, date: week }], notes: ['Equipment without saved times is conservatively counted for the full day.'] },
  ] });
const input = () => screen.getByLabelText('Buy quantity for Flour stock at Kitchen (g)');
const saveButton = () => screen.getByRole('button', { name: 'Save purchasing list' });
const refresh = () => screen.getByRole('button', { name: 'Refresh current stock' });
const checkoff = () => screen.getByRole('checkbox', { name: 'Checked off Flour stock at Kitchen' });
const responseError = (status: number, code: string, message: string) => ({ isAxiosError: true, response: { status, data: { error: { code, message } } } });
function mount(role: 'admin' | 'editor' | 'viewer' = 'admin') {
  return render(<MemoryRouter initialEntries={['/purchasing?week=' + week]}><SignedIn account={{ ...testAccount, role }}><UnsavedChangesContext.Provider value={report}><Purchasing /></UnsavedChangesContext.Provider></SignedIn></MemoryRouter>);
}
async function ready() {
  await screen.findByRole('region', { name: 'Purchasing review' });
  await waitFor(() => expect(refresh()).toBeEnabled());
}
function preview(value = snapshot()) { vi.mocked(previewPurchasingList).mockResolvedValue({ list: value, token: 'signed-preview' }); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPurchasingList).mockReset().mockResolvedValue(snapshot());
  vi.mocked(getPurchasingOptions).mockReset().mockResolvedValue(structuredClone(choices));
  vi.mocked(previewPurchasingList).mockReset();
  vi.mocked(savePurchasingList).mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('build uses explicit room choices and target total coverage, without changing any saved plan', async () => {
  vi.mocked(getPurchasingList).mockResolvedValue(null);
  const value = snapshot(); value.version = 0; value.savedAt = null; value.roomIds = ['room-two']; value.lowStockTargets = [{ itemId: 'stock-one', targetQuantity: '8' }]; preview(value);
  mount(); await screen.findByText('No purchasing list saved for this week. Choose your sources and build a review.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Stars' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Top up Flour stock at Kitchen' }));
  const target = screen.getByLabelText('Total coverage for Flour stock at Kitchen (g)');
  fireEvent.click(screen.getByRole('button', { name: 'Build purchasing list' }));
  expect(previewPurchasingList).not.toHaveBeenCalled(); expect(target).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(target, { target: { value: '8' } }); fireEvent.click(screen.getByRole('button', { name: 'Build purchasing list' }));
  await ready();
  expect(previewPurchasingList).toHaveBeenCalledWith(week, { includeMeals: true, roomIds: ['room-two'], lowStockTargets: [{ itemId: 'stock-one', targetQuantity: '8' }] }, expect.any(AbortSignal));
  expect(screen.getByText(/not an extra order or a desired remaining balance/)).toBeInTheDocument();
  expect(screen.getByText('Unsaved preview')).toBeInTheDocument(); expect(savePurchasingList).not.toHaveBeenCalled();
});

test('opening saved values never recalculates; quantity, selection and check-off save with the version only', async () => {
  mount(); await ready(); expect(previewPurchasingList).not.toHaveBeenCalled();
  expect(input()).toHaveValue('5');
  fireEvent.change(input(), { target: { value: '6' } }); fireEvent.click(checkoff());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Buy Paint brushes at Art room' }));
  const saved = snapshot(); saved.version = 2; saved.lines[0].buyQuantity = '6'; saved.lines[0].checked = true; saved.lines[1].selected = false;
  vi.mocked(savePurchasingList).mockResolvedValue(saved);
  fireEvent.click(saveButton()); await screen.findByText('Purchasing list saved. Stock and saved plans were not changed.');
  expect(savePurchasingList).toHaveBeenCalledWith(week, { version: 1, choices: [
    { id: 'stock:stock-one', buyQuantity: '6', selected: true, checked: true },
    { id: 'stock:stock-two', buyQuantity: '3', selected: false, checked: false },
  ] }, expect.any(AbortSignal));
  expect(screen.getByText('Saved version 2')).toBeInTheDocument(); expect(report).toHaveBeenLastCalledWith(false, false); expect(saveButton()).toBeDisabled();
});

test('explicit refresh preserves manual amounts, updates suggestions and clears stale check-off without saving', async () => {
  mount(); await ready(); fireEvent.change(input(), { target: { value: '6' } }); fireEvent.click(checkoff());
  const refreshed = snapshot(); refreshed.stockTakenAt = '2027-02-01T09:00:00.000Z'; refreshed.lines[0].inStorage = '1'; refreshed.lines[0].toBuy = '9'; refreshed.lines[0].buyQuantity = '9'; preview(refreshed);
  fireEvent.click(refresh()); await screen.findByText(/Current stock sampled/);
  expect(input()).toHaveValue('6'); expect(checkoff()).not.toBeChecked();
  expect(within(screen.getByRole('article', { name: 'Flour stock at Kitchen' })).getByText('9 g')).toBeInTheDocument();
  expect(savePurchasingList).not.toHaveBeenCalled();
  vi.mocked(savePurchasingList).mockResolvedValue({ ...refreshed, version: 2 });
  fireEvent.click(saveButton()); await screen.findByText('Saved version 2');
  expect(savePurchasingList).toHaveBeenCalledWith(week, expect.objectContaining({ version: 1, token: 'signed-preview', choices: expect.arrayContaining([expect.objectContaining({ buyQuantity: '6', checked: false })]) }), expect.any(AbortSignal));
});

test('source changes visibly keep the previous review and require refresh before saving, editing or export', async () => {
  mount(); await ready(); fireEvent.click(screen.getByRole('checkbox', { name: 'Include Stars' }));
  expect(screen.getByText(/list below still shows the previous choices/)).toBeInTheDocument();
  expect(saveButton()).toBeDisabled(); expect(input()).toBeDisabled(); expect(screen.getByRole('button', { name: 'Export selected CSV' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Print selected list' })).toBeDisabled();
});

test('a viewer can inspect and refresh snapshots but cannot edit sources, quantities or purchase marks', async () => {
  preview(); mount('viewer'); await ready();
  expect(screen.getByRole('checkbox', { name: 'Include Sunflowers' })).toBeDisabled(); expect(input()).toBeDisabled(); expect(checkoff()).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Save purchasing list' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export selected CSV' })).toBeEnabled();
  fireEvent.click(refresh()); await screen.findByText('Unsaved preview'); expect(savePurchasingList).not.toHaveBeenCalled();
});

test('preview and save requests disable edits and duplicate clicks cannot start another request', async () => {
  let resolve!: (value: { list: PurchasingList; token: string }) => void;
  vi.mocked(previewPurchasingList).mockImplementation(() => new Promise(done => { resolve = done; }));
  mount(); await ready(); fireEvent.click(refresh());
  expect(screen.getByLabelText('Purchasing week starting Monday')).toBeDisabled(); expect(input()).toBeDisabled(); expect(screen.getByRole('checkbox', { name: 'Include Stars' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Working…' })); expect(previewPurchasingList).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ list: snapshot(), token: 'preview' }));
  let saveResolve!: (value: PurchasingList) => void;
  vi.mocked(savePurchasingList).mockImplementation(() => new Promise(done => { saveResolve = done; }));
  fireEvent.click(saveButton()); expect(input()).toBeDisabled(); expect(screen.getByLabelText('Purchasing week starting Monday')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Saving…' })); expect(savePurchasingList).toHaveBeenCalledTimes(1);
  await act(async () => saveResolve({ ...snapshot(), version: 2 }));
  expect(input()).toHaveValue('5'); expect(report).toHaveBeenLastCalledWith(false, false);
});

test('a failed save keeps review entries for retry and a version conflict requires explicit reopen', async () => {
  mount(); await ready(); fireEvent.change(input(), { target: { value: '12' } });
  vi.mocked(savePurchasingList).mockRejectedValueOnce(new Error('Lost response')).mockRejectedValueOnce(responseError(409, 'PURCHASING_CONFLICT', 'This list changed elsewhere.'));
  fireEvent.click(saveButton()); await screen.findByRole('alert'); await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(input()).toHaveValue('12'); fireEvent.click(saveButton()); await screen.findByText('This list changed elsewhere.');
  expect(input()).toHaveValue('12'); expect(saveButton()).toBeDisabled(); expect(refresh()).toBeDisabled();
  expect(vi.mocked(savePurchasingList).mock.calls[1][1]).toEqual(vi.mocked(savePurchasingList).mock.calls[0][1]);
  const reopened = snapshot(); reopened.version = 3; reopened.lines[0].buyQuantity = '11'; vi.mocked(getPurchasingList).mockResolvedValue(reopened);
  fireEvent.click(screen.getByRole('button', { name: 'Reopen saved list' })); await screen.findByText('Saved version 3');
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Discard your unsaved purchasing review')); expect(input()).toHaveValue('11');
});

test('an expired preview allows refreshing current stock while retaining manual draft choices', async () => {
  preview(); mount(); await ready(); fireEvent.click(refresh()); await screen.findByText('Unsaved preview');
  fireEvent.change(input(), { target: { value: '7' } });
  vi.mocked(savePurchasingList).mockRejectedValueOnce(responseError(409, 'PURCHASING_PREVIEW_EXPIRED', 'Calculation expired; refresh before saving.'));
  fireEvent.click(saveButton()); await screen.findByText('Calculation expired; refresh before saving.');
  expect(input()).toHaveValue('7'); await waitFor(() => expect(refresh()).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Reopen saved list' })).not.toBeInTheDocument();
  fireEvent.click(refresh()); await waitFor(() => expect(previewPurchasingList).toHaveBeenCalledTimes(2)); await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(input()).toHaveValue('7');
});

test('unresolved recipe or material issues explain a corrective route and block saving, printing and export', async () => {
  const value = snapshot(); value.issues = [{ code: 'MISSING_RECIPE', message: 'Lunch has no saved recipe.', resolution: 'Complete the recipe and resave this week’s meal plan.', href: '/meals' }];
  vi.mocked(getPurchasingList).mockResolvedValue(value); mount(); await ready(); fireEvent.change(input(), { target: { value: '7' } });
  expect(screen.getByRole('region', { name: 'Purchasing issues' })).toHaveTextContent('Complete the recipe');
  expect(screen.getByRole('link', { name: 'Open the related record' })).toHaveAttribute('href', '/meals');
  expect(saveButton()).toBeDisabled(); expect(screen.getByRole('button', { name: 'Export selected CSV' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Print selected list' })).toBeDisabled();
});

test('an unavailable previously selected room can be explicitly removed and rebuilt', async () => {
  const value = snapshot(); value.roomIds = ['removed-room']; vi.mocked(getPurchasingList).mockResolvedValue(value); mount(); await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Remove previous room' }));
  expect(screen.queryByText(/previously selected room is unavailable/)).not.toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
});

test('late responses for an old week cannot replace the chosen week, and its query survives navigation', async () => {
  let oldResolve!: (value: PurchasingList | null) => void;
  vi.mocked(getPurchasingList).mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; })).mockResolvedValue({ ...snapshot(), weekStart: '2027-02-08' });
  mount(); await waitFor(() => expect(getPurchasingList).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Purchasing week starting Monday'), { target: { value: '2027-02-08' } });
  await screen.findByText('Purchasing list · Week of 2027-02-08');
  await act(async () => oldResolve(snapshot()));
  expect(screen.getByLabelText('Purchasing week starting Monday')).toHaveValue('2027-02-08');
  expect(screen.queryByText('Purchasing list · Week of ' + week)).not.toBeInTheDocument();
  expect(vi.mocked(getPurchasingList).mock.calls[0][1]?.aborted).toBe(true);
});

test('unsaved review and requests guard page close, and unmount removes the warning', async () => {
  const view = mount(); await ready(); fireEvent.change(input(), { target: { value: '7' } });
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  expect(report).toHaveBeenLastCalledWith(true, false);
  view.unmount(); const after = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false); expect(report).toHaveBeenLastCalledWith(false, false);
});

test('failed saved-list reads cannot be mistaken for an empty week and must be retried before building', async () => {
  vi.mocked(getPurchasingList).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(snapshot()); mount();
  await screen.findByText('Could not open this week’s purchasing list. Retry before making changes.');
  expect(screen.getByRole('button', { name: 'Build purchasing list' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry opening list' })); await ready();
  expect(input()).toHaveValue('5'); expect(previewPurchasingList).not.toHaveBeenCalled();
});

test('CSV exports selected lines only, neutralizes formula prefixes everywhere and distinguishes a draft', () => {
  const value = snapshot(); value.lines[1].selected = false; value.lines[0].name = ' \u200b＝SUM(1,2)'; value.lines[0].location = '\t=LINK';
  value.lines[0].sources[0].label = '＠unsafe'; value.lines[0].notes = ['-Formula', 'Quoted "note"'];
  const csv = purchasingCsv(value, true);
  expect(csv).toContain('"\' \u200b＝SUM(1,2)"'); expect(csv).toContain('"\'\t=LINK"'); expect(csv).toContain('"\'＠unsafe:'); expect(csv).toContain('"\'-Formula; Quoted ""note"""');
  expect(csv).not.toContain('Paint brushes'); expect(csv).toContain('Unsaved preview'); expect(csv).toContain(value.stockTakenAt);
  expect(purchasingCsv(value)).toContain('Saved version 1');
});


test('stock refresh selects a newly appearing shortage while keeping deliberate selection overrides', async () => {
  const old = snapshot(); old.lines[0].toBuy = '0'; old.lines[0].buyQuantity = '0'; old.lines[0].selected = false;
  vi.mocked(getPurchasingList).mockResolvedValue(old); preview(); mount(); await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Buy Paint brushes at Art room' }));
  fireEvent.click(refresh()); await screen.findByText(/Current stock sampled/);
  expect(screen.getByRole('checkbox', { name: 'Buy Flour stock at Kitchen' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Buy Paint brushes at Art room' })).not.toBeChecked();
});

test('refresh detecting a newer saved version keeps the existing local review for explicit reopen', async () => {
  const changed = snapshot(); changed.version = 2; changed.lines[0].buyQuantity = '8'; preview(changed);
  mount(); await ready(); fireEvent.change(input(), { target: { value: '7' } }); fireEvent.click(refresh());
  await screen.findByText('This purchasing list changed elsewhere. Reopen the saved list before building another review.');
  expect(input()).toHaveValue('7'); expect(saveButton()).toBeDisabled(); expect(refresh()).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reopen saved list' })).toBeEnabled(); expect(savePurchasingList).not.toHaveBeenCalled();
});

test('an unresolved viewer preview with no save token is labelled as unsaved, including export eligibility', async () => {
  const value = snapshot(); value.savedAt = null; value.version = 0; value.issues = [{ code: 'MISSING_PLAN', message: 'A saved meal plan is missing.', resolution: 'Save this week’s plan first.' }];
  vi.mocked(getPurchasingList).mockResolvedValue(null);
  vi.mocked(previewPurchasingList).mockResolvedValue({ list: value, token: '' });
  mount('viewer'); await screen.findByText('No purchasing list saved for this week. Choose your sources and build a review.');
  fireEvent.click(screen.getByRole('button', { name: 'Build purchasing list' }));
  await screen.findByText('Unsaved preview'); expect(screen.queryByText('Saved version 0')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Export selected CSV' })).toBeDisabled();
});
