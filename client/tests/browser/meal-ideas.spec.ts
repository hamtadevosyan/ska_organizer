import { expect, test } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import { api, authenticatedApi } from './auth-helpers';

type Http = Awaited<ReturnType<typeof authenticatedApi>>;
type Meal = { id: string; name: string; type: string; description: string; archived?: boolean };
type Ingredient = { id: string; name: string; unit: string; archived?: boolean };
type RecipeRow = { id: string; mealId: string; ingredientId: string; quantity: number };
type SavedMeal = { meal: Meal; ingredients: Ingredient[]; recipe: RecipeRow[] };
type SavePayload = { requestId: string; meal: { name: string; type: string; description: string };
  ingredients: { ingredientId?: string; name?: string; unit?: string; quantity: number }[] };

const unique = () => crypto.randomUUID().slice(0, 8);
const draftForm = (page: Page) => page.getByRole('form', { name: 'Create meal from idea', exact: true });
const source = (form: Locator, index: number) => form.getByRole('combobox', { name: `Ingredient ${index}`, exact: true });
const quantity = (form: Locator, index: number) => form.getByRole('spinbutton', { name: new RegExp(`^Ingredient ${index} quantity per person \\(`) });

async function data<T>(http: Http, path: string): Promise<T> {
  const response = await http.get(api + path);
  expect(response.status(), path + ' must be readable through the real fixture API').toBe(200);
  return (await response.json()).data as T;
}

async function catalog(http: Http) {
  const [meals, ingredients] = await Promise.all([
    data<Meal[]>(http, '/meals?includeArchived=true'),
    data<Ingredient[]>(http, '/ingredients?includeArchived=true'),
  ]);
  return { meals, ingredients };
}

async function inventoryState(http: Http, id: string) {
  const [item, movements] = await Promise.all([
    http.get(`${api}/inventory/${id}`), http.get(`${api}/inventory/${id}/movements`),
  ]);
  expect(item.status()).toBe(200); expect(movements.status()).toBe(200);
  return { item: (await item.json()).data, movements: await movements.json() };
}

async function createStock(http: Http, ingredient: Ingredient, suffix: string) {
  const response = await http.post(api + '/inventory', { data: {
    name: 'Meal idea stock ' + suffix, category: 'Food', location: 'Kitchen / Shelf 1',
    ingredientId: ingredient.id, unit: ingredient.unit, openingQuantity: '200',
    reorderThreshold: '0', reason: 'Synthetic meal idea opening count', requestId: crypto.randomUUID(),
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).data.id as string;
}

function catalogWrites(page: Page) {
  const writes: Request[] = [];
  page.on('request', request => {
    if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) &&
      /^\/api\/(meals|ingredients)(\/|$)/.test(new URL(request.url()).pathname)) writes.push(request);
  });
  return writes;
}

async function openIdeas(page: Page) {
  await page.goto('/meals');
  await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
  const browse = page.getByRole('button', { name: 'Browse meal ideas', exact: true });
  await expect(browse).toBeEnabled();
  await browse.click();
  await expect(page.getByRole('searchbox', { name: 'Search meal ideas', exact: true })).toBeFocused();
}

async function chooseOatmeal(page: Page) {
  await page.getByRole('button', { name: 'Choose Oatmeal with banana', exact: true }).click();
  const form = draftForm(page);
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Meal name', { exact: true })).toBeFocused();
  return form;
}

async function newIngredient(form: Locator, index: number, name: string, unit: string, amount: string) {
  await source(form, index).selectOption('new');
  await form.getByLabel(`Ingredient ${index} name`, { exact: true }).fill(name);
  await form.getByLabel(`Ingredient ${index} unit`, { exact: true }).selectOption(unit);
  await quantity(form, index).fill(amount);
}

async function save(page: Page, expectedStatus = 201) {
  const submitted = page.waitForRequest(request => request.url() === api + '/meals/with-recipe' && request.method() === 'POST');
  const completed = page.waitForResponse(response => response.url() === api + '/meals/with-recipe' && response.request().method() === 'POST');
  await draftForm(page).getByRole('button', { name: 'Save meal & recipe', exact: true }).click();
  const [request, response] = await Promise.all([submitted, completed]);
  expect(response.status()).toBe(expectedStatus);
  return { payload: request.postDataJSON() as SavePayload, saved: (await response.json()).data as SavedMeal };
}

async function expectFits(page: Page, scope: Locator) {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
  const dimensions = await page.locator('main').evaluate(main => ({
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth,
    content: main.scrollWidth, available: main.clientWidth,
  }));
  expect(dimensions.document, 'The page must not scroll horizontally').toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.content, 'The main region must not hide horizontal overflow').toBeLessThanOrEqual(dimensions.available + 1);
  const boxes = await scope.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { name: element.getAttribute('aria-label') || element.id || element.textContent,
      x: box.x, width: box.width, height: box.height };
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.height, box.name + ': target height').toBeGreaterThanOrEqual(44);
    expect(box.width, box.name + ': target width').toBeGreaterThanOrEqual(44);
    expect(box.x, box.name + ': left edge').toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, box.name + ': right edge').toBeLessThanOrEqual(dimensions.viewport + 1);
  }
}

for (const width of [390, 1280]) {
  test(`starter search becomes an editable saved recipe without changing stock at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const http = await authenticatedApi(page);
    const suffix = unique(), name = 'Synthetic oatmeal ' + suffix;
    const bananaName = 'Synthetic banana ' + suffix, berriesName = 'Synthetic berries ' + suffix;
    const initial = await catalog(http);
    const oats = initial.ingredients.find(ingredient => ingredient.name === 'Oats' && ingredient.unit === 'g' && !ingredient.archived)!;
    expect(oats, 'The isolated fixture supplies an existing Oats ingredient').toBeTruthy();
    const stockId = await createStock(http, oats, suffix), stockBefore = await inventoryState(http, stockId);
    const before = await catalog(http), writes = catalogWrites(page), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));

    await openIdeas(page);
    await expect(page.getByRole('button', { name: 'Starter ideas', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(20);
    const filter = page.getByRole('combobox', { name: 'Meal idea type', exact: true });
    const search = page.getByRole('searchbox', { name: 'Search meal ideas', exact: true });
    await filter.selectOption('breakfast');
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(5);
    await search.fill('BANANA oats');
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(2);
    await filter.selectOption('lunch');
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(0);
    await expect(page.getByText('No meals match your search. Try another name or meal type.', { exact: true })).toBeVisible();
    await filter.selectOption('breakfast');
    await search.fill('oatmeal banana');
    await expect(page.getByRole('button', { name: /^Choose / })).toHaveCount(1);
    await expectFits(page, page.getByRole('region', { name: 'Meal ideas', exact: true }));

    const form = await chooseOatmeal(page);
    await expect(form.getByLabel('Meal name', { exact: true })).toHaveValue('Oatmeal with banana');
    await expect(form.getByLabel('Meal type', { exact: true })).toHaveValue('breakfast');
    await expect(source(form, 1)).toHaveValue(oats.id);
    await expect(quantity(form, 1)).toHaveValue('30');
    await expect(quantity(form, 2)).toHaveValue('60');
    await expect(quantity(form, 3)).toHaveValue('120');
    await expect(form.getByLabel('Ingredient 2 name', { exact: true })).toHaveValue('Banana');
    await expect(form.getByLabel('Ingredient 2 unit', { exact: true })).toHaveValue('g');
    await expect(quantity(form, 3)).toHaveAccessibleName('Ingredient 3 quantity per person (ml)');
    await expect(page.getByLabel('Choose meal', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Choose ingredient', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Planner', exact: true })).toBeDisabled();
    await form.getByLabel('Meal name', { exact: true }).fill(name);
    await form.getByLabel('Meal type', { exact: true }).selectOption('lunch');
    await form.getByLabel('Description', { exact: true }).fill('Synthetic edited starter recipe.');
    await quantity(form, 1).fill('35.5');
    await newIngredient(form, 2, bananaName, 'g', '80');
    await form.getByRole('button', { name: 'Remove ingredient 3', exact: true }).click();
    await expect(source(form, 3)).toHaveCount(0);
    await form.getByRole('button', { name: 'Add ingredient', exact: true }).click();
    await newIngredient(form, 3, berriesName, 'g', '25');
    await expectFits(page, form);
    expect(await catalog(http)).toEqual(before);
    expect(await inventoryState(http, stockId)).toEqual(stockBefore);
    expect(writes).toHaveLength(0);

    const { payload, saved } = await save(page);
    expect(payload.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(payload).toEqual({ requestId: payload.requestId, meal: { name, type: 'lunch', description: 'Synthetic edited starter recipe.' },
      ingredients: [{ ingredientId: oats.id, quantity: 35.5 }, { name: bananaName, unit: 'g', quantity: 80 }, { name: berriesName, unit: 'g', quantity: 25 }] });
    expect(saved.meal).toMatchObject({ id: payload.requestId, name, type: 'lunch', description: 'Synthetic edited starter recipe.' });
    expect(saved.ingredients.map(ingredient => ({ id: ingredient.id, name: ingredient.name, unit: ingredient.unit })))
      .toEqual([{ id: oats.id, name: oats.name, unit: 'g' }, { id: saved.ingredients[1].id, name: bananaName, unit: 'g' }, { id: saved.ingredients[2].id, name: berriesName, unit: 'g' }]);
    expect(saved.recipe.map(row => ({ mealId: row.mealId, ingredientId: row.ingredientId, quantity: row.quantity })))
      .toEqual(saved.ingredients.map((ingredient, index) => ({ mealId: saved.meal.id, ingredientId: ingredient.id, quantity: [35.5, 80, 25][index] })));
    expect(new Set(saved.recipe.map(row => row.id)).size).toBe(3);
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Meal and recipe saved.' })).toBeVisible();
    expect(writes.map(request => [request.method(), new URL(request.url()).pathname])).toEqual([['POST', '/api/meals/with-recipe']]);
    const after = await catalog(http);
    expect(after.meals.filter(meal => meal.name === name)).toEqual([saved.meal]);
    expect(after.meals.filter(meal => meal.id !== saved.meal.id)).toEqual(before.meals);
    expect(after.ingredients).toHaveLength(before.ingredients.length + 2);
    expect(after.ingredients.filter(ingredient => ingredient.name === 'Oats' && ingredient.unit === 'g')).toEqual([oats]);
    expect(await data<RecipeRow[]>(http, `/meals/${saved.meal.id}/ingredients`)).toEqual(saved.recipe);
    expect(await inventoryState(http, stockId)).toEqual(stockBefore);

    await page.reload();
    await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
    await page.getByLabel('Choose meal', { exact: true }).selectOption(saved.meal.id);
    await expect(page.getByLabel('Meal name', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Meal type', { exact: true })).toHaveValue('lunch');
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Synthetic edited starter recipe.');
    for (const [index, ingredient] of saved.ingredients.entries()) {
      await expect(page.getByLabel(`${ingredient.name} quantity per person (${ingredient.unit})`, { exact: true })).toHaveValue(String([35.5, 80, 25][index]));
    }
    expect(await data<RecipeRow[]>(http, `/meals/${saved.meal.id}/ingredients`)).toEqual(saved.recipe);
    await expect(page.getByRole('button', { name: 'Planner', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Planner', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate Menu', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Generate Menu', exact: true }).click();
    const lunches = page.getByRole('combobox', { name: 'Lunch', exact: true });
    await expect(lunches).toHaveCount(5);
    await expect(lunches.first().getByRole('option', { name, exact: true })).toHaveAttribute('value', saved.meal.id);
    await lunches.first().selectOption(saved.meal.id);
    expect(await inventoryState(http, stockId)).toEqual(stockBefore);
    expect(errors).toEqual([]);
  });
}

test('cancel keeps edits until explicitly discarded and never writes the catalog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const http = await authenticatedApi(page), before = await catalog(http), writes = catalogWrites(page);
  const name = 'Synthetic cancelled meal ' + unique();
  await openIdeas(page);
  const form = await chooseOatmeal(page);
  await form.getByLabel('Meal name', { exact: true }).fill(name);
  await newIngredient(form, 1, 'Synthetic cancelled ingredient ' + unique(), 'g', '45');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  const confirmation = form.getByRole('group', { name: 'Discard meal draft', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(form.getByLabel('Meal name', { exact: true })).toHaveValue(name);
  await expect(quantity(form, 1)).toHaveValue('45');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Discard meal', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Browse meal ideas', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Planner', exact: true })).toBeEnabled();
  expect(await catalog(http)).toEqual(before);
  expect(writes).toHaveLength(0);
});

test('copying a searched saved meal preserves its original recipe and linked stock', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 850 });
  const http = await authenticatedApi(page), suffix = unique();
  const first = await http.post(api + '/ingredients', { data: { name: 'Synthetic copy rice ' + suffix, unit: 'g' } });
  const second = await http.post(api + '/ingredients', { data: { name: 'Synthetic copy sauce ' + suffix, unit: 'ml' } });
  expect(first.status()).toBe(201); expect(second.status()).toBe(201);
  const rice = (await first.json()).data as Ingredient, sauce = (await second.json()).data as Ingredient;
  const originalResponse = await http.post(api + '/meals', { data: { name: 'Synthetic saved lunch ' + suffix, type: 'lunch', description: 'Original recipe description.' } });
  expect(originalResponse.status()).toBe(201);
  const original = (await originalResponse.json()).data as Meal;
  for (const [ingredient, amount] of [[rice, 40], [sauce, 100]] as const) {
    expect((await http.post(`${api}/meals/${original.id}/ingredients`, { data: { ingredientId: ingredient.id, quantity: amount } })).status()).toBe(201);
  }
  const originalRecipe = await data<RecipeRow[]>(http, `/meals/${original.id}/ingredients`);
  const stockId = await createStock(http, rice, suffix), stockBefore = await inventoryState(http, stockId);
  const before = await catalog(http), writes = catalogWrites(page);
  await openIdeas(page);
  await page.getByRole('button', { name: 'Saved meals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved meals', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('searchbox', { name: 'Search meal ideas', exact: true }).fill(original.name);
  await page.getByRole('combobox', { name: 'Meal idea type', exact: true }).selectOption('lunch');
  await expect(page.getByRole('button', { name: /^Copy / })).toHaveCount(1);
  await page.getByRole('button', { name: 'Copy ' + original.name, exact: true }).click();
  const form = draftForm(page);
  await expect(form.getByLabel('Meal name', { exact: true })).toHaveValue(original.name + ' copy');
  await expect(form.getByLabel('Description', { exact: true })).toHaveValue(original.description);
  await expect(source(form, 1)).toHaveValue(rice.id); await expect(source(form, 2)).toHaveValue(sauce.id);
  await expect(quantity(form, 1)).toHaveValue('40'); await expect(quantity(form, 2)).toHaveValue('100');
  const name = 'Synthetic cloned meal ' + suffix, ingredientName = 'Synthetic copy peas ' + suffix;
  await form.getByLabel('Meal name', { exact: true }).fill(name);
  await form.getByLabel('Meal type', { exact: true }).selectOption('afternoonSnack');
  await form.getByLabel('Description', { exact: true }).fill('Edited copy description.');
  await quantity(form, 1).fill('75');
  await form.getByRole('button', { name: 'Remove ingredient 2', exact: true }).click();
  await form.getByRole('button', { name: 'Add ingredient', exact: true }).click();
  await newIngredient(form, 2, ingredientName, 'g', '20');
  expect(await catalog(http)).toEqual(before); expect(writes).toHaveLength(0);
  const { saved } = await save(page);
  expect(saved.meal.id).not.toBe(original.id);
  expect(saved.meal).toMatchObject({ name, type: 'afternoonSnack', description: 'Edited copy description.' });
  expect(saved.ingredients[0]).toEqual(rice);
  expect(saved.ingredients[1]).toMatchObject({ name: ingredientName, unit: 'g' });
  expect(saved.recipe.map(row => [row.ingredientId, row.quantity])).toEqual([[rice.id, 75], [saved.ingredients[1].id, 20]]);
  expect(saved.recipe.every(row => row.mealId === saved.meal.id && !originalRecipe.some(originalRow => originalRow.id === row.id))).toBe(true);
  const after = await catalog(http);
  expect(after.meals.find(meal => meal.id === original.id)).toEqual(original);
  expect(await data<RecipeRow[]>(http, `/meals/${original.id}/ingredients`)).toEqual(originalRecipe);
  expect(await data<RecipeRow[]>(http, `/meals/${saved.meal.id}/ingredients`)).toEqual(saved.recipe);
  expect(after.meals.filter(meal => meal.id !== saved.meal.id)).toEqual(before.meals);
  expect(after.ingredients).toHaveLength(before.ingredients.length + 1);
  expect(await inventoryState(http, stockId)).toEqual(stockBefore);
  expect(writes.map(request => new URL(request.url()).pathname)).toEqual(['/api/meals/with-recipe']);
});

test('invalid rows stay editable and a lost save response retries the same UUID exactly once', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 850 });
  const http = await authenticatedApi(page), before = await catalog(http), suffix = unique();
  const name = 'Synthetic retry meal ' + suffix, firstName = 'Synthetic retry oats ' + suffix, secondName = 'Synthetic retry fruit ' + suffix;
  const writes = catalogWrites(page);
  await openIdeas(page);
  const form = await chooseOatmeal(page);
  await form.getByLabel('Meal name', { exact: true }).fill(name);
  await newIngredient(form, 1, firstName, 'g', '32');
  await newIngredient(form, 2, secondName, 'g', '60');
  await form.getByRole('button', { name: 'Remove ingredient 3', exact: true }).click();
  await form.getByLabel('Ingredient 1 name', { exact: true }).fill('');
  await quantity(form, 2).fill('0');
  await form.getByRole('button', { name: 'Save meal & recipe', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText('Check the highlighted fields before saving.');
  await expect(form.getByLabel('Ingredient 1 name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(quantity(form, 2)).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel('Meal name', { exact: true })).toHaveValue(name);
  expect(await catalog(http)).toEqual(before); expect(writes).toHaveLength(0);
  await form.getByLabel('Ingredient 1 name', { exact: true }).fill(firstName);
  await quantity(form, 2).fill('60');
  let firstSaved: SavedMeal | undefined;
  let calls = 0;
  await page.route('**/api/meals/with-recipe', async route => {
    if (route.request().method() !== 'POST' || ++calls > 1) { await route.continue(); return; }
    // Commit through the real API, then lose its success response. Retrying
    // must recover that save rather than create another meal or ingredient.
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    firstSaved = (await response.json()).data as SavedMeal;
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Synthetic save response unavailable. Try saving again.' } }) });
  });
  const failed = page.waitForResponse(response => response.url() === api + '/meals/with-recipe' && response.status() === 503);
  await form.getByRole('button', { name: 'Save meal & recipe', exact: true }).click();
  await failed;
  await expect(form.getByRole('alert')).toHaveText('Synthetic save response unavailable. Try saving again.');
  await expect(form.getByLabel('Meal name', { exact: true })).toHaveValue(name);
  await expect(form.getByLabel('Ingredient 1 name', { exact: true })).toHaveValue(firstName);
  await expect(quantity(form, 2)).toHaveValue('60');
  await expect(form.getByRole('button', { name: 'Save meal & recipe', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(1);
  const firstPayload = writes[0].postDataJSON() as SavePayload;
  const committed = await catalog(http);
  expect(committed.meals.filter(meal => meal.name === name)).toHaveLength(1);
  expect(committed.ingredients).toHaveLength(before.ingredients.length + 2);
  const retried = await save(page, 200);
  expect(retried.payload).toEqual(firstPayload);
  expect(retried.saved).toEqual(firstSaved);
  await expect(form).toHaveCount(0);
  expect(writes).toHaveLength(2); expect(calls).toBe(2);
  expect(writes.every(request => new URL(request.url()).pathname === '/api/meals/with-recipe')).toBe(true);
  const after = await catalog(http);
  expect(after).toEqual(committed);
  expect(after.meals.filter(meal => meal.id !== retried.saved.meal.id)).toEqual(before.meals);
  expect(after.ingredients.filter(ingredient => ingredient.name === firstName)).toEqual([retried.saved.ingredients[0]]);
  expect(after.ingredients.filter(ingredient => ingredient.name === secondName)).toEqual([retried.saved.ingredients[1]]);
  expect(await data<RecipeRow[]>(http, `/meals/${retried.saved.meal.id}/ingredients`)).toEqual(retried.saved.recipe);
});

test('320px picker has named touch controls and protects the draft during route navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const http = await authenticatedApi(page), before = await catalog(http), writes = catalogWrites(page);
  await openIdeas(page);
  const region = page.getByRole('region', { name: 'Meal ideas', exact: true });
  await expect(page.getByRole('button', { name: 'Browse meal ideas', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expectFits(page, region);
  await page.getByRole('searchbox', { name: 'Search meal ideas', exact: true }).fill('oatmeal');
  const choice = page.getByRole('button', { name: 'Choose Oatmeal with banana', exact: true });
  await choice.focus(); await page.keyboard.press('Enter');
  const form = draftForm(page), name = 'SyntheticLongMealNameWithoutSpacesForSmallPhone' + unique();
  await expect(form.getByLabel('Meal name', { exact: true })).toBeFocused();
  await form.getByLabel('Meal name', { exact: true }).fill(name);
  await quantity(form, 1).fill('41');
  await form.getByRole('button', { name: 'Add ingredient', exact: true }).click();
  await newIngredient(form, 4, 'SyntheticLongIngredientNameWithoutSpacesForSmallPhone' + unique(), 'g', '12');
  await expectFits(page, form);
  const home = page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('link', { name: 'Home', exact: true });
  await home.click();
  const dialog = page.getByRole('dialog', { name: 'Leave your unsaved work?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
  await expectFits(page, dialog);
  for (let count = 0; count < 5; count++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL(/\/meals$/);
  await expect(form.getByLabel('Meal name', { exact: true })).toHaveValue(name);
  await expect(quantity(form, 1)).toHaveValue('41');
  await expect(quantity(form, 4)).toHaveValue('12');
  await expect(page.getByRole('button', { name: 'Planner', exact: true })).toBeDisabled();
  expect(await catalog(http)).toEqual(before); expect(writes).toHaveLength(0);
  await home.click();
  await dialog.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('navigation', { name: 'Mobile navigation', exact: true }).getByRole('link', { name: 'Meals', exact: true }).click();
  await page.getByRole('button', { name: 'Meal Setup', exact: true }).click();
  await expect(draftForm(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Planner', exact: true })).toBeEnabled();
  expect(await catalog(http)).toEqual(before); expect(writes).toHaveLength(0);
});
