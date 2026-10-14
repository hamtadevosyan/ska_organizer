import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import type { Plan } from '../../src/components/meals/weeklyPlan';
import { api, authenticatedApi } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type Meal = { id: string; name: string; type: string; archived?: boolean };
const types = ['breakfast', 'snack', 'lunch', 'afternoonSnack'];
let http: Http;
let sharedMeals: Meal[];
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()).data as T;
}
// Use the real API to temporarily pause the shared catalog. Restore it even
// after a failure, leaving prior recipes and saved snapshots intact for other files.
test.beforeEach(async ({ page }) => {
  http = await authenticatedApi(page);
  sharedMeals = await data<Meal[]>(await http.get(api + '/meals'));
  for (const meal of sharedMeals) await data<Meal>(await http.put(api + '/meals/' + meal.id, { data: { archived: true } }));
});
test.afterEach(async () => {
  if (!http || !sharedMeals) return;
  const originals = new Set(sharedMeals.map(meal => meal.id));
  const current = await data<Meal[]>(await http.get(api + '/meals'));
  for (const meal of current) if (!originals.has(meal.id)) await data<Meal>(await http.put(api + '/meals/' + meal.id, { data: { archived: true } }));
  for (const meal of sharedMeals) await data<Meal>(await http.put(api + '/meals/' + meal.id, { data: { archived: false } }));
});
async function ingredients() {
  const suffix = randomUUID().slice(0, 8);
  const ingredient = await data<{ id: string }>(await http.post(api + '/ingredients', { data: { name: 'Menu generation ingredient ' + suffix, unit: 'count' } }), 201);
  const stock = await data<{ id: string }>(await http.post(api + '/inventory', { data: { name: 'Menu generation stock ' + suffix, category: 'Food', location: 'Kitchen shelf', ingredientId: ingredient.id, unit: 'count', openingQuantity: '10', reorderThreshold: '0', reason: 'Synthetic opening count', requestId: randomUUID() } }), 201);
  return { ingredient, stock, suffix };
}
async function createMeal(type: string, ingredientId: string, suffix: string) {
  const meal = await data<Meal>(await http.post(api + '/meals', { data: { name: 'Ready ' + type + ' ' + suffix, type } }), 201);
  await data<unknown>(await http.post(api + '/meals/' + meal.id + '/ingredients', { data: { ingredientId, quantity: 1 } }), 201);
  return meal;
}
async function catalog(periods = types) {
  const setup = await ingredients();
  const meals: Meal[] = [];
  for (const type of periods) meals.push(await createMeal(type, setup.ingredient.id, setup.suffix));
  return { ...setup, meals };
}
async function open(page: Page, week: string) {
  await page.goto('/meals');
  await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
  await expect(page.getByRole('button', { name: 'Generate Menu', exact: true })).toBeEnabled();
}
async function generate(page: Page, status = 200) {
  const response = page.waitForResponse(res => res.url() === api + '/menu/generate');
  await page.getByRole('button', { name: 'Generate Menu', exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(status);
}
const saved = (week: string) => http.get(api + '/menu/plans/' + week).then(response => data<Plan | null>(response));
async function fit(page: Page) {
  const sizes = await page.locator('.ska-core-page').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1); expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1);
}

test('empty catalog names missing periods and recovers through Meal Setup while keeping counts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const week = '2026-11-02'; await open(page, week);
  await page.getByLabel('Children', { exact: true }).fill('18');
  await page.getByLabel('Staff', { exact: true }).fill('3');
  await generate(page, 422);
  await expect(page.getByRole('heading', { name: 'Menu generation could not finish', exact: true })).toBeVisible();
  const alert = page.getByRole('alert').filter({ hasText: 'Menu generation could not finish' });
  for (const name of ['Breakfast', 'Morning snack', 'Lunch', 'Afternoon snack']) await expect(alert).toContainText(name);
  await expect(page.getByLabel('Children', { exact: true })).toHaveValue('18');
  await expect(page.getByLabel('Staff', { exact: true })).toHaveValue('3');
  expect(await saved(week)).toBeNull();
  await fit(page);
  await page.getByRole('button', { name: 'Open Meal Setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Planner', exact: true })).toBeVisible();
  const setup = await catalog();
  await page.getByRole('button', { name: 'Planner', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry generation', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Breakfast', exact: true })).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Children', { exact: true })).toHaveValue('18');
  await expect(page.getByLabel('Staff', { exact: true })).toHaveValue('3');
  expect(await saved(week)).toBeNull();
  expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + setup.stock.id))).quantity).toBe('10');
});

test('archived and incomplete snacks explain setup while a repaired valid option restores generation', async ({ page }) => {
  const setup = await catalog(['breakfast', 'lunch', 'afternoonSnack']);
  const unfinished = await data<Meal>(await http.post(api + '/meals', { data: { name: 'Incomplete morning snack ' + setup.suffix, type: 'snack' } }), 201);
  const archived = await createMeal('snack', setup.ingredient.id, setup.suffix);
  await data<Meal>(await http.put(api + '/meals/' + archived.id, { data: { archived: true } }));
  await open(page, '2026-11-30'); await generate(page, 422);
  const alert = page.getByRole('alert').filter({ hasText: 'Menu generation could not finish' });
  await expect(alert).toContainText('Morning snack'); await expect(alert).toContainText(unfinished.name);
  await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Open Meal Setup', exact: true }).click();
  await data<unknown>(await http.post(api + '/meals/' + unfinished.id + '/ingredients', { data: { ingredientId: setup.ingredient.id, quantity: 1 } }), 201);
  await page.getByRole('button', { name: 'Planner', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry generation', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeEnabled();
  for (const select of await page.getByRole('combobox', { name: 'Morning Snack', exact: true }).all()) await expect(select).toHaveValue(unfinished.id);
});

for (const [index, width] of [320, 390, 1280].entries()) {
  test(`valid alternatives generate, preview and save; failed regeneration retains counts and saved history at ${width}px`, async ({ page }) => {
    test.setTimeout(60000); await page.setViewportSize({ width, height: 850 });
    const setup = await catalog();
    const incomplete = await data<Meal>(await http.post(api + '/meals', { data: { name: 'A unfinished breakfast ' + setup.suffix, type: 'breakfast' } }), 201);
    const week = ['2026-11-09', '2026-11-16', '2026-11-23'][index];
    const tuesday = new Date(week + 'T12:00:00Z'); tuesday.setUTCDate(tuesday.getUTCDate() + 1);
    const date = tuesday.toISOString().slice(0, 10);
    await open(page, week);
    await page.getByLabel('Children', { exact: true }).fill('4'); await page.getByLabel('Staff', { exact: true }).fill('1');
    await generate(page);
    await expect(page.getByRole('combobox', { name: 'Breakfast', exact: true })).toHaveCount(5);
    for (const select of await page.getByRole('combobox', { name: 'Breakfast', exact: true }).all()) await expect(select).toHaveValue(setup.meals[0].id);
    await expect(page.getByText(incomplete.name, { exact: false }).first()).toBeVisible();
    await page.getByLabel('Children for Tuesday', { exact: true }).fill('6');
    await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeEnabled();
    await fit(page);
    expect(await saved(week)).toBeNull();
    await page.getByRole('button', { name: 'Save Menu', exact: true }).click();
    await expect(page.getByText('Menu and shopping list saved.', { exact: true })).toBeVisible();
    const first = await saved(week);
    expect(first).toMatchObject({ version: 1, childrenCount: 4, staffCount: 1, dailyChildrenCounts: { [date]: 6 }, items: [{ quantity: 108, inStorage: 10, toBuy: 98 }] });
    await page.reload();
    await expect(page.getByLabel('Children', { exact: true })).toHaveValue('4');
    await expect(page.getByLabel('Children for Tuesday', { exact: true })).toHaveValue('6');
    await page.getByLabel('Children', { exact: true }).fill('7');
    const before = await page.getByRole('combobox', { name: 'Breakfast', exact: true }).evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value));
    page.once('dialog', dialog => void dialog.accept());
    await page.route('**/api/menu/generate', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic generation unavailable' } }) }));
    await generate(page, 503);
    await expect(page.getByRole('heading', { name: 'Menu generation could not finish', exact: true })).toBeVisible();
    await expect(page.getByLabel('Children', { exact: true })).toHaveValue('7'); await expect(page.getByLabel('Children for Tuesday', { exact: true })).toHaveValue('6');
    expect(await page.getByRole('combobox', { name: 'Breakfast', exact: true }).evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value))).toEqual(before);
    expect(await saved(week)).toEqual(first);
    await page.unroute('**/api/menu/generate');
    page.once('dialog', dialog => void dialog.accept());
    await page.getByRole('button', { name: 'Retry generation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Children', { exact: true })).toHaveValue('7'); await expect(page.getByLabel('Children for Tuesday', { exact: true })).toHaveValue('6');
    await page.getByRole('button', { name: 'Save Menu', exact: true }).click();
    await expect(page.getByText('Menu and shopping list saved.', { exact: true })).toBeVisible();
    expect(await saved(week)).toMatchObject({ version: 2, childrenCount: 7, dailyChildrenCounts: { [date]: 6 }, items: [{ quantity: 156, inStorage: 10, toBuy: 146 }] });
    expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + setup.stock.id))).quantity).toBe('10');
    expect((await (await http.get(api + '/inventory/' + setup.stock.id + '/movements')).json()).total).toBe(1);
  });
}

test('canceling a slow generation cannot replace a newer week or edited counts', async ({ page }) => {
  const setup = await catalog();
  const week = '2026-12-07'; await open(page, week);
  await page.getByLabel('Children', { exact: true }).fill('7');
  const payload = await (await http.get(api + '/menu/generate')).json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/menu/generate', async route => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Generate Menu', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel generation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel generation', exact: true }).click();
  await page.getByLabel('Children', { exact: true }).fill('9');
  await page.getByLabel('Week starting Monday', { exact: true }).fill('2026-12-14');
  const roster = await data<{ childrenCount: number; staffCount: number }>(await http.get(api + '/menu/headcounts'));
  await expect(page.getByLabel('Children', { exact: true })).toHaveValue(String(roster.childrenCount));
  await expect(page.getByLabel('Staff', { exact: true })).toHaveValue(String(roster.staffCount));
  release();
  await expect(page.getByRole('combobox', { name: 'Breakfast', exact: true })).toHaveCount(0);
  await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
  await expect(page.getByLabel('Children', { exact: true })).toHaveValue('9');
  await expect(page.getByRole('combobox', { name: 'Breakfast', exact: true })).toHaveCount(0);
  expect(await saved(week)).toBeNull();
  expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + setup.stock.id))).quantity).toBe('10');
});
