const { randomUUID } = require('node:crypto');
const rawRequest = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const { addRecipeIngredient } = require('./helpers/recipeMeal');

const TYPES = ['breakfast', 'snack', 'lunch', 'afternoonSnack'];
const LABELS = ['Breakfast', 'Morning snack', 'Lunch', 'Afternoon snack'];
const PLAN = '/api/menu/plans/2026-10-19';

async function completeCatalog(except = null) {
  const meals = {};
  for (const type of TYPES.filter((value) => value !== except)) {
    const meal = await db.createMeal({ name: `Synthetic ${type}`, type });
    const { ingredient, link } = await addRecipeIngredient(meal, `${type} food`, 'g', type === 'breakfast' ? 0.5 : 1);
    meals[type] = { meal, ingredient, link };
  }
  return meals;
}

async function generate(status = 200) {
  const response = await request(app).get('/api/menu/generate');
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status < 400 ? undefined : expect.anything() });
  expect(response.headers['cache-control']).toBe('no-store');
  return response.body;
}

test('an empty catalog returns named setup guidance rather than a server failure or an empty menu', async () => {
  const result = await generate(422);
  expect(result.error).toMatchObject({ code: 'MENU_SETUP_REQUIRED', message: expect.stringContaining('Meal Setup') });
  expect(result.error.details.missingTypes.map((item) => item.label)).toEqual(LABELS);
  for (const item of result.error.details.missingTypes) {
    expect(item.message).toContain(`Add an active ${item.label} meal`);
    expect(result.error.fields[item.type]).toBe(item.message);
  }
  expect(result.error.details.excludedMeals).toEqual([]);
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
  expect(await db.getConfirmedMenu()).toBeNull();
});

test.each(TYPES)('a missing %s period identifies just that period and leaves other complete choices intact', async (type) => {
  const meals = await completeCatalog(type);
  const before = await db.listMeals();
  const result = await generate(422);
  expect(result.error.details.missingTypes).toEqual([{ type, label: LABELS[TYPES.indexOf(type)], message: expect.stringContaining('Add an active') }]);
  expect(await db.listMeals()).toEqual(before);
  expect(Object.keys(meals)).toHaveLength(3);
});

test.each(TYPES)('an archived-only %s period offers restore or add guidance', async (type) => {
  const meals = await completeCatalog();
  await db.updateMeal(meals[type].meal.id, { archived: true });
  const result = await generate(422);
  expect(result.error.details.missingTypes).toEqual([{ type, label: LABELS[TYPES.indexOf(type)], message: expect.stringContaining('are archived') }]);
  expect(result.error.details.excludedMeals).toEqual([{ mealId: meals[type].meal.id, mealName: meals[type].meal.name,
    type, reasons: [expect.stringContaining('archived')] }]);
});

test.each([
  ['empty recipe', async (meal) => ({ meal }), 'Add recipe ingredients'],
  ['archived ingredient', async (meal) => {
    const { ingredient } = await addRecipeIngredient(meal);
    await db.updateIngredient(ingredient.id, { archived: true });
  }, 'is archived'],
  ['zero quantity', async (meal) => addRecipeIngredient(meal, 'Zero quantity food', 'g', 0), 'quantity per person'],
  ['unsupported ingredient unit', async (meal) => addRecipeIngredient(meal, 'Unsupported unit food', 'cups', 1), 'unsupported unit'],
])('an incomplete breakfast with %s cannot create a draft that fails the dated preview', async (_, setup, reason) => {
  await completeCatalog('breakfast');
  const meal = await db.createMeal({ name: 'Breakfast needing repair', type: 'breakfast' });
  await setup(meal);
  const result = await generate(422);
  expect(result.error.details.missingTypes[0]).toMatchObject({ type: 'breakfast', message: expect.stringContaining('complete recipe') });
  expect(result.error.details.excludedMeals[0]).toMatchObject({ mealId: meal.id, mealName: meal.name,
    reasons: expect.arrayContaining([expect.stringContaining(reason)]) });
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
});

test('a missing ingredient in a legacy recipe is reported without a 500', async () => {
  const meals = await completeCatalog();
  const original = db.listIngredients;
  const missing = jest.spyOn(db, 'listIngredients').mockImplementation(async (options) =>
    (await original(options)).filter((ingredient) => ingredient.id !== meals.breakfast.ingredient.id));
  try {
    const result = await generate(422);
    expect(result.error.details.excludedMeals[0].reasons).toContain('Replace or remove a missing recipe ingredient.');
  } finally { missing.mockRestore(); }
});

test('complete alternates are selected before incomplete recipes and archived meals', async () => {
  const invalid = await db.createMeal({ name: 'Unfinished breakfast', type: 'breakfast' });
  const archived = await db.createMeal({ name: 'Old breakfast', type: 'breakfast', archived: true });
  await addRecipeIngredient(archived);
  const meals = await completeCatalog();
  const result = await generate();
  expect(result.data.week).toHaveLength(5);
  for (const day of result.data.week) for (const type of TYPES) expect(day.menu[type]).toEqual({
    id: meals[type].meal.id, name: meals[type].meal.name, type,
  });
  expect(result.data.setupWarnings).toEqual([{ mealId: invalid.id, mealName: invalid.name, type: 'breakfast', reasons: [expect.stringContaining('Add recipe ingredients')] }]);
  expect(JSON.stringify(result.data.week)).not.toContain(archived.id);
});

test('generation, dated preview and reviewed save preserve headcounts, stock and historical recipe quantities', async () => {
  const meals = await completeCatalog();
  const stockResponse = await request(app).post('/api/inventory').send({ name: 'Synthetic breakfast stock', category: 'Food',
    location: 'Kitchen / Shelf 1', ingredientId: meals.breakfast.ingredient.id, unit: 'g', openingQuantity: '2',
    reorderThreshold: '4', reason: 'Synthetic opening count', requestId: randomUUID() });
  expect(stockResponse.status).toBe(201);
  const stock = stockResponse.body.data;
  const stockBefore = await db.getInventoryById(stock.id);
  const movementsBefore = await db.listInventoryMovements(stock.id);
  const result = await generate();
  expect(result.data.setupWarnings).toBeUndefined();
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
  const draft = { week: result.data.week, childrenCount: 4, staffCount: 1, version: 0,
    dailyChildrenCounts: { '2026-10-20': 2 } };
  const preview = await request(app).post(PLAN + '/preview').send(draft);
  expect(preview.status).toBe(200);
  expect(preview.body.data).toMatchObject({ childrenCount: 4, staffCount: 1, dailyChildrenCounts: draft.dailyChildrenCounts,
    warnings: [], previewToken: expect.any(String) });
  expect(preview.body.data.items.find((item) => item.ingredient.id === meals.breakfast.ingredient.id))
    .toMatchObject({ quantity: 11.5, inStorage: 2, toBuy: 9.5 });
  // Other ingredients have no inventory yet: shortages still produce valid plans.
  expect(preview.body.data.items.find((item) => item.ingredient.id === meals.lunch.ingredient.id))
    .toMatchObject({ quantity: 23, inStorage: 0, toBuy: 23 });
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
  await db.updateMealIngredient(meals.breakfast.link.id, { quantity: 2 });
  const savedResponse = await request(app).put(PLAN).send({ previewToken: preview.body.data.previewToken });
  expect(savedResponse.status).toBe(200);
  const saved = savedResponse.body.data;
  expect(saved.recipes.Monday.breakfast.ingredients[0].quantityPerPerson).toBe(0.5);
  expect(saved.version).toBe(1);
  expect((await request(app).get(PLAN)).body.data).toEqual(saved);
  await db.updateMeal(meals.breakfast.meal.id, { archived: true });
  await generate(422);
  expect((await request(app).get(PLAN)).body.data).toEqual(saved);
  expect(await db.getConfirmedMenu()).toBeNull();
  expect(await db.getInventoryById(stock.id)).toEqual(stockBefore);
  expect(await db.listInventoryMovements(stock.id)).toEqual(movementsBefore);
});

test('generation remains protected by sign-in and read-only for viewer accounts', async () => {
  const anonymous = await rawRequest(app).get('/api/menu/generate').set('Origin', request.origin);
  expect(anonymous.status).toBe(401);
  await completeCatalog();
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  await generate();
  const attempt = await request(app).put(PLAN).send({ previewToken: 'invented' });
  expect(attempt.status).toBe(403);
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
});

test('an incompatible inventory link is a separate preview error and can be repaired without regenerating the menu', async () => {
  const meals = await completeCatalog();
  const response = await request(app).post('/api/inventory').send({ name: 'Synthetic linked food', category: 'Food',
    location: 'Kitchen / Shelf 1', ingredientId: meals.breakfast.ingredient.id, unit: 'g', openingQuantity: '2',
    reorderThreshold: '0', reason: 'Synthetic opening count', requestId: randomUUID() });
  expect(response.status).toBe(201);
  const item = response.body.data;
  // Simulate inconsistent legacy stock, which normal inventory edits reject.
  await db.updateInventory(item.id, { unit: 'count' });
  const generated = await generate();
  const draft = { week: generated.data.week, childrenCount: 4, staffCount: 1, version: 0 };
  const failed = await request(app).post(PLAN + '/preview').send(draft);
  expect(failed.status).toBe(409);
  expect(failed.body.error.message).toContain('inventory');
  expect(failed.body.error.code).not.toBe('MENU_SETUP_REQUIRED');
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
  await db.updateInventory(item.id, { unit: 'g' });
  const retried = await request(app).post(PLAN + '/preview').send(draft);
  expect(retried.status).toBe(200);
  expect(retried.body.data.previewToken).toEqual(expect.any(String));
  expect(await db.getWeeklyPlan('2026-10-19')).toBeNull();
});

test('unexpected storage failures remain a sanitized server error, not catalog guidance', async () => {
  const failure = jest.spyOn(db, 'listMeals').mockRejectedValueOnce(new Error('Synthetic private SQL detail'));
  try {
    const result = await generate(500);
    expect(result).toEqual({ error: { message: 'Internal server error.' } });
  } finally { failure.mockRestore(); }
});
