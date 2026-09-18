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
const row = (name = stock.name) => screen.getByText(name, { selector: 'span' }).closest('tr')!;
const ready = (name = stock.name) => screen.findByText(name, { selector: 'span' });
const expand = (label: string, parent: HTMLElement = document.body) => { const summary = within(parent).getByText(label, { selector: 'summary' }); if (!summary.closest('details')!.open) fireEvent.click(summary); };
const actions = async (name = stock.name) => { await ready(name); expand('More', row(name)); };
const addFood = async () => { await renderInventory(); fireEvent.click(screen.getByRole('button', { name: 'Add item' })); choose('Group', food.id); await waitFor(() => expect(screen.getByLabelText('1. What is it?')).toBeEnabled()); };
const type = (name: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const choose = (name: string | RegExp, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Save amount' });

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


test('typing a familiar food connects the recipe automatically and hides optional settings', async () => {
  await addFood();
  expect(screen.queryByLabelText('Food')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Show a warning when this much is left')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
  expect(axios.post).not.toHaveBeenCalled();
  type('1. What is it?', 'Oats'); type('2. How much do you have?', '0.5');
  expect(screen.getByLabelText('Measured in')).toHaveValue('lb');
  fireEvent.click(screen.getByRole('button', { name: 'Kitchen pantry' }));
  expand('Optional details'); type('Show a warning when this much is left', '0.1');
  vi.mocked(axios.post).mockImplementationOnce(async () => {
    const created = { ...stock, id: 'new-oats', name: 'Oats', groupId: food.id, group: food, unit: 'lb', quantity: '0.5' };
    items.push(created); return response(created);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
  await ready('Oats');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/inventory'), {
    name: 'Oats', groupId: food.id, location: 'Kitchen pantry', ingredientId: 'ingredient-oats', unit: 'lb',
    reorderThreshold: '0.1', openingQuantity: '0.5', reason: 'Initial quantity recorded', requestId: expect.stringMatching(/^[a-f0-9]{32}$/),
  });
  expect(within(row('Oats')).getByText('0.5 pounds (lb)')).toBeInTheDocument();
});

test('a new food is saved with its stock once and a lost response keeps the same answers and request identifier', async () => {
  await addFood(); type('1. What is it?', 'Rice'); type('2. How much do you have?', '2'); choose('Measured in', 'lb');
  fireEvent.click(screen.getByRole('button', { name: 'Kitchen pantry' }));
  const created = { ...stock, id: 'rice', name: 'Rice', groupId: food.id, group: food, unit: 'lb', quantity: '2' };
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Lost response')).mockImplementationOnce(async () => { items.push(created); return response(created); });
  fireEvent.click(screen.getByRole('button', { name: 'Save item' })); await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save item' })).toBeEnabled());
  expect(screen.getByLabelText('1. What is it?')).toHaveValue('Rice');
  expect(screen.getByLabelText('2. How much do you have?')).toHaveValue('2');
  fireEvent.click(screen.getByRole('button', { name: 'Save item' })); await ready('Rice');
  expect(vi.mocked(axios.post).mock.calls[1]).toEqual(vi.mocked(axios.post).mock.calls[0]);
  expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ ingredientId: null, newIngredient: { name: 'Rice', unit: 'lb' }, openingQuantity: '2', reorderThreshold: '0' });
});

test('Used some needs only the amount, previews what remains, and retries without recording twice', async () => {
  await renderInventory(); fireEvent.click(await screen.findByRole('button', { name: 'Used some ' + stock.name }));
  expect(screen.getByLabelText('Notes (optional)')).not.toBeVisible();
  expect(screen.getByLabelText('Change type')).not.toBeVisible();
  type('How much did you use? (packs)', '2');
  expect(screen.getByText(/After saving:/)).toHaveTextContent('8 packs left.');
  expect(axios.post).not.toHaveBeenCalled();
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Lost response')).mockImplementationOnce(async () => {
    items[0] = { ...stock, quantity: '8', version: 2 };
    movements.unshift({ ...opening, id: 'usage', type: 'usage', itemVersion: 2, before: stock, after: items[0], beforeQuantity: '10', afterQuantity: '8', delta: '-2', reason: 'Used in daily activities' });
    return response(items[0]);
  });
  fireEvent.click(saveButton()); await screen.findByRole('alert'); await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(screen.getByLabelText('How much did you use? (packs)')).toHaveValue('2');
  fireEvent.click(saveButton()); await screen.findByText('Amount updated.'); await actions();
  expect(vi.mocked(axios.post).mock.calls[1]).toEqual(vi.mocked(axios.post).mock.calls[0]);
  expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/movements'), expect.objectContaining({ quantity: '2', type: 'usage', reason: 'Used in daily activities', unit: 'pack', version: 1 }));
  fireEvent.click(screen.getByRole('button', { name: 'History for ' + stock.name }));
  const history = await screen.findByRole('region', { name: 'Inventory history' });
  await within(history).findByText('Used in daily activities');
  expect(within(history).getByText('Initial physical count')).toBeInTheDocument();
  expect(within(history).getByText(/10 → 8 pack/)).toBeInTheDocument();
});

test('checking the amount accepts zero and an optional location edit keeps the count intact', async () => {
  await renderInventory(); await actions(); fireEvent.click(screen.getByRole('button', { name: 'Check amount for ' + stock.name }));
  type('How much is there now? (packs)', '-1'); fireEvent.click(saveButton()); expect(axios.post).not.toHaveBeenCalled();
  type('How much is there now? (packs)', '0');
  vi.mocked(axios.post).mockImplementationOnce(async () => { items[0] = { ...stock, quantity: '0', status: 'out', version: 2 }; return response(items[0]); });
  fireEvent.click(saveButton()); await screen.findByText('Amount updated.'); await actions();
  expect(within(row()).getByText('Out of stock')).toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/movements'), expect.objectContaining({ type: 'correction', quantity: '0', reason: 'Physical count checked' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit ' + stock.name }));
  expect(screen.getByLabelText('Unit')).toBeEnabled();
  type('Where is it stored?', 'Studio / Shelf 3'); expand('Add a note (optional)'); type('Notes (optional)', 'Relabeled empty bin');
  vi.mocked(axios.put).mockImplementationOnce(async () => { items[0] = { ...items[0], location: 'Studio / Shelf 3', version: 3 }; return response(items[0]); });
  fireEvent.click(screen.getByRole('button', { name: 'Save details' })); await screen.findByText('Details saved.');
  expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/inventory/stock-one'), expect.objectContaining({ location: 'Studio / Shelf 3', version: 2, reason: 'Relabeled empty bin' }));
  expect(vi.mocked(axios.put).mock.calls[0][1]).not.toHaveProperty('quantity');
});

test('conflicting edits keep the amount until explicit reload and then use the latest version', async () => {
  await renderInventory(); fireEvent.click(await screen.findByRole('button', { name: 'Used some ' + stock.name }));
  type('How much did you use? (packs)', '5'); items[0] = { ...stock, quantity: '7', version: 2 };
  vi.mocked(axios.isAxiosError).mockReturnValue(true);
  vi.mocked(axios.post).mockRejectedValueOnce({ response: { status: 409, data: { error: { code: 'INVENTORY_CONFLICT', message: 'Stock changed elsewhere.' } } } });
  fireEvent.click(saveButton()); await screen.findByText('Stock changed elsewhere.');
  expect(saveButton()).toBeDisabled(); expect(screen.getByLabelText('How much did you use? (packs)')).toHaveValue('5');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reload inventory item' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Reload inventory item' })); await screen.findByText('Latest stock loaded. Review the quantities before saving.');
  await waitFor(() => expect(saveButton()).toBeEnabled());
  expect(screen.getByRole('form', { name: 'Inventory details' })).toHaveTextContent('You have 7 packs');
  type('How much did you use? (packs)', '2');
  vi.mocked(axios.post).mockImplementationOnce(async () => { items[0] = { ...items[0], quantity: '5', version: 3 }; return response(items[0]); });
  fireEvent.click(saveButton()); await screen.findByText('Amount updated.');
  expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/movements'), expect.objectContaining({ quantity: '2', version: 2 }));
  const calls = vi.mocked(axios.post).mock.calls;
  expect((calls[1][1] as { requestId: string }).requestId).not.toBe((calls[0][1] as { requestId: string }).requestId);
});

test('additional filters narrow the list while the simple search stays available', async () => {
  items.push({ ...stock, id: 'glue', name: 'Glue', groupId: cleaning.id, group: cleaning, location: 'Closet', quantity: '1', status: 'low' });
  await renderInventory(); await ready(); expand('More filters');
  choose('Filter group', cleaning.id); choose('Filter location', 'Closet'); choose('Stock status', 'low');
  await ready('Glue'); expect(screen.queryByText(stock.name, { selector: 'span' })).not.toBeInTheDocument();
  type('Search items', 'Missing'); fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('No inventory matches these filters.');
  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' })); await ready('Glue');
  expect(screen.getByLabelText('Filter group')).toHaveValue(cleaning.id);
});

test('first group creation retries safely and adding an item starts in that group', async () => {
  groups = []; items = []; render(<SignedIn><Inventory /></SignedIn>); await screen.findByText('No inventory groups yet.');
  fireEvent.click(screen.getByRole('button', { name: 'Add your first group' }));
  type('Group name', 'Decorations');
  const added = { ...materials, id: 'decorations', name: 'Decorations' };
  vi.mocked(axios.post).mockRejectedValueOnce(new Error('Lost response')).mockImplementationOnce(async () => { groups.push(added); return response(added); });
  fireEvent.click(screen.getByRole('button', { name: 'Save group' })); await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save group' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Save group' })); await screen.findByText('Group created. Add the items you keep here.');
  expect(vi.mocked(axios.post).mock.calls[1]).toEqual(vi.mocked(axios.post).mock.calls[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
  expect(screen.getByLabelText('Group')).toHaveValue(added.id); expect(screen.getByLabelText('Group')).not.toBeVisible();
  expect(axios.get).not.toHaveBeenCalledWith(expect.stringContaining('/ingredients'), expect.anything());
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('pagination and history are available to viewers without mutation controls', async () => {
  items = Array.from({ length: 26 }, (_, index) => ({ ...stock, id: 'stock-' + index, name: 'Supply ' + index }));
  render(<SignedIn account={{ ...testAccount, role: 'viewer' }}><Inventory /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'View all items' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next page' })); await actions('Supply 25');
  expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Bought more|Used some|Check amount|^Edit / })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History for Supply 25' })); await screen.findByText('Initial physical count');
});

test('late list responses cannot replace the selected stock status', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!; let first = true;
  let resolveOld!: (value: { data: unknown }) => void;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/inventory') && first) { first = false; return new Promise((resolve) => { resolveOld = resolve; }); }
    return get(url, config);
  });
  await renderInventory(); await waitFor(() => expect(resolveOld).toBeDefined()); expand('More filters'); choose('Stock status', 'out');
  await screen.findByText('No inventory matches these filters.');
  await act(async () => resolveOld({ data: { items: [stock], total: 1, page: 1, pageSize: 25, summary: materials.summary, options: { categories: [], locations: [] } } }));
  expect(screen.getByLabelText('Stock status')).toHaveValue('out'); expect(screen.queryByText(stock.name, { selector: 'span' })).not.toBeInTheDocument();
});

test('legacy food stock can be repaired under More without clearing its quantity', async () => {
  items = [{ ...stock, name: 'Oats bag', groupId: food.id, group: food, unit: 'lb', quantity: '2', reorderThreshold: '0' }];
  await renderInventory(); await actions('Oats bag'); fireEvent.click(screen.getByRole('button', { name: 'Choose food for Oats bag' }));
  await waitFor(() => expect(screen.getByLabelText('Food')).toBeEnabled()); choose('Food', 'ingredient-oats');
  expect(screen.getByLabelText('Unit')).toBeDisabled();
  vi.mocked(axios.put).mockImplementationOnce(async () => { items[0] = { ...items[0], ingredientId: 'ingredient-oats', ingredient: { id: 'ingredient-oats', name: 'Oats', unit: 'lb', archived: false }, version: 2 }; return response(items[0]); });
  fireEvent.click(screen.getByRole('button', { name: 'Save details' })); await screen.findByText('Details saved.'); await ready('Oats bag');
  expect(within(row('Oats bag')).getByText('2 pounds (lb)')).toBeInTheDocument();
  const payload = vi.mocked(axios.put).mock.calls[0][1];
  expect(payload).toMatchObject({ ingredientId: 'ingredient-oats', unit: 'lb', version: 1, reason: 'Inventory details updated' });
  expect(payload).not.toHaveProperty('quantity');
});

test('failed reads offer retry and history still includes earlier counts', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!; let failList = true, failHistory = true;
  vi.mocked(axios.get).mockImplementation((url, config) => {
    if (url.endsWith('/inventory') && failList) { failList = false; return Promise.reject(new Error('Unavailable')); }
    if (url.endsWith('/movements') && failHistory) { failHistory = false; return Promise.reject(new Error('Unavailable')); }
    return get(url, config);
  });
  await renderInventory(); await screen.findByRole('alert'); expand('More', document.querySelector('header')!);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh inventory' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' })); await actions();
  fireEvent.click(screen.getByRole('button', { name: 'History for ' + stock.name })); fireEvent.click(await screen.findByRole('button', { name: 'Retry history' }));
  await screen.findByText('Initial physical count'); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('ambiguous food names require a choice and cannot silently create another food', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation((url, config) => url.endsWith('/ingredients')
    ? Promise.resolve(response([{ id: 'oats-weight', name: 'Oats', unit: 'lb' }, { id: 'oats-count', name: 'Oats', unit: 'count' }])) : get(url, config));
  await addFood(); type('1. What is it?', 'Oats'); type('2. How much do you have?', '2');
  fireEvent.click(screen.getByRole('button', { name: 'Kitchen pantry' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
  expect(axios.post).not.toHaveBeenCalled(); expect(screen.getByText('Choose the matching food below.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Oats (pounds (lb))' }));
  vi.mocked(axios.post).mockResolvedValueOnce(response(stock)); fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
  await screen.findByText('Item added.'); expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ ingredientId: 'oats-weight', unit: 'lb' });
  expect(vi.mocked(axios.post).mock.calls[0][1]).not.toHaveProperty('newIngredient');
});

test('exact food matching ignores capitalization and repeated spaces', async () => {
  const get = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation((url, config) => url.endsWith('/ingredients')
    ? Promise.resolve(response([{ id: 'brown-rice', name: 'Brown Rice', unit: 'g' }])) : get(url, config));
  await addFood(); type('1. What is it?', 'brown  RICE'); type('2. How much do you have?', '2');
  fireEvent.click(screen.getByRole('button', { name: 'Kitchen pantry' }));
  expect(screen.getByLabelText('Measured in')).toHaveValue('lb');
  vi.mocked(axios.post).mockResolvedValueOnce(response(stock)); fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
  await screen.findByText('Item added.'); expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({ ingredientId: 'brown-rice', unit: 'lb' });
});
