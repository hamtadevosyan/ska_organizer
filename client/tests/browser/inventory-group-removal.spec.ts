import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type Group = { id: string; name: string; kind: 'food' | 'supplies'; version: number; archived: boolean; deletedAt: string | null };
type Stock = { id: string; name: string; groupId: string; category: string; location: string; unit: string;
  ingredientId: string | null; quantity: string; version: number; archived: boolean };
type Context = { source: Group; contextVersion: string; members: Stock[]; destinations: Group[] };
type Review = { reviewToken: string; itemCount: number; nonzeroCount: number; members: Stock[] };
type Operation = { id: string; action: string; sourceBefore: Group; sourceAfter: Group; target: Group | null;
  itemCount: number; nonzeroCount: number; members: { before: Stock; after: Stock; movementId: string | null }[]; replayed?: boolean };
type PurchasingList = { weekStart: string; version: number; lines: { id: string; buyQuantity: string; selected: boolean; checked: boolean }[]; issues: unknown[] };
const inventory = api + '/inventory';
const suffix = () => randomUUID().slice(0, 8);
const removalPath = (group: Group) => inventory + '/groups/' + group.id + '/removal';
const reasonText = 'Synthetic group reorganization; all recorded balances and earlier history must stay intact.';
const archiveAcknowledgment = 'I understand these records will be archived and their recorded quantities will stay unchanged';

async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
async function group(http: Http, name: string, kind: Group['kind'] = 'supplies') {
  return data<Group>(await http.post(inventory + '/groups', { data: { name, kind, requestId: randomUUID() } }), 201);
}
async function stock(http: Http, parent: Group, name: string, quantity: string, extra: Record<string, unknown> = {}) {
  return data<Stock>(await http.post(inventory, { data: { name, groupId: parent.id, location: 'Synthetic shelf / ' + suffix(),
    unit: 'count', ingredientId: null, openingQuantity: quantity, reorderThreshold: '0',
    reason: 'Synthetic opening count', requestId: randomUUID(), ...extra } }), 201);
}
async function groups(http: Http, archived = false) {
  const response = await http.get(inventory + '/groups' + (archived ? '?archived=true' : ''));
  expect(response.status()).toBe(200);
  return (await response.json()).items as Group[];
}
async function history(http: Http, item: Stock) {
  const response = await http.get(`${inventory}/${item.id}/movements`);
  expect(response.status()).toBe(200);
  return await response.json() as { total: number; items: { id: string; delta: string; groupOperationId?: string; after: { archived?: boolean } }[] };
}
async function receive(http: Http, item: Stock) {
  const configuration = await (await http.get(inventory + '/purchase-config')).json() as { today: string };
  return data<{ item: Stock; receipt: unknown }>(await http.post(`${inventory}/${item.id}/purchases`, { data: {
    requestId: randomUUID(), quantity: '1', unit: item.unit, version: item.version, receivedOn: configuration.today,
    supplier: 'Synthetic supplier', totalCost: null, reason: 'Synthetic receipt retained through group removal',
  } }), 201);
}
async function openRemoval(page: Page, selected: Group) {
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Remove group ' + selected.name, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Remove inventory group', exact: true })).toBeVisible();
}
async function chooseMove(page: Page, target: Group) {
  const panel = page.getByRole('region', { name: 'Remove inventory group', exact: true });
  await panel.getByRole('radio', { name: 'Move all items and delete group', exact: true }).check();
  await panel.getByLabel('Move items to group', { exact: true }).selectOption(target.id);
  await panel.getByRole('textbox', { name: 'Reason', exact: true }).fill(reasonText);
}
async function reviewRemoval(page: Page) {
  await page.getByRole('button', { name: 'Review group removal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review group removal', exact: true })).toBeVisible();
}
async function commit(page: Page, selected: Group, actionLabel: string) {
  const completed = page.waitForResponse(response => response.url() === removalPath(selected) && response.request().method() === 'POST');
  await page.getByRole('region', { name: 'Review group removal', exact: true }).getByRole('button', { name: actionLabel, exact: true }).click();
  return data<Operation>(await completed, 201);
}
async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const main = page.getByRole('main');
  const dimensions = await main.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(dimensions.content, 'Group removal content must fit the mobile viewport').toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  for (const control of await main.locator('button:visible, select:visible, textarea:visible, input:not([type="checkbox"]):not([type="radio"]):visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
}

test('320px empty deletion and compatible move remove only the group while preserving physical stock and receipts', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 320, height: 850 });
  page.on('dialog', dialog => { void dialog.accept(); });
  const http = await authenticatedApi(page);
  const id = suffix();
  const empty = await group(http, 'Removal empty ' + id);
  await openRemoval(page, empty);
  await page.getByRole('radio', { name: 'Delete empty group', exact: true }).check();
  await reviewRemoval(page);
  await page.getByRole('button', { name: 'Cancel group removal', exact: true }).click();
  expect((await groups(http)).some(value => value.id === empty.id)).toBe(true);
  await openRemoval(page, empty);
  await page.getByRole('radio', { name: 'Delete empty group', exact: true }).check();
  await reviewRemoval(page);
  const deleted = await commit(page, empty, 'Delete empty group');
  expect(deleted).toMatchObject({ action: 'delete', itemCount: 0, members: [] });
  expect(deleted.sourceAfter.deletedAt).toBeTruthy();
  expect((await groups(http)).some(value => value.id === empty.id)).toBe(false);

  const source = await group(http, 'Removal pantry ' + id, 'food');
  const target = await group(http, 'Removal new pantry ' + id, 'food');
  const incompatible = await group(http, 'Removal craft cupboard ' + id, 'supplies');
  const ingredient = await data<{ id: string }>(await http.post(api + '/ingredients', { data: { name: 'Removal food ' + id, unit: 'count' } }), 201);
  const first = (await receive(http, await stock(http, source, 'Removal food stock ' + id, '4', { ingredientId: ingredient.id }))).item;
  const second = await stock(http, source, 'Removal oil stock ' + id, '2.25', { unit: 'ml' });
  const items = [first, second];
  const beforeHistories = await Promise.all(items.map(item => history(http, item)));
  const beforeReceipts = await (await http.get(inventory + '/purchases?itemId=' + first.id)).json();
  await openRemoval(page, source);
  await chooseMove(page, target);
  await expect(page.getByLabel('Move items to group', { exact: true }).locator(`option[value="${incompatible.id}"]`)).toHaveCount(0);
  const context = await data<Context>(await http.get(removalPath(source) + '-context'));
  const invalid = await http.post(removalPath(source) + '-preview', { data: {
    action: 'move', contextVersion: context.contextVersion, targetGroupId: incompatible.id, targetVersion: incompatible.version, reason: reasonText,
  } });
  expect([409, 422]).toContain(invalid.status());
  await reviewRemoval(page);
  for (const item of items) await expect(page.getByRole('region', { name: 'Review group removal', exact: true })).toContainText(item.name);
  await fits(page);
  await page.getByRole('button', { name: 'Cancel group removal', exact: true }).click();
  for (const [index, item] of items.entries()) {
    expect(await data<Stock>(await http.get(inventory + '/' + item.id))).toEqual(item);
    expect(await history(http, item)).toEqual(beforeHistories[index]);
  }
  await openRemoval(page, source);
  await chooseMove(page, target);
  await reviewRemoval(page);
  const moved = await commit(page, source, 'Move all items and delete group');
  expect(moved).toMatchObject({ action: 'move', itemCount: 2, target: { id: target.id } });
  expect(moved.sourceAfter.deletedAt).toBeTruthy();
  expect((await groups(http)).some(value => value.id === source.id)).toBe(false);
  expect((await groups(http, true)).some(value => value.id === source.id)).toBe(false);
  for (const [index, item] of items.entries()) {
    const current = await data<Stock>(await http.get(inventory + '/' + item.id));
    expect(current).toMatchObject({ id: item.id, name: item.name, groupId: target.id, category: target.name, location: item.location,
      quantity: item.quantity, unit: item.unit, ingredientId: item.ingredientId, version: item.version + 1, archived: false });
    const after = await history(http, item);
    expect(after.total).toBe(beforeHistories[index].total + 1);
    expect(after.items.slice(1)).toEqual(beforeHistories[index].items);
    expect(after.items[0]).toMatchObject({ delta: '0', groupOperationId: moved.id });
  }
  expect(await (await http.get(inventory + '/purchases?itemId=' + first.id)).json()).toEqual(beforeReceipts);
  await page.reload();
  await page.getByRole('button', { name: 'Open group ' + target.name, exact: true }).click();
  for (const item of items) await expect(page.getByText(item.name, { exact: true })).toBeVisible();
  await fits(page);
});

test('desktop stale membership requires a fresh review and an uncertain move retries the identical operation once', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 850 });
  page.on('dialog', dialog => { void dialog.accept(); });
  const http = await authenticatedApi(page);
  const id = suffix(), source = await group(http, 'Removal concurrent source ' + id), target = await group(http, 'Removal concurrent target ' + id);
  const original = [await stock(http, source, 'Removal first ' + id, '3'), await stock(http, source, 'Removal second ' + id, '0')];
  await openRemoval(page, source);
  await chooseMove(page, target);
  await reviewRemoval(page);
  const added = await stock(http, source, 'Removal new member ' + id, '1.5');
  const rejected = page.waitForResponse(response => response.url() === removalPath(source) && response.request().method() === 'POST');
  await page.getByRole('region', { name: 'Review group removal', exact: true }).getByRole('button', { name: 'Move all items and delete group', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('button', { name: 'Refresh removal review', exact: true })).toBeVisible();
  for (const item of [...original, added]) {
    expect(await data<Stock>(await http.get(inventory + '/' + item.id))).toEqual(item);
    expect((await history(http, item)).total).toBe(1);
  }
  expect((await groups(http)).some(value => value.id === source.id)).toBe(true);
  await page.getByRole('button', { name: 'Refresh removal review', exact: true }).click();
  await expect(page.getByLabel('Move items to group', { exact: true })).toHaveValue(target.id);
  await expect(page.getByRole('textbox', { name: 'Reason', exact: true })).toHaveValue(reasonText);
  await reviewRemoval(page);
  await expect(page.getByRole('region', { name: 'Review group removal', exact: true })).toContainText(added.name);
  let originalBody: unknown;
  await page.route('**/api/inventory/groups/' + source.id + '/removal', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    originalBody = route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(201);
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('region', { name: 'Review group removal', exact: true }).getByRole('button', { name: 'Move all items and delete group', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same group removal', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel group removal', exact: true })).toBeDisabled();
  const repeated = page.waitForRequest(request => request.url() === removalPath(source) && request.method() === 'POST');
  const replayed = page.waitForResponse(response => response.url() === removalPath(source) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry same group removal', exact: true }).click();
  expect((await repeated).postDataJSON()).toEqual(originalBody);
  const operation = await data<Operation>(await replayed, 201);
  expect(operation.replayed).toBe(true);
  expect(operation.itemCount).toBe(3);
  for (const item of [...original, added]) {
    expect(await data<Stock>(await http.get(inventory + '/' + item.id))).toMatchObject({ groupId: target.id,
      quantity: item.quantity, version: item.version + 1 });
    const changes = await history(http, item);
    expect(changes.total).toBe(2);
    expect(changes.items[0]).toMatchObject({ groupOperationId: operation.id, delta: '0' });
  }
  expect((await groups(http)).some(value => value.id === source.id)).toBe(false);
});

test('320px nonzero archive retains balances and saved history while removing stock from active choices and food availability', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 320, height: 850 });
  page.on('dialog', dialog => { void dialog.accept(); });
  const http = await authenticatedApi(page), id = suffix(), weekStart = '2027-04-05';
  const source = await group(http, 'Removal archived pantry ' + id, 'food');
  const ingredient = await data<{ id: string }>(await http.post(api + '/ingredients', { data: { name: 'Removal retained food ' + id, unit: 'count' } }), 201);
  const first = (await receive(http, await stock(http, source, 'Removal retained stock ' + id, '4', { ingredientId: ingredient.id }))).item;
  const zero = await stock(http, source, 'Removal zero balance ' + id, '0', { unit: 'g' });
  const items = [first, zero], beforeHistory = await Promise.all(items.map(item => history(http, item)));
  const receipts = await (await http.get(inventory + '/purchases?itemId=' + first.id)).json();
  const meal = await data<{ id: string }>(await http.post(api + '/meals', { data: { name: 'Removal retained breakfast ' + id, type: 'breakfast' } }), 201);
  await data(await http.post(`${api}/meals/${meal.id}/ingredients`, { data: { ingredientId: ingredient.id, quantity: 2 } }), 201);
  const mealInput = { version: 0, childrenCount: 4, staffCount: 0, week: [{ day: 'Monday', menu: { breakfast: { id: meal.id } } }] };
  const mealPreview = await data<{ previewToken: string }>(await http.post(`${api}/menu/plans/${weekStart}/preview`, { data: mealInput }));
  const savedMeal = await data<{ version: number }>(await http.put(`${api}/menu/plans/${weekStart}`, { data: { previewToken: mealPreview.previewToken } }));
  const buyingPreview = await data<{ list: PurchasingList; token: string }>(await http.post(`${api}/purchasing/${weekStart}/preview`, { data: {
    includeMeals: true, roomIds: [], lowStockTargets: [],
  } }));
  expect(buyingPreview.list.issues).toEqual([]);
  const savedPurchasing = await data(await http.put(`${api}/purchasing/${weekStart}`, { data: {
    version: buyingPreview.list.version, token: buyingPreview.token, choices: buyingPreview.list.lines.map(({ id: lineId, buyQuantity, selected, checked }) => ({ id: lineId, buyQuantity, selected, checked })),
  } }));
  const activeBefore = await (await http.get(inventory + '/status')).json() as { total: number };
  await openRemoval(page, source);
  await page.getByRole('radio', { name: 'Archive group and all items', exact: true }).check();
  await page.getByRole('button', { name: 'Review group removal', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Reason', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill(reasonText);
  await reviewRemoval(page);
  await expect(page.getByRole('checkbox', { name: archiveAcknowledgment, exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Cancel group removal', exact: true }).click();
  for (const item of items) expect(await data<Stock>(await http.get(inventory + '/' + item.id))).toEqual(item);
  expect(await data(await http.get(`${api}/menu/plans/${weekStart}`))).toEqual(savedMeal);
  await openRemoval(page, source);
  await page.getByRole('radio', { name: 'Archive group and all items', exact: true }).check();
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill(reasonText);
  await reviewRemoval(page);
  await page.getByRole('checkbox', { name: archiveAcknowledgment, exact: true }).check();
  await fits(page);
  const archived = await commit(page, source, 'Archive group and all items');
  expect(archived).toMatchObject({ action: 'archive', itemCount: 2, nonzeroCount: 1, sourceAfter: { archived: true } });
  expect((await groups(http)).some(value => value.id === source.id)).toBe(false);
  expect((await groups(http, true)).some(value => value.id === source.id)).toBe(true);
  expect((await (await http.get(inventory + '/status')).json()).total).toBe(activeBefore.total - 2);
  for (const [index, item] of items.entries()) {
    expect(await data<Stock>(await http.get(inventory + '/' + item.id))).toMatchObject({ id: item.id, groupId: source.id,
      quantity: item.quantity, unit: item.unit, location: item.location, ingredientId: item.ingredientId, version: item.version + 1, archived: true });
    const changes = await history(http, item);
    expect(changes.total).toBe(beforeHistory[index].total + 1);
    expect(changes.items.slice(1)).toEqual(beforeHistory[index].items);
    expect(changes.items[0]).toMatchObject({ groupOperationId: archived.id, delta: '0', after: { archived: true } });
  }
  expect(await (await http.get(inventory + '/purchases?itemId=' + first.id)).json()).toEqual(receipts);
  expect(await data(await http.get(`${api}/menu/plans/${weekStart}`))).toEqual(savedMeal);
  expect(await data(await http.get(`${api}/purchasing/${weekStart}`))).toEqual(savedPurchasing);
  const currentPreview = await data<{ items: { ingredient: { id: string }; inStorage: string | number; toBuy: string | number }[] }>(await http.post(`${api}/menu/plans/${weekStart}/preview`, { data: { ...mealInput, version: savedMeal.version } }));
  const currentFood = currentPreview.items.find(line => line.ingredient.id === ingredient.id)!;
  expect(Number(currentFood.inStorage)).toBe(0);
  expect(Number(currentFood.toBuy)).toBe(8);

  await page.getByRole('button', { name: 'Archived inventory', exact: true }).click();
  await page.getByRole('button', { name: 'Open group ' + source.name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove group ' + source.name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add item', exact: true })).toHaveCount(0);
  for (const item of items) {
    await expect(page.getByRole('button', { name: 'Bought more ' + item.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Used some ' + item.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit ' + item.name, exact: true })).toHaveCount(0);
  }
  const row = page.getByRole('row').filter({ has: page.getByText(first.name, { exact: true }) });
  const more = row.locator('details');
  if (!(await more.evaluate(element => (element as HTMLDetailsElement).open))) await more.locator('summary').click();
  await page.getByRole('button', { name: 'History for ' + first.name, exact: true }).click();
  const historyRegion = page.getByRole('region', { name: 'Inventory history', exact: true });
  await expect(historyRegion).toContainText(reasonText);
  await expect(historyRegion.locator(`a[href="/inventory/group-operations/${archived.id}"]`)).toBeVisible();
  await fits(page);
  await page.goto('/inventory/group-operations/' + archived.id);
  await expect(page.getByRole('main')).toContainText(source.name);
  await expect(page.getByRole('main')).toContainText(first.quantity + ' ' + first.unit);
  await page.goto('/receiving');
  const destination = page.getByLabel('Inventory item and location', { exact: true });
  await expect(destination).toBeEnabled();
  for (const item of items) await expect(destination.locator(`option[value="${item.id}"]`)).toHaveCount(0);
});

test('class viewers cannot inspect retained group operations or archived history', async ({ page, browser }) => {
  const http = await authenticatedApi(page), id = suffix();
  const archivedGroup = await group(http, 'Removal viewer archive ' + id);
  const item = await stock(http, archivedGroup, 'Removal viewer retained item ' + id, '2');
  const context = await data<Context>(await http.get(removalPath(archivedGroup) + '-context'));
  const review = await data<Review>(await http.post(removalPath(archivedGroup) + '-preview', { data: {
    action: 'archive', contextVersion: context.contextVersion, reason: reasonText,
  } }));
  const operation = await data<Operation>(await http.post(removalPath(archivedGroup), { data: {
    requestId: randomUUID(), reviewToken: review.reviewToken, acknowledgeRetainedStock: true,
  } }), 201);
  const active = await group(http, 'Removal viewer protected active ' + id);
  const activeContext = await data<Context>(await http.get(removalPath(active) + '-context'));
  const activeReview = await data<Review>(await http.post(removalPath(active) + '-preview', { data: {
    action: 'delete', contextVersion: activeContext.contextVersion,
  } }));
  const username = 'removal-viewer-' + id, temporaryPassword = 'Synthetic removal temporary passphrase 20!', password = 'Synthetic removal changed passphrase 20!';
  const account = await data<{ id: string; displayName: string }>(await http.post(api + '/admin/accounts', { data: {
    username, displayName: 'Synthetic group removal viewer', role: 'viewer', documentAccess: 'none', password: temporaryPassword,
  } }), 201);
  const browserContext = await browser.newContext({ baseURL: origin, viewport: { width: 320, height: 850 } });
  try {
    const viewer = await browserContext.newPage();
    const login = await viewer.request.post(api + '/auth/login', { headers: { Origin: origin }, data: { username, password: temporaryPassword } });
    expect(login.status()).toBe(200);
    const changed = await viewer.request.post(api + '/auth/password', { headers: { Origin: origin, 'X-CSRF-Token': (await login.json()).csrfToken },
      data: { currentPassword: temporaryPassword, password } });
    expect(changed.status()).toBe(200);
    const headers = { Origin: origin, 'X-CSRF-Token': (await changed.json()).csrfToken };
    await viewer.goto('/inventory');
    await expect(viewer.getByRole('button', { name: /^Remove group / })).toHaveCount(0);
    await expect(viewer).toHaveURL(/\/classroom$/);
    await expect(viewer.getByRole('button', { name: 'Archived inventory', exact: true })).toHaveCount(0);
    await expect(viewer.getByText(item.name, { exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Add item', exact: true })).toHaveCount(0);
    await viewer.goto('/inventory/group-operations/' + operation.id);
    await expect(viewer).toHaveURL(/\/classroom$/);
    await expect(viewer.getByRole('main')).not.toContainText(archivedGroup.name);
    expect((await viewer.request.get(inventory + '/group-operations/' + operation.id, { headers })).status()).toBe(403);
    expect((await viewer.request.get(inventory + '/items?archived=true', { headers })).status()).toBe(403);
    expect((await viewer.request.post(removalPath(active) + '-preview', { headers, data: {
      action: 'delete', contextVersion: activeContext.contextVersion,
    } })).status()).toBe(403);
    expect((await viewer.request.post(removalPath(active), { headers, data: {
      requestId: randomUUID(), reviewToken: activeReview.reviewToken, acknowledgeRetainedStock: false,
    } })).status()).toBe(403);
    expect((await groups(http)).some(value => value.id === active.id)).toBe(true);
    await fits(viewer);
  } finally {
    await browserContext.close();
    await data(await http.put(api + '/admin/accounts/' + account.id, { data: { displayName: account.displayName,
      role: 'viewer', documentAccess: 'none', disabled: true } }));
  }
});
