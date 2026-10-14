import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import type { Plan } from '../../src/components/meals/weeklyPlan';
import { api, authenticatedApi } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type Meal = { id: string; name: string; type: string };
type Headcounts = { childrenCount: number; staffCount: number };
type Child = { id: string; active: boolean };
type Staff = { id: string; active: boolean; version: number };
type Account = { id: string; displayName: string; role: string };
const mealTypes = ['breakfast', 'snack', 'lunch', 'afternoonSnack'];

async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return await response.json() as T;
}
async function data<T>(response: APIResponse, status = 200): Promise<T> {
  return (await json<{ data: T }>(response, status)).data;
}
async function fit(page: Page) {
  const size = await page.locator('.ska-core-page').evaluate(element => ({
    available: element.clientWidth, content: element.scrollWidth,
    screen: document.documentElement.clientWidth, document: document.documentElement.scrollWidth,
  }));
  expect(size.document).toBeLessThanOrEqual(size.screen + 1);
  expect(size.content).toBeLessThanOrEqual(size.available + 1);
  const button = page.getByRole('button', { name: 'Use current roster counts', exact: true });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.screen + 1);
}

for (const [index, width] of [320, 390].entries()) {
  test(`new weeks use the active roster and saved counts change only on request at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    const http: Http = await authenticatedApi(page);
    const suffix = randomUUID().slice(0, 8);
    const children: Child[] = [];
    const staff: Staff[] = [];
    let account: Account | undefined;
    const sharedMeals = await data<Meal[]>(await http.get(api + '/meals'));
    const baseline = await data<Headcounts>(await http.get(api + '/menu/headcounts'));
    async function child(active: boolean) {
      const record = await json<Child>(await http.post(api + '/children', { data: {
        firstName: 'Synthetic', lastName: `Menu roster ${suffix} ${children.length}`,
        dateOfBirth: '2023-01-01', active, roomId: null,
      } }), 201);
      children.push(record); return record;
    }
    async function employee(active: boolean) {
      const record = await data<Staff>(await http.post(api + '/staff', { data: {
        name: `Synthetic menu staff ${suffix} ${staff.length}`, role: 'Teacher', active, roomId: null,
      } }), 201);
      staff.push(record); return record;
    }
    const week = ['2032-04-05', '2032-04-12'][index];
    const nextWeek = ['2032-05-03', '2032-05-10'][index];
    const tuesday = ['2032-04-06', '2032-04-13'][index];
    const saved = () => http.get(api + '/menu/plans/' + week).then(response => data<Plan | null>(response));
    try {
      // Measure shared fixture records rather than assuming a fixed initial roster.
      await child(true); await child(true); await child(false);
      await employee(true); await employee(true); await employee(false);
      const expected = { childrenCount: baseline.childrenCount + 2, staffCount: baseline.staffCount + 2 };
      expect(await data<Headcounts>(await http.get(api + '/menu/headcounts'))).toEqual(expected);
      // Sign-in accounts are permissions, not additional people in the staff roster.
      account = await data<Account>(await http.post(api + '/admin/accounts', { data: {
        username: 'menu-roster-' + suffix, displayName: 'Synthetic menu account ' + suffix,
        role: 'editor', documentAccess: 'none', password: 'Synthetic roster passphrase 32!',
      } }), 201);
      expect(await data<Headcounts>(await http.get(api + '/menu/headcounts'))).toEqual(expected);

      // Pause the shared catalog without deleting IDs or historical recipes.
      for (const meal of sharedMeals) await data<Meal>(await http.put(api + '/meals/' + meal.id, { data: { archived: true } }));
      const ingredient = await data<{ id: string }>(await http.post(api + '/ingredients', { data: { name: 'Menu roster ingredient ' + suffix, unit: 'count' } }), 201);
      const stock = await data<{ id: string }>(await http.post(api + '/inventory', { data: {
        name: 'Menu roster stock ' + suffix, category: 'Food', location: 'Kitchen shelf', ingredientId: ingredient.id,
        unit: 'count', openingQuantity: '3', reorderThreshold: '0', reason: 'Synthetic opening count', requestId: randomUUID(),
      } }), 201);
      for (const type of mealTypes) {
        const meal = await data<Meal>(await http.post(api + '/meals', { data: { name: `Roster ${type} ${suffix}`, type } }), 201);
        await data<unknown>(await http.post(`${api}/meals/${meal.id}/ingredients`, { data: { ingredientId: ingredient.id, quantity: 1 } }), 201);
      }
      await page.goto('/meals');
      await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
      await expect(page.getByLabel('Children', { exact: true })).toHaveValue(String(expected.childrenCount));
      await expect(page.getByLabel('Staff', { exact: true })).toHaveValue(String(expected.staffCount));
      await fit(page);

      // A menu's planned portions can differ from the current roster.
      await page.getByLabel('Children', { exact: true }).fill('4');
      await page.getByLabel('Staff', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'Generate Menu', exact: true }).click();
      await expect(page.getByRole('combobox', { name: 'Breakfast', exact: true })).toHaveCount(5);
      await page.getByLabel('Children for Tuesday', { exact: true }).fill('6');
      await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Save Menu', exact: true }).click();
      await expect(page.getByText('Menu and shopping list saved.', { exact: true })).toBeVisible();
      const first = await saved();
      expect(first).toMatchObject({ version: 1, childrenCount: 4, staffCount: 1,
        dailyChildrenCounts: { [tuesday]: 6 }, items: [{ quantity: 108, inStorage: 3, toBuy: 105 }] });
      await page.reload();
      await expect(page.getByLabel('Children', { exact: true })).toHaveValue('4');
      await expect(page.getByLabel('Staff', { exact: true })).toHaveValue('1');
      await expect(page.getByLabel('Children for Tuesday', { exact: true })).toHaveValue('6');
      expect(await saved()).toEqual(first);

      const plannedMeals = await page.getByRole('combobox', { name: 'Breakfast', exact: true }).evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value));
      await page.getByRole('button', { name: 'Use current roster counts', exact: true }).click();
      await expect(page.getByLabel('Children', { exact: true })).toHaveValue(String(expected.childrenCount));
      await expect(page.getByLabel('Staff', { exact: true })).toHaveValue(String(expected.staffCount));
      await expect(page.getByLabel('Children for Tuesday', { exact: true })).toHaveValue('6');
      expect(await page.getByRole('combobox', { name: 'Breakfast', exact: true }).evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value))).toEqual(plannedMeals);
      // Explicit refresh edits a draft; it does not silently resave history.
      expect(await saved()).toEqual(first);
      await expect(page.getByRole('button', { name: 'Save Menu', exact: true })).toBeEnabled();
      await fit(page);
      await page.getByRole('button', { name: 'Save Menu', exact: true }).click();
      await expect(page.getByText('Menu and shopping list saved.', { exact: true })).toBeVisible();
      const quantity = 4 * (4 * expected.childrenCount + 6 + 5 * expected.staffCount);
      expect(await saved()).toMatchObject({ version: 2, ...expected, week: first!.week, dailyChildrenCounts: { [tuesday]: 6 },
        items: [{ quantity, inStorage: 3, toBuy: Math.max(quantity - 3, 0) }] });
      expect((await data<{ quantity: string }>(await http.get(api + '/inventory/' + stock.id))).quantity).toBe('3');
      expect((await json<{ total: number }>(await http.get(`${api}/inventory/${stock.id}/movements`))).total).toBe(1);

      // Another new week fetches the changed roster, while the saved week keeps
      // the previous counts until the user explicitly chooses to update it.
      await child(true); await employee(true);
      await page.getByLabel('Week starting Monday', { exact: true }).fill(nextWeek);
      await expect(page.getByLabel('Children', { exact: true })).toHaveValue(String(expected.childrenCount + 1));
      await expect(page.getByLabel('Staff', { exact: true })).toHaveValue(String(expected.staffCount + 1));
      await page.getByLabel('Week starting Monday', { exact: true }).fill(week);
      await expect(page.getByLabel('Children', { exact: true })).toHaveValue(String(expected.childrenCount));
      await expect(page.getByLabel('Staff', { exact: true })).toHaveValue(String(expected.staffCount));
      await expect(page.getByLabel('Children for Tuesday', { exact: true })).toHaveValue('6');
    } finally {
      // Restore global catalogs and remove only these fixtures from live counts.
      const originals = new Set(sharedMeals.map(meal => meal.id));
      const current = await data<Meal[]>(await http.get(api + '/meals'));
      for (const meal of current) if (!originals.has(meal.id)) await data<Meal>(await http.put(api + '/meals/' + meal.id, { data: { archived: true } }));
      for (const meal of sharedMeals) await data<Meal>(await http.put(api + '/meals/' + meal.id, { data: { archived: false } }));
      for (const record of children) if (record.active) await json<Child>(await http.put(`${api}/children/${record.id}/enrollment`, { data: { active: false } }));
      for (const record of staff) if (record.active) {
        const currentStaff = await data<Staff>(await http.get(api + '/staff/' + record.id));
        await data<Staff>(await http.put(api + '/staff/' + record.id, { data: { active: false, version: currentStaff.version } }));
      }
      if (account) await data<Account>(await http.put(api + '/admin/accounts/' + account.id, { data: {
        displayName: account.displayName, role: account.role, disabled: true, documentAccess: 'none',
      } }));
      expect(await data<Headcounts>(await http.get(api + '/menu/headcounts'))).toEqual(baseline);
    }
  });
}
