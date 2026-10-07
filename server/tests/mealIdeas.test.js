const { randomUUID } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const endpoint = '/api/meals/with-recipe';
const jsonValue = (value) => JSON.parse(JSON.stringify(value));
const byId = (rows) => jsonValue(rows).sort((a, b) => a.id.localeCompare(b.id));
const recipeRows = async (mealId) => byId(await db.listMealIngredients(mealId));
function sameSavedRecipe(actual, expected) {
  expect(jsonValue(actual.meal)).toEqual(jsonValue(expected.meal));
  expect(byId(actual.ingredients)).toEqual(byId(expected.ingredients));
  expect(byId(actual.recipe)).toEqual(byId(expected.recipe));
}
const body = (changes = {}) => ({ requestId: randomUUID(), meal: { name: 'Oat breakfast', type: 'breakfast', description: 'With fruit' },
  ingredients: [{ name: 'Oats', unit: 'g', quantity: 30 }, { name: 'Milk', unit: 'ml', quantity: 100 }], ...changes });
const submit = (payload) => request(app).post(endpoint).send(payload);
async function ingredient(name, unit = 'g', changes = {}) {
  const response = await request(app).post('/api/ingredients').send({ name, unit, ...changes });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function catalog() {
  return { meals: byId(await db.listMeals({ includeArchived: true })), ingredients: byId(await db.listIngredients({ includeArchived: true })) };
}
async function rejected(payload, field, status = 400) {
  const before = await catalog();
  const response = await submit(payload);
  expect(response.status).toBe(status);
  expect(response.body.error.fields[field]).toEqual(expect.any(String));
  expect(await catalog()).toEqual(before);
  return response;
}

test('creates a renamed meal and complete editable recipe, reusing canonical foods and retaining stock/history', async () => {
  const oats = await ingredient('Rolled Oats', 'g');
  const stock = await request(app).post('/api/inventory').send({ name: 'Breakfast oats', category: 'Food', location: 'Kitchen',
    ingredientId: oats.id, unit: 'g', openingQuantity: '90', reorderThreshold: '0', reason: 'Opening stock', requestId: randomUUID() });
  expect(stock.status).toBe(201);
  const stockBefore = jsonValue(await db.getInventoryById(stock.body.data.id));
  const historyBefore = byId(await db.listInventoryMovements(stock.body.data.id));
  const payload = body({ meal: { name: '  Happy oat bowls  ', type: 'breakfast', description: '  With fruit  ' },
    ingredients: [{ name: '  rolled   OATS ', unit: 'g', quantity: 25.5 }, { name: 'Bananas', unit: 'count', quantity: 0.5 }] });
  const response = await submit(payload);
  expect(response.status).toBe(201);
  const saved = response.body.data;
  expect(saved.meal).toMatchObject({ id: payload.requestId, name: 'Happy oat bowls', type: 'breakfast', description: 'With fruit', archived: false });
  expect(saved.ingredients).toEqual([expect.objectContaining({ id: oats.id, name: 'Rolled Oats', unit: 'g' }), expect.objectContaining({ name: 'Bananas', unit: 'count', shelfLifeDays: null })]);
  expect(saved.recipe).toEqual(saved.ingredients.map((food, index) => expect.objectContaining({ id: expect.any(String), mealId: saved.meal.id,
    ingredientId: food.id, quantity: payload.ingredients[index].quantity })));
  expect(await db.listIngredients()).toHaveLength(2);
  expect(jsonValue(await db.getInventoryById(stock.body.data.id))).toEqual(stockBefore);
  expect(byId(await db.listInventoryMovements(stock.body.data.id))).toEqual(historyBefore);
  const preview = await request(app).post('/api/menu/plans/2026-10-05/preview').send({ version: 0,
    week: [{ day: 'Monday', menu: { breakfast: saved.meal } }], childrenCount: 4, staffCount: 0 });
  expect(preview.status).toBe(200);
  expect(preview.body.data.items.find((item) => item.ingredient.id === oats.id)).toMatchObject({ quantity: 102, inStorage: 90, toBuy: 12 });
  const events = (await db.listAudit()).filter((event) => event.action === 'meal.create');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ entityId: saved.meal.id, actorId: request.credentials().account.id });
});

test('explicit ingredient selection uses its canonical name/unit and cannot silently rename or convert it', async () => {
  const oats = await ingredient('Rolled Oats', 'g');
  const valid = body({ ingredients: [{ ingredientId: oats.id, quantity: 12 }] });
  const response = await submit(valid);
  expect(response.status).toBe(201);
  expect(response.body.data.ingredients).toEqual([oats]);
  await rejected(body({ ingredients: [{ ingredientId: oats.id, name: 'Flour', quantity: 12 }] }), 'ingredients.0.name', 409);
  await rejected(body({ ingredients: [{ ingredientId: oats.id, unit: 'oz', quantity: 12 }] }), 'ingredients.0.unit', 409);
  await rejected(body({ ingredients: [{ ingredientId: 'missing', quantity: 12 }] }), 'ingredients.0.ingredientId', 409);
  await rejected(body({ ingredients: [{ ingredientId: null, name: 'New food', unit: 'g', quantity: 12 }] }), 'ingredients.0.ingredientId', 409);
  expect(jsonValue(await db.getIngredientById(oats.id))).toEqual(oats);
});

test('named foods reuse only one active exact name/unit match and require explicit choices for ambiguous or different units', async () => {
  const oats = await ingredient('Oats', 'g');
  await rejected(body({ ingredients: [{ name: 'OATS', unit: 'oz', quantity: 1 }] }), 'ingredients.0.unit', 409);
  const other = await ingredient('  oats ', 'g');
  await rejected(body({ ingredients: [{ name: 'Oats', unit: 'g', quantity: 1 }] }), 'ingredients.0.ingredientId', 409);
  const response = await submit(body({ ingredients: [{ ingredientId: other.id, quantity: 1 }] }));
  expect(response.status).toBe(201);
  expect(response.body.data.ingredients[0].id).toBe(other.id);
  expect(jsonValue(await db.getIngredientById(oats.id))).toEqual(oats);
});

test('archived-only name matches and explicit archived IDs are not restored or duplicated', async () => {
  const food = await ingredient('Peaches', 'g', { archived: true });
  await rejected(body({ ingredients: [{ name: 'peaches', unit: 'g', quantity: 30 }] }), 'ingredients.0.name', 409);
  await rejected(body({ ingredients: [{ name: 'peaches', unit: 'count', quantity: 1 }] }), 'ingredients.0.name', 409);
  await rejected(body({ ingredients: [{ ingredientId: food.id, quantity: 30 }] }), 'ingredients.0.ingredientId', 409);
  expect(await db.getIngredientById(food.id)).toMatchObject({ archived: true });
  const active = await ingredient('Peaches', 'g');
  const saved = await submit(body({ ingredients: [{ name: 'Peaches', unit: 'g', quantity: 30 }] }));
  expect(saved.status).toBe(201);
  expect(saved.body.data.ingredients[0].id).toBe(active.id);
});

test('duplicate resolved IDs and duplicate normalized names/units are rejected before creating any records', async () => {
  const oats = await ingredient('Oats', 'g');
  await rejected(body({ ingredients: [{ ingredientId: oats.id, quantity: 1 }, { name: 'Oats', unit: 'g', quantity: 2 }] }), 'ingredients.1.ingredientId', 409);
  await rejected(body({ ingredients: [{ name: 'Apple pieces', unit: 'g', quantity: 1 }, { name: '  APPLE   pieces ', unit: 'g', quantity: 2 }] }), 'ingredients.1.name', 409);
  const other = await ingredient('OATS', 'g');
  await rejected(body({ ingredients: [{ ingredientId: oats.id, quantity: 1 }, { ingredientId: other.id, quantity: 2 }] }), 'ingredients.1.name', 409);
});

test.each([0, -1, null, '', '2', true, 0.0000001, 1e12])('invalid ingredient quantity %p is rejected with its row field before any writes', async (quantity) => {
  await rejected(body({ ingredients: [{ name: 'New rice', unit: 'g', quantity: 1 }, { name: 'New milk', unit: 'ml', quantity }] }), 'ingredients.1.quantity');
});

test('empty, malformed, excessive and unsupported recipe fields return precise errors without writes', async () => {
  for (const ingredients of [undefined, null, [], {}, Array.from({ length: 51 }, (_, i) => ({ name: `Food ${i}`, unit: 'g', quantity: 1 }))]) {
    await rejected(body({ ingredients }), 'ingredients');
  }
  await rejected(body({ ingredients: [null] }), 'ingredients.0.name');
  await rejected(body({ ingredients: [{ quantity: 1 }] }), 'ingredients.0.name');
  await rejected(body({ ingredients: [{ name: 'Rice', unit: 'pack', quantity: 1 }] }), 'ingredients.0.unit');
  await rejected(body({ ingredients: [{ name: 'Rice', unit: 'g', quantity: 1, archived: true }] }), 'ingredients.0.name');
  await rejected(body({ meal: { name: 'Rice', type: 'dinner' } }), 'meal.type');
  await rejected(body({ meal: { name: '', type: 'lunch' } }), 'meal.name');
  await rejected(body({ meal: { name: 'Rice', type: 'lunch', archived: true } }), 'meal.name');
  await rejected(body({ meal: null }), 'meal.name');
  await rejected(body({ requestId: 'not-a-uuid' }), 'requestId');
  await rejected(body({ id: randomUUID() }), 'requestId');
});

test('same UUID retries return the same complete IDs and support normalized UUID casing and row order', async () => {
  const payload = body();
  const created = await submit(payload);
  expect(created.status).toBe(201);
  const before = await catalog();
  const retried = await submit({ ...payload, requestId: payload.requestId.toUpperCase(), ingredients: [...payload.ingredients].reverse() });
  expect(retried.status).toBe(200);
  sameSavedRecipe(retried.body.data, created.body.data);
  expect(await catalog()).toEqual(before);
  expect(await recipeRows(payload.requestId)).toEqual(byId(created.body.data.recipe));
});

test('an unchanged named-food retry retains its original link even if a duplicate catalog name was added later', async () => {
  const payload = body({ ingredients: [{ name: 'Oats', unit: 'g', quantity: 30 }] });
  const created = await submit(payload);
  expect(created.status).toBe(201);
  await ingredient('OATS', 'g');
  const retried = await submit(payload);
  expect(retried.status).toBe(200);
  sameSavedRecipe(retried.body.data, created.body.data);
  expect(await db.listIngredients()).toHaveLength(2);
});

test('reusing a UUID for changed meal or recipe details conflicts and never overwrites a saved record', async () => {
  const payload = body();
  const first = await submit(payload);
  expect(first.status).toBe(201);
  for (const changed of [
    { ...payload, meal: { ...payload.meal, name: 'Other name' } },
    { ...payload, meal: { ...payload.meal, type: 'lunch' } },
    { ...payload, meal: { ...payload.meal, description: 'Other description' } },
    { ...payload, ingredients: [{ ...payload.ingredients[0], quantity: 31 }, payload.ingredients[1]] },
    { ...payload, ingredients: payload.ingredients.slice(0, 1) },
    { ...payload, ingredients: [...payload.ingredients, { name: 'Rice', unit: 'g', quantity: 20 }] },
  ]) await rejected(changed, 'requestId', 409);
  expect(await recipeRows(payload.requestId)).toEqual(byId(first.body.data.recipe));
});

test.each(['name', 'recipe', 'meal archive', 'ingredient archive', 'ingredient rename'])('a retry after %s changes conflicts without rebuilding or overwriting anything', async (change) => {
  const payload = body();
  const saved = (await submit(payload)).body.data;
  if (change === 'name') await db.updateMeal(saved.meal.id, { name: 'Changed later' });
  if (change === 'recipe') await db.updateMealIngredient(saved.recipe[0].id, { quantity: 40 });
  if (change === 'meal archive') await db.updateMeal(saved.meal.id, { archived: true });
  if (change === 'ingredient archive') await db.updateIngredient(saved.ingredients[0].id, { archived: true });
  if (change === 'ingredient rename') await db.updateIngredient(saved.ingredients[0].id, { name: 'Renamed later' });
  const before = await catalog();
  const recipeBefore = await recipeRows(saved.meal.id);
  expect((await submit(payload)).status).toBe(409);
  expect(await catalog()).toEqual(before);
  expect(await recipeRows(saved.meal.id)).toEqual(recipeBefore);
});

test('simultaneous retries commit only one meal, ingredients and recipe', async () => {
  const payload = body();
  const responses = await Promise.all([submit(payload), submit(payload)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
  sameSavedRecipe(responses[0].body.data, responses[1].body.data);
  expect(await db.listMeals()).toHaveLength(1);
  expect(await db.listIngredients()).toHaveLength(2);
  expect(await db.listMealIngredients(payload.requestId)).toHaveLength(2);
});

test('simultaneous new meals reuse the same newly created named foods instead of splitting inventory IDs', async () => {
  const payloads = [body(), body({ meal: { name: 'Second oat bowl', type: 'breakfast' } })];
  const responses = await Promise.all(payloads.map(submit));
  expect(responses.map((response) => response.status)).toEqual([201, 201]);
  expect(responses[0].body.data.ingredients.map((food) => food.id).sort()).toEqual(responses[1].body.data.ingredients.map((food) => food.id).sort());
  expect(await db.listMeals()).toHaveLength(2);
  expect(await db.listIngredients()).toHaveLength(2);
  for (const payload of payloads) expect(await db.listMealIngredients(payload.requestId)).toHaveLength(2);
});

test.each(['recipe', 'audit'])('%s failure rolls back the whole meal and missing ingredients, and a retry can succeed', async (failure) => {
  const payload = body();
  const before = await catalog();
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  let spy;
  if (failure === 'recipe') {
    const original = db.addMealIngredient;
    let count = 0;
    spy = jest.spyOn(db, 'addMealIngredient').mockImplementation((values) => ++count === 2 ? Promise.reject(new Error('Synthetic final-link failure')) : original(values));
  } else spy = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  try {
    expect((await submit(payload)).status).toBe(500);
    expect(await catalog()).toEqual(before);
    expect(await db.listMealIngredients(payload.requestId)).toEqual([]);
    expect((await db.listAudit()).filter((event) => event.action === 'meal.create')).toEqual([]);
  } finally { spy.mockRestore(); log.mockRestore(); }
  expect((await submit(payload)).status).toBe(201);
});

test('creating a new recipe preserves an already saved weekly menu and all its historical ingredient snapshots', async () => {
  const first = (await submit(body())).body.data;
  const path = '/api/menu/plans/2026-10-05';
  const preview = await request(app).post(`${path}/preview`).send({ version: 0, childrenCount: 4, staffCount: 1,
    week: ['Monday', 'Tuesday', 'Wednesday'].map((day) => ({ day, menu: { breakfast: first.meal } })) });
  expect(preview.status).toBe(200);
  expect(preview.body.data.previewToken).toEqual(expect.any(String));
  const saved = await request(app).put(path).send({ previewToken: preview.body.data.previewToken });
  expect(saved.status).toBe(200);
  const other = await submit(body({ meal: { name: 'Custom oat lunch', type: 'lunch' }, ingredients: [{ ingredientId: first.ingredients[0].id, quantity: 50 }] }));
  expect(other.status).toBe(201);
  expect(other.body.data.meal.id).not.toBe(first.meal.id);
  expect((await request(app).get(path)).body.data).toEqual(saved.body.data);
  expect(await recipeRows(first.meal.id)).toEqual(byId(first.recipe));
});

test('the complete-recipe endpoint preserves authentication, CSRF, origin and viewer/editor permissions', async () => {
  const payload = body();
  expect((await anonymous(app).post(endpoint).set('Origin', request.origin).send(payload)).status).toBe(401);
  const credentials = request.credentials();
  expect((await anonymous(app).post(endpoint).set('Origin', request.origin).set('Cookie', credentials.cookie).send(payload)).status).toBe(403);
  expect((await anonymous(app).post(endpoint).set('Origin', 'https://untrusted.example').set('Cookie', credentials.cookie).set('X-CSRF-Token', credentials.csrf).send(payload)).status).toBe(403);
  await db.updateAccount(credentials.account.id, { role: 'viewer' });
  expect((await request(app).get('/api/meals')).status).toBe(200);
  expect((await submit(payload)).status).toBe(403);
  expect(await db.listMeals()).toEqual([]);
  await db.updateAccount(credentials.account.id, { role: 'editor' });
  expect((await submit(payload)).status).toBe(201);
  expect((await submit(payload)).status).toBe(200);
});
