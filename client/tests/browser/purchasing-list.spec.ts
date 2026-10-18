import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { api, authenticatedApi, origin } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type Stock = { id: string; name: string; location: string; unit: string; quantity: string; version: number };
type Room = { id: string; name: string };
type Line = {
  id: string; itemId: string | null; name: string; location: string | null; unit: string;
  needed: string; inStorage: string; toBuy: string; buyQuantity: string; selected: boolean; checked: boolean;
  sources: { kind: string; quantity: string; roomId?: string }[];
};
type List = { weekStart: string; version: number; stockTakenAt: string; lines: Line[]; issues: unknown[]; roomIds: string[] };
type Preview = { list: List; token: string };
const weeks = { combined: '2027-02-01', conflict: '2027-02-08', viewer: '2027-02-15' };

async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
const choices = (list: List) => list.lines.map(({ id, buyQuantity, selected, checked }) => ({ id, buyQuantity, selected, checked }));
const label = (stock: Stock) => stock.name + ' at ' + stock.location;
async function stock(http: Http, name: string, location: string, quantity: string, extra: Record<string, unknown> = {}) {
  return data<Stock>(await http.post(api + '/inventory', { data: {
    name, category: 'Supplies', location, unit: 'count', openingQuantity: quantity,
    reorderThreshold: '0', reason: 'Synthetic purchasing opening count', requestId: randomUUID(), ...extra,
  } }), 201);
}
async function room(http: Http, name: string) {
  return data<Room>(await http.post(api + '/rooms', { data: { name, ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 } }), 201);
}
async function openWeek(page: Page, week: string) {
  await page.goto('/purchasing');
  await page.getByLabel('Purchasing week starting Monday', { exact: true }).fill(week);
}
async function preview(http: Http, week: string, low: Stock) {
  return data<Preview>(await http.post(`${api}/purchasing/${week}/preview`, { data: {
    includeMeals: false, roomIds: [], lowStockTargets: [{ itemId: low.id, targetQuantity: '10' }],
  } }));
}
async function save(http: Http, value: Preview) {
  return data<List>(await http.put(`${api}/purchasing/${value.list.weekStart}`, { data: {
    version: value.list.version, token: value.token, choices: choices(value.list),
  } }));
}
async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const main = page.getByRole('main');
  const size = await main.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth,
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(size.content, 'Purchasing content must fit the mobile viewport').toBeLessThanOrEqual(size.width + 1);
  expect(size.document).toBeLessThanOrEqual(size.viewport + 1);
  for (const control of await main.locator('button:visible, select:visible, input:not([type="checkbox"]):not([type="radio"]):visible').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.viewport + 1);
  }
}

test('one mobile list combines saved meals, selected rooms and overlapping low-stock coverage without changing stock', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 320, height: 850 });
  page.on('dialog', dialog => { void dialog.accept(); });
  const http = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const ingredient = await data<{ id: string }>(await http.post(api + '/ingredients', { data: { name: 'Purchasing food ' + suffix, unit: 'count' } }), 201);
  const food = await stock(http, 'Purchasing food stock ' + suffix, 'Kitchen shelf', '5', { category: 'Food', ingredientId: ingredient.id, reorderThreshold: '10' });
  const equipment = await stock(http, 'Purchasing shared equipment ' + suffix, 'Room cupboard', '2');
  // A similarly named record is a separate physical stock pool. It cannot fill
  // a material demand linked specifically to the Room cupboard record.
  await stock(http, equipment.name, 'Locked store', '1000');
  const rooms = await Promise.all(['First', 'Second', 'Excluded'].map(name => room(http, 'Purchasing ' + name + ' ' + suffix)));
  for (let index = 0; index < rooms.length; index++) {
    const activity = await data<{ id: string }>(await http.post(api + '/activity', { data: {
      name: 'Purchasing activity ' + index + ' ' + suffix, description: 'Synthetic local material demand.',
      durationMinutes: 30, ageMinMonths: 24, ageMaxMonths: 60, roomId: rooms[index].id,
      materials: [{ itemId: food.id, quantity: index === 2 ? '100' : '2', unit: 'count', reusable: false },
        { itemId: equipment.id, quantity: index === 2 ? '100' : String(index + 2), unit: 'count', reusable: true }],
    } }), 201);
    await data(await http.post(api + '/schedule/plan', { data: { roomId: rooms[index].id, weekStart: weeks.combined, version: 0,
      requestId: randomUUID(), entries: [{ id: randomUUID(), date: weeks.combined, startTime: '09:00', endTime: '09:30', activityId: activity.id }] } }));
  }
  const meal = await data<{ id: string }>(await http.post(api + '/meals', { data: { name: 'Purchasing breakfast ' + suffix, type: 'breakfast' } }), 201);
  await data(await http.post(`${api}/meals/${meal.id}/ingredients`, { data: { ingredientId: ingredient.id, quantity: 1 } }), 201);
  const mealPreview = await data<{ previewToken: string }>(await http.post(`${api}/menu/plans/${weeks.combined}/preview`, { data: {
    version: 0, childrenCount: 2, staffCount: 1,
    week: ['Monday', 'Tuesday'].map(day => ({ day, menu: { breakfast: { id: meal.id } } })),
  } }));
  const mealSnapshot = await data(await http.put(`${api}/menu/plans/${weeks.combined}`, { data: { previewToken: mealPreview.previewToken } }));

  await openWeek(page, weeks.combined);
  await page.getByRole('checkbox', { name: 'Include saved meal plan', exact: true }).check();
  for (const selected of rooms.slice(0, 2)) await page.getByRole('checkbox', { name: 'Include ' + selected.name, exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Include ' + rooms[2].name, exact: true })).not.toBeChecked();
  await page.locator('summary').filter({ hasText: 'Optional low-stock supplies' }).click();
  await page.getByRole('checkbox', { name: 'Top up ' + label(food), exact: true }).check();
  await page.getByLabel('Total coverage for ' + label(food) + ' (count)', { exact: true }).fill('8');
  const calculated = page.waitForResponse(response => response.url() === `${api}/purchasing/${weeks.combined}/preview` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Build purchasing list', exact: true }).click();
  const calculation = await data<Preview>(await calculated);
  expect(calculation.list.issues).toEqual([]);
  expect(new Set(calculation.list.roomIds)).toEqual(new Set(rooms.slice(0, 2).map(value => value.id)));
  const foodLine = calculation.list.lines.find(line => line.itemId === food.id)!;
  expect(foodLine).toMatchObject({ needed: '10', inStorage: '5', toBuy: '5' });
  expect(new Set(foodLine.sources.map(source => source.kind))).toEqual(new Set(['meal', 'activity', 'low-stock']));
  expect(calculation.list.lines.find(line => line.itemId === equipment.id)).toMatchObject({ needed: '5', inStorage: '2', toBuy: '3' });
  const foodCard = page.getByRole('article', { name: label(food), exact: true });
  await expect(foodCard).toBeVisible();
  await expect(foodCard.getByText('10 count', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Buy quantity for ' + label(food) + ' (count)', { exact: true }).fill('6');
  await page.getByRole('checkbox', { name: 'Buy ' + label(equipment), exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Checked off ' + label(food), exact: true }).check();
  await fits(page);
  const savedResponse = page.waitForResponse(response => response.url() === `${api}/purchasing/${weeks.combined}` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save purchasing list', exact: true }).click();
  const saved = await data<List>(await savedResponse);
  expect(saved.version).toBe(1);
  expect(saved.lines.find(line => line.itemId === food.id)).toMatchObject({ buyQuantity: '6', selected: true, checked: true });
  expect(saved.lines.find(line => line.itemId === equipment.id)?.selected).toBe(false);
  await page.reload();
  await expect(page.getByLabel('Purchasing week starting Monday', { exact: true })).toHaveValue(weeks.combined);
  await expect(page.getByLabel('Buy quantity for ' + label(food) + ' (count)', { exact: true })).toHaveValue('6');
  await expect(page.getByRole('checkbox', { name: 'Checked off ' + label(food), exact: true })).toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export selected CSV', exact: true }).click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain(food.name);
  expect(csv).not.toContain(equipment.name);
  // Print uses the reviewed selection and exposes source detail even when its
  // disclosure was closed on screen. No OS printer dialog is needed to verify.
  await expect(foodCard.locator('details')).not.toHaveAttribute('open', '');
  await page.emulateMedia({ media: 'print' });
  await expect(foodCard).toBeVisible();
  await expect(page.getByRole('article', { name: label(equipment), exact: true })).toBeHidden();
  await expect(foodCard.locator('p.purchasing-print-only')).toContainText('Buy: 6 count');
  await expect(foodCard.getByText('Total coverage target', { exact: true }).filter({ visible: true })).toHaveCount(1);
  await page.emulateMedia({ media: 'screen' });
  expect((await data<Stock>(await http.get(api + '/inventory/' + food.id))).quantity).toBe('5');
  expect((await (await http.get(`${api}/inventory/${food.id}/movements`)).json()).total).toBe(1);
  expect(await data(await http.get(`${api}/menu/plans/${weeks.combined}`))).toEqual(mealSnapshot);

  await data(await http.post(`${api}/inventory/${food.id}/movements`, { data: { type: 'correction', quantity: '1', unit: 'count', version: food.version,
    reason: 'Synthetic physical count', requestId: randomUUID() } }));
  await page.reload();
  expect((await data<List>(await http.get(`${api}/purchasing/${weeks.combined}`))).lines.find(line => line.itemId === food.id)).toMatchObject({ inStorage: '5', toBuy: '5' });
  const refreshedResponse = page.waitForResponse(response => response.url() === `${api}/purchasing/${weeks.combined}/preview` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Refresh current stock', exact: true }).click();
  const refreshed = await data<Preview>(await refreshedResponse);
  expect(refreshed.list.lines.find(line => line.itemId === food.id)).toMatchObject({ needed: '10', inStorage: '1', toBuy: '9' });
  expect(await data(await http.get(`${api}/purchasing/${weeks.combined}`))).toEqual(saved);
  expect(await data(await http.get(`${api}/menu/plans/${weeks.combined}`))).toEqual(mealSnapshot);
  await fits(page);
  await page.screenshot({ path: '/tmp/sk109-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 850 });
  await fits(page);
  await page.screenshot({ path: '/tmp/sk109-desktop.png', fullPage: true });
});

test('a save conflict preserves the local buying quantity until the saved list is deliberately reopened', async ({ page }) => {
  const http = await authenticatedApi(page);
  const item = await stock(http, 'Purchasing conflict ' + randomUUID().slice(0, 8), 'Supply cabinet', '0');
  await save(http, await preview(http, weeks.conflict, item));
  page.on('dialog', dialog => { void dialog.accept(); });
  await openWeek(page, weeks.conflict);
  const quantity = page.getByLabel('Buy quantity for ' + label(item) + ' (count)', { exact: true });
  await expect(quantity).toHaveValue('10');
  await quantity.fill('12');
  const prior = await data<List>(await http.get(`${api}/purchasing/${weeks.conflict}`));
  await data<List>(await http.put(`${api}/purchasing/${weeks.conflict}`, { data: {
    version: prior.version, choices: choices(prior).map(choice => ({ ...choice, buyQuantity: '11' })),
  } }));
  const rejected = page.waitForResponse(response => response.url() === `${api}/purchasing/${weeks.conflict}` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save purchasing list', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('alert').filter({ hasText: /elsewhere|changed|reopen/i })).toBeVisible();
  await expect(quantity).toHaveValue('12');
  expect((await data<List>(await http.get(`${api}/purchasing/${weeks.conflict}`))).lines[0].buyQuantity).toBe('11');
  await page.getByRole('button', { name: 'Reopen saved list', exact: true }).click();
  await expect(quantity).toHaveValue('11');
});

test('a class viewer cannot inspect, preview, export or change a purchasing list', async ({ page, browser }) => {
  const http = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const item = await stock(http, 'Purchasing viewer ' + suffix, 'Supply cabinet', '0');
  const saved = await save(http, await preview(http, weeks.viewer, item));
  const temporaryPassword = 'Synthetic purchasing temporary passphrase 20!';
  const password = 'Synthetic purchasing changed passphrase 20!';
  const username = 'purchasing-viewer-' + suffix;
  const account = await data<{ id: string; displayName: string }>(await http.post(api + '/admin/accounts', { data: {
    username, displayName: 'Synthetic purchasing viewer', role: 'viewer', documentAccess: 'none', password: temporaryPassword,
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
    await viewer.goto('/purchasing?weekStart=' + weeks.viewer);
    await expect(viewer).toHaveURL(/\/classroom$/);
    await expect(viewer.getByRole('article', { name: label(item), exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Save purchasing list', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Export selected CSV', exact: true })).toHaveCount(0);
    expect((await viewer.request.get(`${api}/purchasing/${weeks.viewer}`, { headers })).status()).toBe(403);
    expect((await viewer.request.get(api + '/purchasing/options', { headers })).status()).toBe(403);
    expect((await viewer.request.post(`${api}/purchasing/${weeks.viewer}/preview`, { headers, data: {
      includeMeals: false, roomIds: [], lowStockTargets: [{ itemId: item.id, targetQuantity: '12' }],
    } })).status()).toBe(403);
    expect((await viewer.request.put(`${api}/purchasing/${weeks.viewer}`, { headers, data: {
      version: saved.version, choices: choices(saved).map(choice => ({ ...choice, checked: true })),
    } })).status()).toBe(403);
    expect(await data(await http.get(`${api}/purchasing/${weeks.viewer}`))).toEqual(saved);
    await fits(viewer);
  } finally {
    await context.close();
    await data(await http.put(api + '/admin/accounts/' + account.id, { data: {
      displayName: account.displayName, role: 'viewer', documentAccess: 'none', disabled: true,
    } }));
  }
});
