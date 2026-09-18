import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { PurchaseReceiptForm } from './PurchaseReceiptForm';
import { PurchaseHistory } from './PurchaseHistory';
import type { InventoryItem, PurchaseReceipt } from '../../api/inventory';

vi.mock('axios');
const timestamp = '2026-09-16T17:00:00Z';
const item: InventoryItem = { id: 'stock-one', name: 'Paper', category: 'Classroom', groupId: 'group-one',
  group: { id: 'group-one', name: 'Classroom', kind: 'supplies', description: '', createdAt: timestamp, updatedAt: timestamp },
  location: 'Studio / Shelf 1', unit: 'pack', ingredientId: null, ingredient: null, quantity: '10', reorderThreshold: '2',
  version: 1, status: 'available', createdAt: timestamp, updatedAt: timestamp };
const receipt: PurchaseReceipt = { id: 'receipt-one', itemId: item.id, movementId: 'movement-two', quantity: '2', unit: 'pack',
  receivedOn: '2026-09-16', supplier: 'Synthetic shop', totalCost: '12.50', currency: 'USD', itemSnapshot: { ...item, quantity: '12', version: 2 },
  actorId: 'admin-one', actorUsername: 'test-admin', recordedAt: timestamp };
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const props = () => ({ item, onCancel: vi.fn(), onSaved: vi.fn(), onBusy: vi.fn(), onReload: vi.fn() });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(axios.isAxiosError).mockImplementation((error): error is import('axios').AxiosError => !!error && typeof error === 'object' && 'response' in error);
  vi.mocked(axios.get).mockResolvedValue({ data: { today: '2026-09-16', timeZone: 'America/Los_Angeles' } });
});

it('retains a lost receipt response for an identical retry, with the same request identifier', async () => {
  const callbacks = props(); render(<PurchaseReceiptForm {...callbacks} />);
  await waitFor(() => expect(screen.getByLabelText('Received date')).toHaveValue('2026-09-16'));
  fireEvent.click(screen.getByText('Date, cost or notes (optional)', { selector: 'summary' }));
  fill('How much did you buy? (packs)', '2'); fill('Supplier (optional)', 'Synthetic shop'); fill('Total cost (USD, optional)', '12.50');
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce({ data: { data: { receipt, item: { ...item, quantity: '12', version: 2 }, replayed: true } } });
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('How much did you buy? (packs)')).toHaveValue('2');
  expect(screen.getByLabelText('Total cost (USD, optional)')).toHaveValue('12.50');
  expect(callbacks.onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledWith(expect.objectContaining({ quantity: '12', version: 2 })));
  const calls = vi.mocked(axios.post).mock.calls;
  expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[0][1]).toMatchObject({ quantity: '2', unit: 'pack', receivedOn: '2026-09-16', totalCost: '12.50', version: 1, requestId: expect.any(String) });
});

it('rejects invalid quantity/cost before sending and preserves a conflict until explicit reload', async () => {
  const callbacks = props(); render(<PurchaseReceiptForm {...callbacks} />);
  await waitFor(() => expect(screen.getByLabelText('Received date')).toHaveValue('2026-09-16'));
  fireEvent.click(screen.getByText('Date, cost or notes (optional)', { selector: 'summary' }));
  fill('How much did you buy? (packs)', '-1'); fill('Total cost (USD, optional)', '1.005');
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByLabelText('How much did you buy? (packs)')).toHaveAttribute('aria-invalid', 'true');
  fill('How much did you buy? (packs)', '1'); fill('Total cost (USD, optional)', '');
  vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 409, data: { error: { code: 'INVENTORY_CONFLICT', message: 'Stock changed elsewhere.' } } } });
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  await screen.findByText('Stock changed elsewhere.');
  expect(screen.getByLabelText('How much did you buy? (packs)')).toHaveValue('1');
  expect(screen.getByRole('button', { name: 'Save amount' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload inventory item' }));
  expect(callbacks.onReload).toHaveBeenCalledOnce();
});

it('purchase history retries errors and displays received details without edit controls', async () => {
  vi.mocked(axios.get).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({ data: {
    items: [receipt], total: 1, page: 1, pageSize: 25, today: '2026-09-16', timeZone: 'America/Los_Angeles',
  } });
  render(<PurchaseHistory itemId={item.id} itemName={item.name} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry purchases' }));
  expect(await screen.findByText('12.50 USD')).toBeInTheDocument();
  expect(screen.getByText('2 pack')).toBeInTheDocument();
  expect(screen.getByText('Studio / Shelf 1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /edit|delete/i })).not.toBeInTheDocument();
  expect(vi.mocked(axios.get).mock.calls.at(-1)?.[1]).toMatchObject({ params: { itemId: item.id, page: 1, pageSize: 25 } });
});

it('an everyday purchase needs only the amount and uses the facility date automatically', async () => {
  const callbacks = props(); render(<PurchaseReceiptForm {...callbacks} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save amount' })).toBeEnabled());
  expect(screen.getByLabelText('Received date')).not.toBeVisible();
  expect(screen.getByLabelText('Total cost (USD, optional)')).not.toBeVisible();
  fill('How much did you buy? (packs)', '2');
  expect(screen.getByText(/After saving:/)).toHaveTextContent('12 packs.');
  expect(axios.post).not.toHaveBeenCalled();
  vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: { receipt, item: { ...item, quantity: '12', version: 2 }, replayed: false } } });
  fireEvent.click(screen.getByRole('button', { name: 'Save amount' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalled());
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ quantity: '2', receivedOn: '2026-09-16', supplier: '', totalCost: null, reason: 'Purchase received' });
});
