import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import PurchasingReceiptProgress from './PurchasingReceiptProgress';
import { getPurchasingFulfillment, type PurchasingFulfillment } from '../../api/batchPurchases';
vi.mock('../../api/batchPurchases', () => ({ getPurchasingFulfillment: vi.fn() }));
const weekStart = '2026-10-12';
const stockTakenAt = '2026-10-12T08:00:00Z';
const value = (): PurchasingFulfillment => ({ weekStart, version: 2, stockTakenAt, lines: [{ id: 'stock:paper', itemId: 'paper', name: 'Paper', location: 'Art shelf', unit: 'count', buyQuantity: '8', receivedQuantity: '2', remainingQuantity: '6', selected: true }], batches: [], note: 'Only deliveries linked to this stock baseline count.' });
beforeEach(() => { vi.mocked(getPurchasingFulfillment).mockReset().mockResolvedValue(value()); });
test('received progress belongs to the saved version and stock baseline, with a receiving link for writers', async () => {
  render(<MemoryRouter><PurchasingReceiptProgress weekStart={weekStart} version={2} stockTakenAt={stockTakenAt} canReceive /></MemoryRouter>);
  expect(await screen.findByText('Received 2 count · Remaining 6 count')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Receive purchases' })).toHaveAttribute('href', '/receiving?week=' + weekStart);
  expect(getPurchasingFulfillment).toHaveBeenCalledWith(weekStart, expect.any(AbortSignal));
});
test('a viewer can inspect partial progress while write links stay hidden', async () => {
  render(<MemoryRouter><PurchasingReceiptProgress weekStart={weekStart} version={2} stockTakenAt={stockTakenAt} canReceive={false} /></MemoryRouter>);
  await screen.findByText('Received 2 count · Remaining 6 count'); expect(screen.queryByRole('link', { name: 'Receive purchases' })).not.toBeInTheDocument();
});
test('another saved version or recalculated baseline never displays misleading old receipt totals', async () => {
  vi.mocked(getPurchasingFulfillment).mockResolvedValue({ ...value(), stockTakenAt: '2026-10-13T08:00:00Z' });
  render(<MemoryRouter><PurchasingReceiptProgress weekStart={weekStart} version={2} stockTakenAt={stockTakenAt} canReceive /></MemoryRouter>);
  await screen.findByText('The saved purchasing list changed. Reopen it to see matching received amounts.');
  expect(screen.queryByText('Received 2 count · Remaining 6 count')).not.toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'Receive purchases' })).not.toBeInTheDocument();
});
test('failed progress loading can be retried without changing stock or the purchasing list', async () => {
  vi.mocked(getPurchasingFulfillment).mockRejectedValueOnce(new Error('Offline'));
  render(<MemoryRouter><PurchasingReceiptProgress weekStart={weekStart} version={2} stockTakenAt={stockTakenAt} canReceive /></MemoryRouter>);
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry received amounts' }));
  await screen.findByText('Received 2 count · Remaining 6 count'); expect(getPurchasingFulfillment).toHaveBeenCalledTimes(2);
});
test('a late progress response from the old list cannot replace the new version', async () => {
  let resolveOld!: (result: PurchasingFulfillment) => void;
  vi.mocked(getPurchasingFulfillment).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ ...value(), version: 3, lines: [] });
  const component = render(<MemoryRouter><PurchasingReceiptProgress weekStart={weekStart} version={2} stockTakenAt={stockTakenAt} canReceive /></MemoryRouter>);
  component.rerender(<MemoryRouter><PurchasingReceiptProgress weekStart={weekStart} version={3} stockTakenAt={stockTakenAt} canReceive /></MemoryRouter>);
  await screen.findByText(value().note); await act(async () => resolveOld(value())); expect(screen.queryByText('Received 2 count · Remaining 6 count')).not.toBeInTheDocument();
});
