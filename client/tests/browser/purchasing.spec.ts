import { test, expect } from '@playwright/test';
import { authenticatedApi, api } from './auth-helpers';

const randomUUID = () => crypto.randomUUID();

test('receive purchases, reopen history and deliberately refresh historical shopping without consuming stock', async ({ page }) => {
  const request = await authenticatedApi(page);
  const suffix = randomUUID().slice(0, 8);
  const name = 'Purchase eggs ' + suffix;
  const ingredientResponse = await request.post(api + '/ingredients', { data: { name, unit: 'count' } });
  expect(ingredientResponse.status()).toBe(201); const ingredient = (await ingredientResponse.json()).data;
  const mealResponse = await request.post(api + '/meals', { data: { name: 'Purchase breakfast ' + suffix, type: 'breakfast' } });
  expect(mealResponse.status()).toBe(201); const meal = (await mealResponse.json()).data;
  expect((await request.post(api + '/meals/' + meal.id + '/ingredients', { data: { ingredientId: ingredient.id, quantity: 1 } })).status()).toBe(201);
  const groupResponse = await request.post(api + '/inventory/groups', { data: { name: 'Purchasing ' + suffix, kind: 'food', requestId: randomUUID() } });
  expect(groupResponse.status()).toBe(201); const group = (await groupResponse.json()).data;
  const created = await request.post(api + '/inventory', { data: { name, groupId: group.id,
    ingredientId: null, unit: 'count', location: 'Kitchen / Shelf 1', openingQuantity: '2', reorderThreshold: '0',
    reason: 'Opening count', requestId: randomUUID() } });
  expect(created.status()).toBe(201); const stock = (await created.json()).data;
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Open group Purchasing ' + suffix, exact: true }).click();
  await page.locator('summary[aria-label="More for ' + name + '"]').click();
  await page.getByRole('button', { name: 'Choose food for ' + name, exact: true }).click();
  await page.getByRole('combobox', { name: 'Food', exact: true }).selectOption(ingredient.id);
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.getByText('Details saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose food for ' + name, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bought more ' + name, exact: true }).click();
  const receive = page.getByRole('button', { name: 'Save amount', exact: true });
  await expect(receive).toBeEnabled();
  await page.getByLabel('How much did you buy? (pieces)', { exact: true }).fill('3');
  await page.getByText('Date, cost or notes (optional)', { exact: true }).click();
  await page.getByLabel('Supplier (optional)', { exact: true }).fill('Synthetic market');
  await page.getByLabel('Total cost (USD, optional)', { exact: true }).fill('7.50');
  const sent = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/' + stock.id + '/purchases'));
  await receive.click();
  const payload = (await sent).postDataJSON();
  await expect(page.getByText('Added to what you have.')).toBeVisible();
  const repeated = await request.post(api + '/inventory/' + stock.id + '/purchases', { data: payload });
  expect(repeated.status()).toBe(201); expect((await repeated.json()).data).toMatchObject({ replayed: true, item: { quantity: '5' } });
  await page.reload();
  await page.getByRole('button', { name: 'Open group Purchasing ' + suffix, exact: true }).click();
  await page.locator('summary[aria-label="More for ' + name + '"]').click();
  await page.getByRole('button', { name: 'Purchases for ' + name, exact: true }).click();
  const history = page.getByRole('region', { name: 'Purchase history', exact: true });
  await expect(history.getByText('7.50 USD', { exact: true })).toBeVisible();
  await expect(history.getByText('3 count', { exact: true })).toBeVisible();

  await page.goto('/meals');
  await page.getByLabel('Week starting Monday').fill('2026-11-02');
  await page.getByRole('button', { name: 'Generate Menu' }).click();
  const breakfasts = page.getByRole('combobox', { name: 'Breakfast', exact: true });
  await expect(breakfasts).toHaveCount(5);
  for (let day = 0; day < 5; day++) await breakfasts.nth(day).selectOption(meal.id);
  await page.getByLabel('Children', { exact: true }).fill('1');
  await page.getByLabel('Staff', { exact: true }).fill('0');
  const row = page.getByRole('table').getByRole('row').filter({ hasText: name });
  await expect(row.getByText('0 count', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save Menu' }).click();
  await expect(page.getByText('Menu and shopping list saved.')).toBeVisible();
  const current = (await (await request.get(api + '/inventory/' + stock.id)).json()).data;
  expect(current.quantity).toBe('5');
  expect((await request.post(api + '/inventory/' + stock.id + '/movements', { data: { type: 'correction', quantity: '1',
    unit: 'count', version: current.version, reason: 'Physical recount', requestId: randomUUID() } })).status()).toBe(200);
  await page.reload();
  await expect(row.getByText('0 count', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Menu' })).toBeDisabled();
  await page.getByRole('button', { name: 'Update shopping list' }).click();
  await expect(row.getByText('4 count', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', { name: 'Print List' }).click();
  await page.getByRole('button', { name: 'Save Menu' }).click();
  await expect(page.getByText('Menu and shopping list saved.')).toBeVisible();
  expect((await (await request.get(api + '/inventory/' + stock.id)).json()).data.quantity).toBe('1');
  const receipts = (await (await request.get(api + '/inventory/purchases?itemId=' + stock.id)).json());
  expect(receipts.total).toBe(1);
});
