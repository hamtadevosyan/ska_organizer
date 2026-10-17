import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Receiving from './Receiving';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import { UnsavedChangesContext } from '../components/UnsavedChangesContext';
import { getBatchByRequest, getBatchReceipt, getPurchasingFulfillment, getReceivingHistory, getReceivingItems, previewBatchReceipt, recordBatchReceipt } from '../api/batchPurchases';
import type { BatchLine, BatchReceipt, BatchRequest, BatchReview, PurchasingFulfillment } from '../api/batchPurchases';
import type { InventoryItem } from '../api/inventory';
vi.mock('../api/batchPurchases', () => ({ getBatchByRequest: vi.fn(), getBatchReceipt: vi.fn(), getPurchasingFulfillment: vi.fn(), getReceivingHistory: vi.fn(), getReceivingItems: vi.fn(), previewBatchReceipt: vi.fn(), recordBatchReceipt: vi.fn() }));
const report = vi.fn();
const week = '2026-10-12';
let actor = 0;
const item = (id: string, name: string, location: string, unit = 'count'): InventoryItem => ({ id, name, location, unit, quantity: '3', version: 1, category: 'Supplies', ingredientId: null, ingredient: null,
  groupId: 'supplies', group: { id: 'supplies', name: 'Supplies', kind: 'supplies', description: '', createdAt: '', updatedAt: '' }, reorderThreshold: '2', status: 'available', createdAt: '', updatedAt: '' });
const stock = [item('paper', 'Paper', 'Art shelf'), item('flour', 'Flour', 'Kitchen', 'g')];
const fulfillment = (): PurchasingFulfillment => ({ weekStart: week, version: 2, stockTakenAt: '2026-10-12T08:00:00Z', lines: [
  { id: 'stock:paper', itemId: 'paper', name: 'Paper', location: 'Art shelf', unit: 'count', buyQuantity: '8', receivedQuantity: '2', remainingQuantity: '6', selected: true },
], batches: [], note: 'Only receipts linked to this stock baseline count toward these amounts.' });
const batchLine = (line: BatchRequest['lines'][number]): BatchLine => ({ itemId: line.itemId, name: stock.find(item => item.id === line.itemId)!.name, location: stock.find(item => item.id === line.itemId)!.location,
  quantity: line.quantity, unit: line.unit, stockUnit: stock.find(item => item.id === line.itemId)!.unit, stockDelta: line.quantity, beforeQuantity: '3', afterQuantity: '5', totalCost: line.totalCost,
  versionBefore: line.version, versionAfter: line.version + 1, purchasingLineId: line.purchasingLineId || null, plannedQuantity: line.purchasingLineId ? '8' : null,
  previouslyReceived: line.purchasingLineId ? '2' : null, remainingQuantity: line.purchasingLineId ? '6' : null, notes: [] });
const makeReview = (request: BatchRequest): BatchReview => ({ request: structuredClone(request), lines: request.lines.map(batchLine), purchasingRef: null });
const receipt = (request?: BatchRequest): BatchReceipt => ({ id: 'batch-one', receivedOn: '2026-10-15', supplier: null, reason: 'Purchase received', currency: 'USD', actorId: 'admin', actorUsername: 'admin',
  recordedAt: '2026-10-15T12:00:00Z', purchasingRef: null, lines: request ? request.lines.map(batchLine) : [batchLine({ itemId: 'paper', version: 1, quantity: '2', unit: 'count', totalCost: null })] });
function mount(role: 'admin' | 'editor' | 'viewer' = 'admin', path = '/receiving', accountId = 'receiving-test-' + ++actor) {
  return render(<MemoryRouter initialEntries={[path]}><SignedIn account={{ ...testAccount, id: accountId, role }}><UnsavedChangesContext.Provider value={report}><Receiving /></UnsavedChangesContext.Provider></SignedIn></MemoryRouter>);
}
async function add(id = 'paper') {
  const select = await screen.findByLabelText('Inventory item and location');
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: id } }); fireEvent.click(screen.getByRole('button', { name: 'Add inventory item' }));
}
const quantity = (name = 'Paper at Art shelf') => screen.getByLabelText('Received quantity for ' + name);
const errorResponse = (status: number, message: string) => ({ isAxiosError: true, response: { status, data: { error: { message } } } });
async function readyReview() {
  await add(); fireEvent.change(quantity(), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review receipt' }));
  await screen.findByRole('region', { name: 'Receipt review' });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getReceivingItems).mockReset().mockResolvedValue(structuredClone(stock));
  vi.mocked(getReceivingHistory).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10, today: '2026-10-15', timeZone: 'America/Los_Angeles' });
  vi.mocked(getPurchasingFulfillment).mockReset().mockResolvedValue(fulfillment());
  vi.mocked(getBatchReceipt).mockReset().mockResolvedValue(receipt());
  vi.mocked(getBatchByRequest).mockReset().mockResolvedValue(null);
  vi.mocked(previewBatchReceipt).mockReset().mockImplementation(async request => makeReview(request));
  vi.mocked(recordBatchReceipt).mockReset().mockImplementation(async request => ({ batch: receipt(request), replayed: false }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('multiple actual amounts start blank, review leaves stock untouched, and a single record confirms the batch', async () => {
  mount('editor'); await add(); await add('flour');
  expect(quantity()).toHaveValue(''); expect(quantity('Flour at Kitchen')).toHaveValue('');
  fireEvent.change(quantity(), { target: { value: '2' } }); fireEvent.change(quantity('Flour at Kitchen'), { target: { value: '1.5' } });
  fireEvent.change(screen.getByLabelText('Received unit for Flour at Kitchen'), { target: { value: 'lb' } });
  fireEvent.change(screen.getByLabelText('Supplier (optional)'), { target: { value: 'Local store' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review receipt' }));
  const review = await screen.findByRole('region', { name: 'Receipt review' });
  expect(recordBatchReceipt).not.toHaveBeenCalled(); expect(within(review).getAllByText(/Total cost: Not recorded/)).toHaveLength(2);
  expect(previewBatchReceipt).toHaveBeenCalledWith(expect.objectContaining({ supplier: 'Local store', receivedOn: '2026-10-15', lines: [
    { itemId: 'paper', version: 1, quantity: '2', unit: 'count', totalCost: null }, { itemId: 'flour', version: 1, quantity: '1.5', unit: 'lb', totalCost: null },
  ] }), expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button', { name: 'Record receipt' })); await screen.findByText('Receipt recorded. Inventory updated for 2 items.');
  expect(recordBatchReceipt).toHaveBeenCalledTimes(1); expect(vi.mocked(recordBatchReceipt).mock.calls[0][0]).toEqual(vi.mocked(previewBatchReceipt).mock.calls[0][0]);
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false)); expect(screen.getByRole('link', { name: 'View recorded receipt' })).toHaveAttribute('href', '/receiving?receipt=batch-one');
});

test('planned items retain explicit location and partial progress but never prefill the actual delivery', async () => {
  mount('admin', '/receiving?week=' + week);
  const addPlanned = await screen.findByRole('button', { name: 'Add selected purchasing items' }); await waitFor(() => expect(addPlanned).toBeEnabled()); fireEvent.click(addPlanned);
  expect(quantity()).toHaveValue(''); expect(screen.getByText('Received 2 count · Remaining 6 count')).toBeInTheDocument();
  fireEvent.change(quantity(), { target: { value: '1' } }); fireEvent.click(screen.getByRole('button', { name: 'Review receipt' }));
  await screen.findByRole('region', { name: 'Receipt review' });
  expect(previewBatchReceipt).toHaveBeenCalledWith(expect.objectContaining({ purchasingRef: { weekStart: week, version: 2 }, lines: [expect.objectContaining({ itemId: 'paper', quantity: '1', purchasingLineId: 'stock:paper' })] }), expect.any(AbortSignal));
  expect(recordBatchReceipt).not.toHaveBeenCalled();
});

test('positive exact amounts are required and incompatible package or volume conversions are unavailable', async () => {
  mount(); await add('flour');
  const unit = screen.getByLabelText('Received unit for Flour at Kitchen');
  expect(within(unit).getAllByRole('option').map(option => option.textContent)).toEqual(['g', 'oz', 'lb']);
  fireEvent.click(screen.getByRole('button', { name: 'Review receipt' })); expect(quantity('Flour at Kitchen')).toHaveAttribute('aria-invalid', 'true');
  expect(previewBatchReceipt).not.toHaveBeenCalled();
  fireEvent.change(quantity('Flour at Kitchen'), { target: { value: '0' } }); fireEvent.click(screen.getByRole('button', { name: 'Review receipt' })); expect(previewBatchReceipt).not.toHaveBeenCalled();
  fireEvent.change(quantity('Flour at Kitchen'), { target: { value: '1.1234567' } }); fireEvent.click(screen.getByRole('button', { name: 'Review receipt' })); expect(previewBatchReceipt).not.toHaveBeenCalled();
});

test('a lost commit response freezes its exact request through failed retries and a null status lookup', async () => {
  vi.mocked(recordBatchReceipt).mockRejectedValueOnce(new Error('Connection lost')).mockRejectedValueOnce(errorResponse(429, 'Try later'));
  mount(); await readyReview(); fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
  await screen.findByRole('region', { name: 'Unconfirmed receipt' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same receipt' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Back to edit' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Cancel receipt' })).toBeDisabled();
  expect(screen.getByLabelText('Supplier (optional)')).toBeDisabled(); expect(report).toHaveBeenLastCalledWith(true, true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry same receipt' })); await screen.findByText('Try later');
  expect(screen.getByRole('region', { name: 'Unconfirmed receipt' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check receipt status' })); await screen.findByText(/No confirmed receipt was found yet/);
  expect(screen.getByRole('button', { name: 'Cancel receipt' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry same receipt' })); await screen.findByText('Receipt recorded. Inventory updated for 1 items.');
  const calls = vi.mocked(recordBatchReceipt).mock.calls; expect(calls).toHaveLength(3); expect(calls[1][0]).toEqual(calls[0][0]); expect(calls[2][0]).toEqual(calls[0][0]);
});

test('an initial version conflict preserves quantities and refresh requires a new reviewed request', async () => {
  vi.mocked(recordBatchReceipt).mockRejectedValueOnce(errorResponse(409, 'Stock changed'));
  mount(); await readyReview(); fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
  await screen.findByText('Stock changed'); expect(quantity()).toHaveValue('2');
  expect(screen.getByRole('button', { name: 'Review receipt' })).toBeDisabled();
  vi.mocked(getReceivingItems).mockResolvedValue(stock.map(value => ({ ...value, version: 2, quantity: '4' })));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh stock versions' })); await screen.findByText(/Stock versions refreshed/);
  expect(quantity()).toHaveValue('2'); fireEvent.click(screen.getByRole('button', { name: 'Review receipt' })); await screen.findByRole('region', { name: 'Receipt review' });
  const previews = vi.mocked(previewBatchReceipt).mock.calls; expect(previews[1][0].requestId).not.toBe(previews[0][0].requestId); expect(previews[1][0].lines[0]).toMatchObject({ quantity: '2', version: 2 });
});

test('an uncertain receipt survives an auth-screen unmount for the same account and resolves by status', async () => {
  vi.mocked(recordBatchReceipt).mockRejectedValueOnce(new Error('Lost response'));
  const first = mount('admin', '/receiving', 'same-actor'); await readyReview(); fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
  await screen.findByRole('region', { name: 'Unconfirmed receipt' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same receipt' })).toBeEnabled()); first.unmount();
  mount('viewer', '/receiving', 'same-actor');
  expect(screen.getByRole('region', { name: 'Unconfirmed receipt' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Retry same receipt' })).toBeDisabled();
  vi.mocked(getBatchByRequest).mockResolvedValue(receipt()); fireEvent.click(screen.getByRole('button', { name: 'Check receipt status' }));
  await screen.findByText('Receipt recorded. Inventory updated for 1 items.'); expect(recordBatchReceipt).toHaveBeenCalledTimes(1);
});

test('viewers inspect historic balances and history without receiving controls or write calls', async () => {
  vi.mocked(getReceivingHistory).mockResolvedValue({ items: [receipt()], total: 1, page: 1, pageSize: 10, today: '2026-10-15', timeZone: 'America/Los_Angeles' });
  mount('viewer', '/receiving?receipt=batch-one');
  const detail = await screen.findByRole('region', { name: 'Recorded receipt' }); await within(detail).findByText('Paper');
  expect(within(detail).getByText('These balances are the original receipt record, not current inventory.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Receipt draft' })).not.toBeInTheDocument(); expect(getReceivingItems).not.toHaveBeenCalled();
  expect(previewBatchReceipt).not.toHaveBeenCalled(); expect(recordBatchReceipt).not.toHaveBeenCalled();
  expect(await screen.findByRole('link', { name: 'View receipt batch-one' })).toHaveAttribute('href', '/receiving?receipt=batch-one');
});

test('cancel asks before discarding and never changes inventory; Back to edit keeps entered amounts', async () => {
  mount(); await readyReview(); fireEvent.click(screen.getByRole('button', { name: 'Back to edit' })); expect(quantity()).toHaveValue('2');
  vi.mocked(window.confirm).mockReturnValueOnce(false); fireEvent.click(screen.getByRole('button', { name: 'Cancel receipt' })); expect(quantity()).toHaveValue('2');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel receipt' })); expect(screen.queryByRole('article', { name: 'Paper at Art shelf' })).not.toBeInTheDocument();
  expect(previewBatchReceipt).toHaveBeenCalledTimes(1); expect(recordBatchReceipt).not.toHaveBeenCalled(); expect(report).toHaveBeenLastCalledWith(false, false);
});

test('busy refs reject duplicate preview/commit clicks while requests are pending', async () => {
  let resolvePreview!: (review: BatchReview) => void;
  vi.mocked(previewBatchReceipt).mockImplementation(request => new Promise(resolve => { resolvePreview = () => resolve(makeReview(request)); }));
  mount(); await add(); fireEvent.change(quantity(), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review receipt' })); fireEvent.click(screen.getByRole('button', { name: 'Reviewing…' })); expect(previewBatchReceipt).toHaveBeenCalledTimes(1);
  await act(async () => resolvePreview(makeReview(vi.mocked(previewBatchReceipt).mock.calls[0][0])));
  let resolveCommit!: (value: { batch: BatchReceipt; replayed: boolean }) => void;
  vi.mocked(recordBatchReceipt).mockImplementation(() => new Promise(resolve => { resolveCommit = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Record receipt' })); fireEvent.click(screen.getByRole('button', { name: 'Recording…' })); expect(recordBatchReceipt).toHaveBeenCalledTimes(1);
  await act(async () => resolveCommit({ batch: receipt(), replayed: false })); await screen.findByText('Receipt recorded. Inventory updated for 1 items.');
});

test('an uncertain receipt stays private to its account when another user signs in', async () => {
  vi.mocked(recordBatchReceipt).mockRejectedValueOnce(new Error('Lost response'));
  const first = mount('admin', '/receiving', 'private-actor'); await readyReview(); fireEvent.click(screen.getByRole('button', { name: 'Record receipt' }));
  await screen.findByRole('region', { name: 'Unconfirmed receipt' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same receipt' })).toBeEnabled()); first.unmount();
  const other = mount('viewer', '/receiving', 'other-actor'); await screen.findByText('No receipts recorded yet.');
  expect(screen.queryByRole('region', { name: 'Unconfirmed receipt' })).not.toBeInTheDocument(); other.unmount();
  mount('admin', '/receiving', 'private-actor');
  expect(screen.getByRole('region', { name: 'Unconfirmed receipt' })).toBeInTheDocument();
  vi.mocked(getBatchByRequest).mockResolvedValue(receipt()); fireEvent.click(screen.getByRole('button', { name: 'Check receipt status' }));
  await screen.findByText('Receipt recorded. Inventory updated for 1 items.');
});

test('an archived purchasing destination keeps its received history visible and cannot be added to a new receipt', async () => {
  const value = fulfillment(); value.lines[0].unavailable = true; value.lines[0].availabilityMessage = 'This inventory record is archived. Refresh purchasing before receiving.';
  vi.mocked(getPurchasingFulfillment).mockResolvedValue(value);
  vi.mocked(getReceivingItems).mockResolvedValue(stock.filter(item => item.id !== 'paper'));
  mount('admin', '/receiving?week=' + week);
  expect(await screen.findByText(value.lines[0].availabilityMessage)).toBeInTheDocument();
  expect(screen.getByText('Received 2 count · Remaining 6 count')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add selected purchasing items' })).toBeDisabled();
  expect(screen.queryByLabelText('Received quantity for Paper at Art shelf')).not.toBeInTheDocument();
  expect(previewBatchReceipt).not.toHaveBeenCalled(); expect(recordBatchReceipt).not.toHaveBeenCalled();
});
