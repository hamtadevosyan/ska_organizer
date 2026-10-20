import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type Stock = { id: string; name: string; location: string; unit: string; quantity: string; version: number };
type PurchasingLine = { id: string; itemId: string; buyQuantity: string; selected: boolean; checked: boolean };
type PurchasingList = { weekStart: string; version: number; stockTakenAt: string; lines: PurchasingLine[]; issues: unknown[] };
type Receipt = { id: string; lines: { itemId: string; quantity: string; unit: string; stockDelta: string; totalCost: string | null }[] };
const batches = api + '/inventory/purchase-batches';
const label = (item: Stock) => item.name + ' at ' + item.location;

async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}

async function stock(http: Http, name: string, location: string, quantity: string, extra: Record<string, unknown> = {}) {
  return data<Stock>(await http.post(api + '/inventory', { data: {
    name, category: 'Supplies', location, unit: 'count', openingQuantity: quantity,
    reorderThreshold: '10', reason: 'Synthetic receiving opening count', requestId: randomUUID(), ...extra,
  } }), 201);
}

async function purchasingList(http: Http, weekStart: string, items: Stock[], includeMeals = false) {
  const preview = await data<{ list: PurchasingList; token: string }>(await http.post(`${api}/purchasing/${weekStart}/preview`, { data: {
    includeMeals, roomIds: [], lowStockTargets: items.map(item => ({ itemId: item.id, targetQuantity: item.unit === 'g' ? '100' : '12' })),
  } }));
  expect(preview.list.issues).toEqual([]);
  return data<PurchasingList>(await http.put(`${api}/purchasing/${weekStart}`, { data: {
    version: preview.list.version, token: preview.token,
    choices: preview.list.lines.map(({ id, buyQuantity }) => ({ id, buyQuantity, selected: true, checked: false })),
  } }));
}

async function openPlannedReceipt(page: Page, weekStart: string, items: Stock[]) {
  await page.goto('/receiving?week=' + weekStart);
  await expect(page.getByRole('heading', { name: 'Receive purchases', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add selected purchasing items', exact: true }).click();
  for (const item of items) {
    await expect(page.getByLabel('Received quantity for ' + label(item), { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Total cost for ' + label(item) + ' (USD, optional)', { exact: true })).toHaveValue('');
  }
}

async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const main = page.getByRole('main');
  const size = await main.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content, 'Receiving content must fit the mobile viewport').toBeLessThanOrEqual(size.width + 1);
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  for (const control of await main.locator('button:visible, select:visible, input:not([type="checkbox"]):not([type="radio"]):visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}

const isBatchPost = (url: string, method: string) => method === 'POST' && url.replace(/\/$/, '') === batches;

test('mobile partial receiving reviews actual amounts, updates both stock ledgers and preserves saved plans', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 320, height: 850 });
  page.on('dialog', dialog => { void dialog.accept(); });
  const http = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const weekStart = '2027-03-01';
  const ingredient = await data<{ id: string }>(await http.post(api + '/ingredients', { data: {
    name: 'Receiving meal ingredient ' + suffix, unit: 'count',
  } }), 201);
  const food = await stock(http, 'Receiving meal stock ' + suffix, 'Kitchen shelf', '2', { category: 'Food', ingredientId: ingredient.id });
  const supplies = await stock(http, 'Receiving craft powder ' + suffix, 'Activity cabinet', '0', { unit: 'g' });
  const items = [food, supplies];
  const meal = await data<{ id: string }>(await http.post(api + '/meals', { data: { name: 'Receiving breakfast ' + suffix, type: 'breakfast' } }), 201);
  await data(await http.post(`${api}/meals/${meal.id}/ingredients`, { data: { ingredientId: ingredient.id, quantity: 10 } }), 201);
  const menuPreview = await data<{ previewToken: string }>(await http.post(`${api}/menu/plans/${weekStart}/preview`, { data: {
    version: 0, childrenCount: 1, staffCount: 0, week: [{ day: 'Monday', menu: { breakfast: { id: meal.id } } }],
  } }));
  const mealSnapshot = await data(await http.put(`${api}/menu/plans/${weekStart}`, { data: { previewToken: menuPreview.previewToken } }));
  const savedList = await purchasingList(http, weekStart, items, true);

  await openPlannedReceipt(page, weekStart, items);
  await page.getByLabel('Received quantity for ' + label(food), { exact: true }).fill('3');
  await page.getByLabel('Total cost for ' + label(food) + ' (USD, optional)', { exact: true }).fill('4.50');
  await page.getByLabel('Received quantity for ' + label(supplies), { exact: true }).fill('1');
  await page.getByLabel('Received unit for ' + label(supplies), { exact: true }).selectOption('oz');
  await page.getByLabel('Supplier (optional)', { exact: true }).fill('Synthetic local supplier');
  await page.getByRole('button', { name: 'Review receipt', exact: true }).click();
  const review = page.getByRole('region', { name: 'Receipt review', exact: true });
  await expect(review).toBeVisible();
  await expect(review).toContainText('28.349523');
  await expect(review).toContainText('Not recorded');
  await fits(page);
  // Previewing and canceling a receipt must never create a physical movement.
  await page.getByRole('button', { name: 'Cancel receipt', exact: true }).click();
  for (const item of items) {
    expect(await data<Stock>(await http.get(api + '/inventory/' + item.id))).toMatchObject({ quantity: item.quantity, version: item.version });
    expect((await (await http.get(`${api}/inventory/${item.id}/movements`)).json()).total).toBe(1);
  }

  await page.getByRole('button', { name: 'Add selected purchasing items', exact: true }).click();
  await page.getByLabel('Received quantity for ' + label(food), { exact: true }).fill('3');
  await page.getByLabel('Total cost for ' + label(food) + ' (USD, optional)', { exact: true }).fill('4.50');
  await page.getByLabel('Received quantity for ' + label(supplies), { exact: true }).fill('1');
  await page.getByLabel('Received unit for ' + label(supplies), { exact: true }).selectOption('oz');
  await page.getByLabel('Supplier (optional)', { exact: true }).fill('Synthetic local supplier');
  await page.getByRole('button', { name: 'Review receipt', exact: true }).click();
  await expect(review).toBeVisible();
  const committed = page.waitForResponse(response => isBatchPost(response.url(), response.request().method()));
  await page.getByRole('button', { name: 'Record receipt', exact: true }).click();
  const result = await data<{ batch: Receipt; replayed: boolean }>(await committed, 201);
  expect(result.replayed).toBe(false);
  expect(result.batch.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: food.id, quantity: '3', unit: 'count', stockDelta: '3', totalCost: '4.50' }),
    expect.objectContaining({ itemId: supplies.id, quantity: '1', unit: 'oz', stockDelta: '28.349523', totalCost: null }),
  ]));
  await expect(page.getByRole('status').filter({ hasText: 'Receipt recorded. Inventory updated for 2 items.' })).toBeVisible();
  expect(await data<Stock>(await http.get(api + '/inventory/' + food.id))).toMatchObject({ quantity: '5', version: 2 });
  expect(await data<Stock>(await http.get(api + '/inventory/' + supplies.id))).toMatchObject({ quantity: '28.349523', version: 2 });
  for (const item of items) {
    const history = await (await http.get(`${api}/inventory/purchases?itemId=${item.id}`)).json();
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ batchId: result.batch.id });
    const movements = await (await http.get(`${api}/inventory/${item.id}/movements`)).json();
    expect(movements.total).toBe(2);
    expect(movements.items).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: result.batch.id })]));
  }
  expect(await data(await http.get(`${api}/menu/plans/${weekStart}`))).toEqual(mealSnapshot);
  expect(await data(await http.get(`${api}/purchasing/${weekStart}`))).toEqual(savedList);
  const fulfillment = await data<{ lines: { itemId: string; receivedQuantity: string; remainingQuantity: string }[] }>(await http.get(`${batches}/purchasing/${weekStart}`));
  expect(fulfillment.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: food.id, receivedQuantity: '3', remainingQuantity: '7' }),
    expect.objectContaining({ itemId: supplies.id, receivedQuantity: '28.349523', remainingQuantity: '71.650477' }),
  ]));
  const historyRegion = page.getByRole('region', { name: 'Receiving history', exact: true });
  await expect(historyRegion.getByRole('link', { name: 'View receipt ' + result.batch.id, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View recorded receipt', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recorded receipt', exact: true })).toContainText(food.name);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Recorded receipt', exact: true })).toContainText(supplies.name);
  await fits(page);
  await page.goto('/purchasing?week=' + weekStart);
  await expect(page.getByRole('region', { name: 'Received purchases', exact: true })).toContainText('Remaining 7 count');
  await expect(page.getByRole('region', { name: 'Received purchases', exact: true })).toContainText('Remaining 71.650477 g');
});

test('one stale item prevents the whole receipt; refreshed amounts survive an uncertain response and exact retry', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 850 });
  page.on('dialog', dialog => { void dialog.accept(); });
  const http = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const weekStart = '2027-03-08';
  const first = await stock(http, 'Receiving conflict first ' + suffix, 'Supply shelf A', '1');
  const second = await stock(http, 'Receiving conflict second ' + suffix, 'Supply shelf B', '2');
  await purchasingList(http, weekStart, [first, second]);
  await openPlannedReceipt(page, weekStart, [first, second]);
  await page.getByLabel('Received quantity for ' + label(first), { exact: true }).fill('4');
  await page.getByLabel('Received quantity for ' + label(second), { exact: true }).fill('5');
  const originalReview = page.waitForRequest(request => request.method() === 'POST' && request.url() === batches + '/preview');
  await page.getByRole('button', { name: 'Review receipt', exact: true }).click();
  const originalRequestId = (await originalReview).postDataJSON().requestId;
  await expect(page.getByRole('region', { name: 'Receipt review', exact: true })).toBeVisible();
  await data(await http.post(`${api}/inventory/${second.id}/movements`, { data: {
    type: 'correction', quantity: '3', unit: 'count', version: second.version,
    reason: 'Synthetic intervening physical recount', requestId: randomUUID(),
  } }));
  const rejected = page.waitForResponse(response => isBatchPost(response.url(), response.request().method()));
  await page.getByRole('button', { name: 'Record receipt', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('button', { name: 'Refresh stock versions', exact: true })).toBeVisible();
  expect(await data<Stock>(await http.get(api + '/inventory/' + first.id))).toMatchObject({ quantity: '1', version: 1 });
  expect(await data<Stock>(await http.get(api + '/inventory/' + second.id))).toMatchObject({ quantity: '3', version: 2 });
  expect((await (await http.get(`${api}/inventory/${first.id}/movements`)).json()).total).toBe(1);
  expect((await (await http.get(`${api}/inventory/${second.id}/movements`)).json()).total).toBe(2);
  await page.getByRole('button', { name: 'Refresh stock versions', exact: true }).click();
  await expect(page.getByLabel('Received quantity for ' + label(first), { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Received quantity for ' + label(second), { exact: true })).toHaveValue('5');
  const newReview = page.waitForRequest(request => request.method() === 'POST' && request.url() === batches + '/preview');
  await page.getByRole('button', { name: 'Review receipt', exact: true }).click();
  expect((await newReview).postDataJSON().requestId).not.toBe(originalRequestId);
  await expect(page.getByRole('region', { name: 'Receipt review', exact: true })).toBeVisible();
  const sent: unknown[] = [];
  await page.route('**/api/inventory/purchase-batches', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    sent.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    // The real backend commits, but the browser never receives its response.
    // A retry must reuse the identical body rather than creating another receipt.
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Record receipt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same receipt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to edit', exact: true })).toBeDisabled();
  expect(await data<Stock>(await http.get(api + '/inventory/' + first.id))).toMatchObject({ quantity: '5', version: 2 });
  expect(await data<Stock>(await http.get(api + '/inventory/' + second.id))).toMatchObject({ quantity: '8', version: 3 });
  const retried = page.waitForRequest(request => isBatchPost(request.url(), request.method()));
  const replayed = page.waitForResponse(response => isBatchPost(response.url(), response.request().method()));
  await page.getByRole('button', { name: 'Retry same receipt', exact: true }).click();
  expect((await retried).postDataJSON()).toEqual(sent[0]);
  expect(await data<{ replayed: boolean }>(await replayed, 201)).toMatchObject({ replayed: true });
  await expect(page.getByRole('status').filter({ hasText: 'Receipt recorded. Inventory updated for 2 items.' })).toBeVisible();
  expect((await (await http.get(`${api}/inventory/${first.id}/movements`)).json()).total).toBe(2);
  expect((await (await http.get(`${api}/inventory/${second.id}/movements`)).json()).total).toBe(3);
  for (const item of [first, second]) expect((await (await http.get(`${api}/inventory/purchases?itemId=${item.id}`)).json()).total).toBe(1);
  await fits(page);
});

test('a class viewer cannot read receiving history or receipt detail', async ({ page, browser }) => {
  const http = await authenticatedApi(page);
  const { today } = await (await http.get(api + '/inventory/purchase-config')).json() as { today: string };
  const suffix = randomUUID().slice(0, 8);
  const item = await stock(http, 'Receiving viewer ' + suffix, 'Supply cabinet', '0');
  const batch = (await data<{ batch: Receipt }>(await http.post(batches, { data: {
    requestId: randomUUID(), receivedOn: today, supplier: null,
    reason: 'Synthetic viewer receipt', lines: [{ itemId: item.id, version: item.version, quantity: '2', unit: 'count', totalCost: null }],
  } }), 201)).batch;
  const username = 'receiving-viewer-' + suffix;
  const temporaryPassword = 'Synthetic receiving temporary passphrase 20!';
  const password = 'Synthetic receiving changed passphrase 20!';
  const account = await data<{ id: string; displayName: string }>(await http.post(api + '/admin/accounts', { data: {
    username, displayName: 'Synthetic receiving viewer', role: 'viewer', documentAccess: 'none', password: temporaryPassword,
  } }), 201);
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 320, height: 850 } });
  try {
    const viewer = await context.newPage();
    const login = await viewer.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporaryPassword } });
    expect(login.status()).toBe(200);
    const changed = await viewer.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken },
      data: { currentPassword: temporaryPassword, password } });
    expect(changed.status()).toBe(200);
    const headers = { Origin: origin, 'X-CSRF-Token': (await changed.json()).csrfToken };
    await viewer.goto('/receiving');
    await expect(viewer).toHaveURL(/\/classroom$/);
    await expect(viewer.getByRole('region', { name: 'Receiving history', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('main')).not.toContainText(item.name);
    expect((await viewer.request.get(batches, { headers })).status()).toBe(403);
    expect((await viewer.request.get(batches + '/' + batch.id, { headers })).status()).toBe(403);
    await expect(viewer.getByRole('button', { name: 'Add inventory item', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Review receipt', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Record receipt', exact: true })).toHaveCount(0);
    expect((await viewer.request.post(batches + '/preview', { headers, data: {
      requestId: randomUUID(), receivedOn: today, supplier: null, reason: 'Not permitted',
      lines: [{ itemId: item.id, version: 2, quantity: '1', unit: 'count', totalCost: null }],
    } })).status()).toBe(403);
    await fits(viewer);
  } finally {
    await context.close();
    await data(await http.put(api + '/admin/accounts/' + account.id, { data: { displayName: account.displayName, role: 'viewer', documentAccess: 'none', disabled: true } }));
  }
});
