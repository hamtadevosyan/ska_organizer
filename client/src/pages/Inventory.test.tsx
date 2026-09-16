import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Inventory from './Inventory';
import type { InventoryGroup, InventoryItem, InventoryList, StockMovement } from '../api/inventory';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';

vi.mock('axios');
const materials: InventoryGroup = { id: 'group-materials', name: 'Art supplies', kind: 'supplies', description: '',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', summary: { total: 0, available: 0, lowStock: 0, outOfStock: 0 } };
const food: InventoryGroup = { ...materials, id: 'group-food', name: 'Food', kind: 'food' };
const cleaning: InventoryGroup = { ...materials, id: 'group-cleaning', name: 'Cleaning' };
const stock: InventoryItem = { id: 'stock-one', name: 'Synthetic paper', category: 'Art supplies', location: 'Studio / Shelf 2',
  groupId: materials.id, group: materials,
  unit: 'pack', ingredientId: null, ingredient: null, quantity: '10', reorderThreshold: '2', status: 'available', version: 1,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
const opening: StockMovement = { id: 'movement-one', itemId: stock.id, itemVersion: 1, type: 'opening',
  beforeQuantity: '0', afterQuantity: '10', delta: '10', before: null, after: stock,
  reason: 'Initial physical count', actorId: 'admin', actorUsername: 'test-admin', occurredAt: '2026-09-01T00:00:00.000Z' };
let items: InventoryItem[];
let groups: InventoryGroup[];
let movements: StockMovement[];
const response = (data: unknown) => ({ data: { data } });
const renderInventory = async () => {
  const view = render(<SignedIn><Inventory /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'View all items' }));
  return view;
};
const row = (name = stock.name) => screen.getByRole('button', { name: 'History for ' + name }).closest('tr')!;
const type = (name: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const choose = (name: string | RegExp, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Record stock change' });

beforeEach(() => {
  vi.resetAllMocks(); items = [structuredClone(stock)]; movements = [structuredClone(opening)];
  groups = [structuredClone(materials), structuredClone(food), structuredClone(cleaning)];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (url.endsWith('/inventory/groups')) return { data: { items: groups.map((group) => {
      const members = items.filter((item) => item.groupId === group.id);
      return { ...group, summary: { total: members.length, available: members.filter((item) => item.status === 'available').length,
        lowStock: members.filter((item) => item.status === 'low').length, outOfStock: members.filter((item) => item.status === 'out').length } };
    }) } };
    if (url.endsWith('/ingredients')) return response([{ id: 'ingredient-oats', name: 'Oats', unit: 'lb', archived: false }]);
    if (url.endsWith('/inventory')) {
      const params = config?.params as { q?: string; groupId?: string; location?: string; status: string; page: number; pageSize: number };
      const matches = items.filter((item) => (!params.q || item.name.toLowerCase().includes(params.q.toLowerCase())) &&
        (!params.groupId || item.groupId === params.groupId) && (!params.location || item.location === params.location) &&
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
  await renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Add inventory item' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save inventory item' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Correct the highlighted inventory details.');
  type(/^Item name/, '  Synthetic oats  '); choose(/^Inventory group/, food.id); type(/^Exact storage location/, 'Kitchen / Pantry / Shelf 2');
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Ingredient link (optional)' })).toBeEnabled());
  choose('Ingredient link (optional)', 'ingredient-oats');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('lb');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toBeDisabled();
  type('Opening count', '0.5'); type('Reorder threshold', '0.1'); type(/^Reason/, 'Opening count');
  vi.mocked(axios.post).mockImplementationOnce(async () => {
    const created: InventoryItem = { ...stock, id: 'stock-new', name: 'Synthetic oats', unit: 'lb', category: 'Food',
      groupId: food.id, group: food,
      location: 'Kitchen / Pantry / Shelf 2', ingredientId: 'ingredient-oats', ingredient: { id: 'ingredient-oats', name: 'Oats', unit: 'lb', archived: false },
      quantity: '0.5', reorderThreshold: '0.1' };
    items.push(created); return response(created);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save inventory item' }));
  await screen.findByRole('button', { name: 'History for Synthetic oats' });
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/inventory'), {
    name: 'Synthetic oats', groupId: food.id, location: 'Kitchen / Pantry / Shelf 2', ingredientId: 'ingredient-oats',
    unit: 'lb', reorderThreshold: '0.1', openingQuantity: '0.5', reason: 'Opening count', requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
  });
  expect(within(row('Synthetic oats')).getByText('0.5 lb')).toBeInTheDocument();
});

test('a failed stock save keeps the entries and retries the same request identifier before showing history', async () => {
  await renderInventory();
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
  await renderInventory();
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

test('filters preserve typed edits and show group totals while narrowing to matching locations', async () => {
  items.push({ ...stock, id: 'low', name: 'Glue', category: 'Cleaning', groupId: cleaning.id, group: cleaning, location: 'Closet / Shelf 1', quantity: '1', status: 'low' },
    { ...stock, id: 'out', name: 'Brushes', quantity: '0', status: 'out' });
  await renderInventory();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit ' + stock.name }));
  type('Item name', 'My unsaved label');
  expect(screen.getByRole('combobox', { name: 'Unit' })).toBeDisabled();
  expect(screen.queryByRole('combobox', { name: 'Ingredient link (optional)' })).not.toBeInTheDocument();
  choose('Filter group', cleaning.id); choose('Filter location', 'Closet / Shelf 1'); choose('Stock status', 'low');
  await screen.findByRole('button', { name: 'History for Glue' });
  expect(screen.queryByRole('button', { name: 'History for ' + stock.name })).not.toBeInTheDocument();
  expect(screen.getByText('Items in group').parentElement).toHaveTextContent('1');
  expect(screen.getByRole('textbox', { name: 'Item name' })).toHaveValue('My unsaved label');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search items' }), { target: { value: 'Missing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('No inventory matches these filters.');
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByRole('combobox', { name: 'Filter group' })).toHaveValue(cleaning.id);
  choose('Filter group', '');
  await screen.findByRole('button', { name: 'History for ' + stock.name });
  expect(screen.getByRole('textbox', { name: 'Item name' })).toHaveValue('My unsaved label');
});

test('conflicting stock edits retain the draft until explicit reload and use the latest version afterward', async () => {
  await renderInventory();
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
  await renderInventory();
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
  await renderInventory();
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
  expect(screen.queryByRole('button', { name: 'Add group' })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'View all items' }));
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

test('inventory opens with groups and supply item entry has no food ingredient controls', async () => {
  render(<SignedIn><Inventory /></SignedIn>);
  const card = await screen.findByRole('button', { name: 'Open group ' + materials.name });
  expect(card).toHaveTextContent('1 item');
  expect(screen.getByRole('button', { name: 'Open group Food' })).toHaveTextContent('0 items');
  expect(screen.queryByRole('table', { name: 'Inventory items' })).not.toBeInTheDocument();
  expect(axios.get).not.toHaveBeenCalledWith(expect.stringContaining('/ingredients'), expect.anything());
  fireEvent.click(card);
  await screen.findByRole('button', { name: 'History for ' + stock.name });
  fireEvent.click(screen.getByRole('button', { name: 'Add inventory item' }));
  expect(screen.getByRole('combobox', { name: 'Inventory group' })).toHaveValue(materials.id);
  expect(screen.queryByRole('combobox', { name: 'Ingredient link (optional)' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'All groups' })).toBeDisabled();
  expect(axios.get).not.toHaveBeenCalledWith(expect.stringContaining('/ingredients'), expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'All groups' }));
  expect(screen.getByRole('button', { name: 'Open group ' + materials.name })).toBeInTheDocument();
});

test('users can create their first empty group, retry a failed save, then add an item to it', async () => {
  groups = []; items = [];
  render(<SignedIn><Inventory /></SignedIn>);
  await screen.findByText('No inventory groups yet.');
  expect(screen.getByRole('button', { name: 'Add inventory item' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
  expect(axios.post).not.toHaveBeenCalled();
  type('Group name', 'Decorations'); type('Description (optional)', 'Seasonal decorations in storage');
  const added: InventoryGroup = { ...materials, id: 'group-new', name: 'Decorations', description: 'Seasonal decorations in storage' };
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Lost response')).mockImplementationOnce(async () => { groups.push(added); return response(added); });
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
  await screen.findByText('Could not save the group. Your entries are still here; retry the same save.');
  expect(screen.getByRole('textbox', { name: 'Group name' })).toHaveValue('Decorations');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save group' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
  await screen.findByText('Group created. Add the items you keep here.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add inventory item' })).toBeEnabled());
  expect(vi.mocked(axios.post).mock.calls[1]).toEqual(vi.mocked(axios.post).mock.calls[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Add inventory item' }));
  expect(screen.getByRole('combobox', { name: 'Inventory group' })).toHaveValue(added.id);
  expect(screen.queryByRole('combobox', { name: 'Ingredient link (optional)' })).not.toBeInTheDocument();
});

test('moving an item to another group shows that group and keeps the stock amount', async () => {
  render(<SignedIn><Inventory /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open group ' + materials.name }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit ' + stock.name }));
  choose('Inventory group', cleaning.id); type('Reason', 'Reclassified supplies');
  vi.mocked(axios.put).mockImplementationOnce(async () => {
    items[0] = { ...stock, groupId: cleaning.id, group: cleaning, category: cleaning.name, version: 2 }; return response(items[0]);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save inventory item' }));
  await screen.findByText('Inventory details updated and recorded in history.');
  await screen.findByRole('heading', { name: 'Cleaning', level: 2 });
  await screen.findByRole('button', { name: 'History for ' + stock.name });
  expect(within(row()).getByText('10 pack')).toBeInTheDocument();
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/inventory/stock-one'), expect.objectContaining({ groupId: cleaning.id, version: 1 }));
  expect(vi.mocked(axios.put).mock.calls[0][1]).not.toHaveProperty('quantity');
});

test('a failed group load offers retry instead of showing an empty inventory', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let failed = false;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/inventory/groups') && !failed) { failed = true; return Promise.reject(new Error('Unavailable')); }
    return get(url, config);
  });
  render(<SignedIn><Inventory /></SignedIn>);
  await screen.findByRole('alert');
  expect(screen.queryByText('No inventory groups yet.')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh inventory' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  await screen.findByRole('button', { name: 'Open group ' + materials.name });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
