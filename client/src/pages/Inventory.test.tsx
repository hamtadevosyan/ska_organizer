import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Inventory from './Inventory';
import type { InventoryItem, InventoryList, StockMovement } from '../api/inventory';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';

vi.mock('axios');
const stock: InventoryItem = { id: 'stock-one', name: 'Synthetic paper', category: 'Art supplies', location: 'Studio / Shelf 2',
  unit: 'pack', ingredientId: null, ingredient: null, quantity: '10', reorderThreshold: '2', status: 'available', version: 1,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
const opening: StockMovement = { id: 'movement-one', itemId: stock.id, itemVersion: 1, type: 'opening',
  beforeQuantity: '0', afterQuantity: '10', delta: '10', before: null, after: stock,
  reason: 'Initial physical count', actorId: 'admin', actorUsername: 'test-admin', occurredAt: '2026-09-01T00:00:00.000Z' };
let items: InventoryItem[];
let movements: StockMovement[];
const response = (data: unknown) => ({ data: { data } });
const renderInventory = () => render(<SignedIn><Inventory /></SignedIn>);
const row = (name = stock.name) => screen.getByRole('button', { name: 'History for ' + name }).closest('tr')!;
const type = (name: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const choose = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Record stock change' });

beforeEach(() => {
  vi.resetAllMocks(); items = [structuredClone(stock)]; movements = [structuredClone(opening)];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/ingredients')) return response([{ id: 'ingredient-oats', name: 'Oats', unit: 'lb', archived: false }]);
    if (url.endsWith('/inventory')) {
      const params = config?.params as { q?: string; category?: string; location?: string; status: string; page: number; pageSize: number };
      const matches = items.filter((item) => (!params.q || item.name.toLowerCase().includes(params.q.toLowerCase())) &&
        (!params.category || item.category === params.category) && (!params.location || item.location === params.location) &&
        (params.status === 'all' || item.status === params.status));
      return { data: { items: matches.slice((params.page - 1) * params.pageSize, params.page * params.pageSize), total: matches.length,
        page: params.page, pageSize: params.pageSize, summary: { total: items.length, available: items.filter((item) => item.status === 'available').length,
          lowStock: items.filter((item) => item.status === 'low').length, outOfStock: items.filter((item) => item.status === 'out').length },
        options: { categories: [...new Set(items.map((item) => item.category))], locations: [...new Set(items.map((item) => item.location))] } } satisfies InventoryList };
    }
    if (url.endsWith('/movements')) return { data: { item: items[0], items: movements, total: movements.length, page: 1, pageSize: 25 } };
    if (url.includes('/inventory/')) return response(items.find((item) => url.endsWith('/' + item.id)));
    throw new Error('Unexpected GET: ' + url);
  });
});

test('requires opening details and reason, then links food by ingredient ID in its recorded unit', async () => {
  renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Add inventory item' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save inventory item' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Correct the highlighted inventory details.');
  type(/^Item name/, '  Synthetic oats  '); type(/^Category/, 'Food'); type(/^Exact storage location/, 'Kitchen / Pantry / Shelf 2');
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ingredient link (optional)' })).toBeEnabled());
  choose('Ingredient link (optional)', 'ingredient-oats');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('lb');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toBeDisabled();
  type('Opening count', '0.5'); type('Reorder threshold', '0.1'); type(/^Reason/, 'Opening count');
  vi.mocked(axios.post).mockImplementationOnce(async () => {
    const created: InventoryItem = { ...stock, id: 'stock-new', name: 'Synthetic oats', unit: 'lb', category: 'Food',
      location: 'Kitchen / Pantry / Shelf 2', ingredientId: 'ingredient-oats', ingredient: { id: 'ingredient-oats', name: 'Oats', unit: 'lb', archived: false },
      quantity: '0.5', reorderThreshold: '0.1' };
    items.push(created); return response(created);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save inventory item' }));
  await screen.findByRole('button', { name: 'History for Synthetic oats' });
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/inventory'), {
    name: 'Synthetic oats', category: 'Food', location: 'Kitchen / Pantry / Shelf 2', ingredientId: 'ingredient-oats',
    unit: 'lb', reorderThreshold: '0.1', openingQuantity: '0.5', reason: 'Opening count', requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
  });
  expect(within(row('Synthetic oats')).getByText('0.5 lb')).toBeInTheDocument();
});

test('a failed stock save keeps the entries and retries the same request identifier before showing history', async () => {
  renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Adjust ' + stock.name }));
  choose('Change type', 'usage'); type('Quantity (pack)', '2'); type('Reason', 'Art class');
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Lost response')).mockImplementationOnce(async () => {
    items[0] = { ...stock, quantity: '8', version: 2 };
    movements.unshift({ ...opening, id: 'usage-one', type: 'usage', itemVersion: 2, before: stock, after: items[0],
      beforeQuantity: '10', afterQuantity: '8', delta: '-2', reason: 'Art class' });
    return response(items[0]);
  });
  fireEvent.click(saveButton());
  await screen.findByRole('alert');
  await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Quantity (pack)' })).toHaveValue('2');
  expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveValue('Art class');
  fireEvent.click(saveButton());
  await screen.findByText('Stock change recorded.');
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Inventory details' })).not.toBeInTheDocument());
  expect(vi.mocked(axios.post).mock.calls[1]).toEqual(vi.mocked(axios.post).mock.calls[0]);
  expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/inventory/stock-one/movements'), expect.objectContaining({ type: 'usage', quantity: '2', unit: 'pack', version: 1 }));
  fireEvent.click(await screen.findByRole('button', { name: 'History for ' + stock.name }));
  const history = await screen.findByRole('region', { name: 'Inventory history' });
  await within(history).findByText('Art class');
  expect(within(history).getByText('Initial physical count')).toBeInTheDocument();
  expect(within(history).getByText(/10 → 8 pack/)).toBeInTheDocument();
  expect(within(history).getAllByText(/test-admin/)).toHaveLength(2);
});

test('count correction accepts zero, updates stock status and allows a recorded location edit', async () => {
  renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Adjust ' + stock.name }));
  type('Quantity (pack)', '-1'); type('Reason', 'Physical count');
  fireEvent.click(saveButton());
  expect(axios.post).not.toHaveBeenCalled();
  choose('Change type', 'correction'); type(/^Count observed/, '0');
  vi.mocked(axios.post).mockImplementationOnce(async () => { items[0] = { ...stock, quantity: '0', status: 'out', version: 2 }; return response(items[0]); });
  fireEvent.click(saveButton());
  await screen.findByText('Stock change recorded.');
  await screen.findByRole('button', { name: 'Edit ' + stock.name });
  expect(within(row()).getByText('Out of stock')).toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/movements'), expect.objectContaining({ type: 'correction', quantity: '0' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit ' + stock.name }));
  expect(screen.queryByRole('textbox', { name: 'Opening count' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Unit' })).toBeEnabled();
  type('Exact storage location', 'Studio / Shelf 3'); type('Reason', 'Relabeled empty stock bin');
  vi.mocked(axios.put).mockImplementationOnce(async () => { items[0] = { ...items[0], location: 'Studio / Shelf 3', version: 3 }; return response(items[0]); });
  fireEvent.click(screen.getByRole('button', { name: 'Save inventory item' }));
  await screen.findByText('Inventory details updated and recorded in history.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/inventory/stock-one'), expect.objectContaining({ location: 'Studio / Shelf 3', version: 2 }));
  expect(vi.mocked(axios.put).mock.calls[0][1]).not.toHaveProperty('quantity');
});

test('filters preserve typed edits and show facility totals while narrowing to matching locations', async () => {
  items.push({ ...stock, id: 'low', name: 'Glue', category: 'Cleaning', location: 'Closet / Shelf 1', quantity: '1', status: 'low' },
    { ...stock, id: 'out', name: 'Brushes', quantity: '0', status: 'out' });
  renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit ' + stock.name }));
  type('Item name', 'My unsaved label');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Ingredient link (optional)' })).toBeDisabled();
  choose('Filter category', 'Cleaning'); choose('Filter location', 'Closet / Shelf 1'); choose('Stock status', 'low');
  await screen.findByRole('button', { name: 'History for Glue' });
  expect(screen.queryByRole('button', { name: 'History for ' + stock.name })).not.toBeInTheDocument();
  expect(screen.getByText('All items').parentElement).toHaveTextContent('3');
  expect(screen.getByRole('textbox', { name: 'Item name' })).toHaveValue('My unsaved label');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search items' }), { target: { value: 'Missing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('No inventory matches these filters.');
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  await screen.findByRole('button', { name: 'History for ' + stock.name });
  expect(screen.getByRole('textbox', { name: 'Item name' })).toHaveValue('My unsaved label');
});

test('conflicting stock edits retain the draft until explicit reload and use the latest version afterward', async () => {
  renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Adjust ' + stock.name }));
  choose('Change type', 'usage'); type('Quantity (pack)', '5'); type('Reason', 'Class supplies');
  items[0] = { ...stock, quantity: '7', version: 2 };
  vi.mocked(axios.isAxiosError).mockReturnValue(true);
  vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 409, data: { error: {
    code: 'INVENTORY_CONFLICT', message: 'This inventory item changed elsewhere. Reload it and review the latest stock before saving.',
  } } } });
  fireEvent.click(saveButton());
  await screen.findByRole('button', { name: 'Reload inventory item' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reload inventory item' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Quantity (pack)' })).toHaveValue('5');
  expect(saveButton()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reload inventory item' }));
  await screen.findByText('Latest stock loaded. Review the quantities before saving.');
  await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(screen.getByRole('form', { name: 'Inventory details' })).toHaveTextContent('Current stock: 7 pack');
  expect(screen.getByRole('textbox', { name: 'Quantity (pack)' })).toHaveValue('');
  choose('Change type', 'usage'); type('Quantity (pack)', '2'); type('Reason', 'Reviewed usage');
  vi.mocked(axios.post).mockImplementationOnce(async () => { items[0] = { ...items[0], quantity: '5', version: 3 }; return response(items[0]); });
  fireEvent.click(saveButton());
  await screen.findByText('Stock change recorded.');
  expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/movements'), expect.objectContaining({ quantity: '2', version: 2 }));
  const first = vi.mocked(axios.post).mock.calls[0][1] as { requestId: string };
  const last = vi.mocked(axios.post).mock.calls[1][1] as { requestId: string };
  expect(last.requestId).not.toBe(first.requestId);
});

test('failed list and history reads finish loading and can be retried', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let failList = true, failHistory = true;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/inventory') && failList) { failList = false; return Promise.reject(new Error('Unavailable')); }
    if (url.endsWith('/movements') && failHistory) { failHistory = false; return Promise.reject(new Error('Unavailable')); }
    return get(url, config);
  });
  renderInventory();
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh inventory' })).toBeEnabled());
  expect(screen.queryByText('Loading inventory…')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  fireEvent.click(await screen.findByRole('button', { name: 'History for ' + stock.name }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry history' }));
  await screen.findByText('Initial physical count');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a late response cannot replace the currently selected stock status', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let resolveOld!: (value: { data: unknown }) => void;
  let first = true;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/inventory') && first) { first = false; return new Promise((resolve) => { resolveOld = resolve; }); }
    return get(url, config);
  });
  renderInventory();
  await waitFor(() => expect(resolveOld).toBeDefined());
  choose('Stock status', 'out');
  await screen.findByText('No inventory matches these filters.');
  await act(async () => resolveOld({ data: { items: [stock], total: 1, page: 1, pageSize: 25,
    summary: { total: 1, available: 1, lowStock: 0, outOfStock: 0 }, options: { categories: [], locations: [] } } }));
  expect(screen.getByRole('combobox', { name: 'Stock status' })).toHaveValue('out');
  expect(screen.queryByRole('button', { name: 'History for ' + stock.name })).not.toBeInTheDocument();
});

test('pagination retains totals and viewers can read stock history without mutation controls', async () => {
  items = Array.from({ length: 26 }, (_, index) => ({ ...stock, id: 'stock-' + index, name: 'Supply ' + index }));
  render(<SignedIn account={{ ...testAccount, role: 'viewer' }}><Inventory /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
  await screen.findByRole('button', { name: 'History for Supply 25' });
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.getByText('All items').parentElement).toHaveTextContent('26');
  expect(screen.queryByRole('button', { name: 'Add inventory item' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Adjust / })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History for Supply 25' }));
  await screen.findByText('Initial physical count');
});
