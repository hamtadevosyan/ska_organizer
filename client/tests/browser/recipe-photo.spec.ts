import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { api, authenticatedApi } from './auth-helpers';

const fixture = fileURLToPath(new URL('../../../server/tests/fixtures/recipe-photo.png', import.meta.url));

for (const width of [320, 1280]) {
  test(`real recipe photo becomes a reviewed meal without saving until requested at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    const http = await authenticatedApi(page);
    const before = (await (await http.get(api + '/meals')).json()).data;
    await page.goto('/meals');
    await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
    await page.getByRole('button', { name: 'Import recipe photo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Turn a recipe photo into a meal' })).toBeFocused();
    await expect(page.getByLabel('Recipe camera image')).toHaveAttribute('capture', 'environment');
    const read = page.waitForResponse(response => response.url() === api + '/meals/recipe-photo');
    await page.getByLabel('Recipe image file').setInputFiles(fixture);
    const result = await read;
    expect(result.status()).toBe(200);
    expect(result.headers()['cache-control']).toBe('no-store');
    expect(Object.keys(result.request().postDataJSON())).toEqual(['image']);
    await expect(page.getByLabel('Recipe meal name', { exact: true })).toHaveValue('Banana oat bowls');
    await expect(page.getByLabel('Recipe makes how many servings?')).toHaveValue('4');
    await expect(page.getByLabel('Recipe ingredient lines')).toHaveValue('120 g Oats\n400 ml Milk\n2 Bananas');
    expect((await (await http.get(api + '/meals')).json()).data).toEqual(before);

    const name = 'Photo oat bowls ' + crypto.randomUUID().slice(0, 8);
    await page.getByLabel('Recipe meal name', { exact: true }).fill(name);
    await page.getByLabel('Recipe ingredient lines').fill('120 g Oats\n400 ml Milk\n2 Bananas\n1 cup Berries');
    await page.getByRole('button', { name: 'Use recipe in meal draft' }).click();
    await expect(page.getByRole('checkbox')).toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Use recipe in meal draft' }).click();
    const form = page.getByRole('form', { name: 'Create meal from idea' });
    await expect(form.getByLabel('Meal name', { exact: true })).toBeFocused();
    await expect(form.getByLabel('Ingredient 1 quantity per person (g)')).toHaveValue('30');
    await expect(form.getByLabel('Ingredient 2 quantity per person (ml)')).toHaveValue('100');
    await expect(form.getByLabel('Ingredient 3 quantity per person (count)')).toHaveValue('0.5');
    await expect(form.getByText('From recipe: 1 cup Berries', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Save meal & recipe' }).click();
    await expect(form.getByLabel('Ingredient 4 unit', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await form.getByLabel('Ingredient 4 name', { exact: true }).fill('Photo berries ' + name);
    await form.getByLabel('Ingredient 4 unit', { exact: true }).selectOption('g');
    await form.getByLabel('Ingredient 4 quantity per person (g)').fill('40');
    const size = await page.locator('main').evaluate(main => ({ width: main.clientWidth, content: main.scrollWidth, page: document.documentElement.scrollWidth, screen: document.documentElement.clientWidth }));
    expect(size.content).toBeLessThanOrEqual(size.width + 1); expect(size.page).toBeLessThanOrEqual(size.screen + 1);
    for (const control of await form.locator('button:visible, input:visible, select:visible, textarea:visible').all()) {
      const box = await control.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    const saved = page.waitForResponse(response => response.url() === api + '/meals/with-recipe');
    await form.getByRole('button', { name: 'Save meal & recipe' }).click();
    const response = await saved; expect(response.status()).toBe(201);
    const meal = (await response.json()).data;
    expect(meal.recipe.map((row: { quantity: number }) => row.quantity)).toEqual([30, 100, 0.5, 40]);
    await page.reload();
    await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
    await page.getByRole('button', { name: 'Browse meal ideas' }).click();
    await page.getByRole('button', { name: 'Saved meals', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copy ' + name, exact: true })).toBeVisible();
  });
}

test('unreadable photo can retry and navigation/cancel preserves or discards review without catalog writes', async ({ page }) => {
  test.setTimeout(60000);
  const http = await authenticatedApi(page);
  const before = (await (await http.get(api + '/meals')).json()).data;
  await page.goto('/meals');
  await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
  await page.getByRole('button', { name: 'Import recipe photo' }).click();
  await page.route('**/api/meals/recipe-photo', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic unreadable recipe. Try again.' } }) }));
  await page.getByLabel('Recipe image file').setInputFiles(fixture);
  await expect(page.getByRole('alert')).toContainText('Synthetic unreadable');
  await page.unroute('**/api/meals/recipe-photo');
  await page.getByLabel('Recipe image file').setInputFiles(fixture);
  await expect(page.getByLabel('Recipe meal name')).toHaveValue('Banana oat bowls');
  await page.getByRole('link', { name: 'Rooms & Classes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByLabel('Recipe meal name')).toHaveValue('Banana oat bowls');
  await page.getByRole('button', { name: 'Cancel photo import' }).click();
  await page.getByRole('button', { name: 'Keep editing photo' }).click();
  await expect(page.getByLabel('Recipe meal name')).toHaveValue('Banana oat bowls');
  await page.getByRole('button', { name: 'Cancel photo import' }).click();
  await page.getByRole('button', { name: 'Discard photo' }).click();
  await expect(page.getByRole('button', { name: 'Browse meal ideas' })).toBeFocused();
  expect((await (await http.get(api + '/meals')).json()).data).toEqual(before);
});
