const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const A = '/api/menu/plans/2026-10-05';
const B = '/api/menu/plans/2026-10-12';
let meal, eggs, link, draft;
async function api(method, path, body, status = 200) {
  const response = await request(app)[method](path).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status < 400 ? undefined : expect.anything() });
  return status < 400 ? response.body.data : response.body.error;
}
const preview = (path = A, changes = {}) => api('post', `${path}/preview`, { ...draft, ...changes });
const save = (plan) => api('put', A, { previewToken: plan.previewToken });
beforeEach(async () => {
  meal = await api('post', '/api/meals', { name: 'Egg breakfast', type: 'breakfast' }, 201);
  eggs = await api('post', '/api/ingredients', { name: 'Eggs', unit: 'count', shelfLifeDays: 0 }, 201);
  link = await api('post', `/api/meals/${meal.id}/ingredients`, { ingredientId: eggs.id, quantity: 1 }, 201);
  draft = { version: 0, childrenCount: 4, staffCount: 1, inHouse: { [eggs.id]: 2 },
    week: ['Monday', 'Tuesday', 'Wednesday'].map((day) => ({ day, menu: { breakfast: meal } })) };
});

test('edits catalog fields and filters archived records without deleting references', async () => {
  expect(eggs.shelfLifeDays).toBe(0);
  const renamed = await api('put', `/api/meals/${meal.id}`, { name: '  Egg lunch  ', type: 'lunch', description: 'With toast' });
  expect(renamed).toMatchObject({ id: meal.id, name: 'Egg lunch', type: 'lunch', description: 'With toast' });
  expect(await api('get', '/api/meals?type=breakfast')).toEqual([]);
  expect(await api('get', '/api/meals?type=lunch')).toEqual([renamed]);
  await api('delete', `/api/meals/${meal.id}`);
  expect(await api('get', '/api/meals')).toEqual([]);
  expect(await api('get', '/api/meals?includeArchived=true')).toEqual([expect.objectContaining({ id: meal.id, archived: true })]);
  expect(await db.listMealIngredients(meal.id)).toHaveLength(1);
  await api('put', `/api/meals/${meal.id}`, { archived: false });
  expect(await api('get', '/api/meals')).toHaveLength(1);
  await api('put', `/api/ingredients/${eggs.id}`, { name: 'Whole eggs' });
  await api('delete', `/api/ingredients/${eggs.id}`);
  expect(await api('get', '/api/ingredients')).toEqual([]);
  expect(await api('get', '/api/ingredients?includeArchived=true')).toEqual([expect.objectContaining({ name: 'Whole eggs', archived: true })]);
  await api('put', '/api/meals/missing', { name: 'Missing' }, 404);
  await api('delete', '/api/ingredients/missing', undefined, 404);
});

test('rejects duplicate ingredient assignments including simultaneous requests', async () => {
  const other = await api('post', '/api/ingredients', { name: 'Milk', unit: 'ml' }, 201);
  const body = { ingredientId: other.id, quantity: 25 };
  const responses = await Promise.all([1, 2].map(() => request(app).post(`/api/meals/${meal.id}/ingredients`).send(body)));
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(responses.find((r) => r.status === 409).body.error.fields.ingredientId).toMatch(/existing quantity/);
  expect(await db.listMealIngredients(meal.id)).toHaveLength(2);
  expect((await preview()).items.find((item) => item.ingredient.id === other.id).quantity).toBe(375);
});

test('new drafts pick up recipe corrections and cannot finalize after the last link is removed', async () => {
  expect((await preview()).items[0].quantity).toBe(15);
  await api('put', `/api/meals/ingredients/${link.id}`, { quantity: 1.5 });
  expect((await preview()).items[0]).toMatchObject({ quantity: 22.5, toBuy: 20.5 });
  await api('delete', `/api/meals/ingredients/${link.id}`);
  const incomplete = await preview();
  expect(incomplete.previewToken).toBeUndefined();
  expect(incomplete.warnings).toHaveLength(3);
  expect(incomplete.warnings[0]).toMatchObject({ mealId: meal.id, mealName: meal.name, day: 'Monday', slot: 'breakfast' });
  await api('put', A, { previewToken: incomplete.previewToken }, 409);
  expect(await api('get', A)).toBeNull();
  await api('delete', `/api/meals/ingredients/${link.id}`, undefined, 404);
});

test('saved weeks retain historical recipes; current corrections are an explicit preview and save', async () => {
  const saved = await save(await preview());
  await api('put', `/api/meals/${meal.id}`, { name: 'Renamed breakfast' });
  await api('put', `/api/ingredients/${eggs.id}`, { name: 'Whole eggs' });
  await api('put', `/api/meals/ingredients/${link.id}`, { quantity: 2 });
  const historic = await preview(A, { version: 1 });
  expect(historic.week[0].menu.breakfast.name).toBe('Egg breakfast');
  expect(historic.items[0]).toMatchObject({ ingredient: { name: 'Eggs' }, quantity: 15 });
  const corrected = await preview(A, { version: 1, refreshRecipes: true });
  expect(corrected.week[0].menu.breakfast.name).toBe('Renamed breakfast');
  expect(corrected.items[0]).toMatchObject({ ingredient: { name: 'Whole eggs' }, quantity: 30, inStorage: 2, toBuy: 28 });
  expect(await api('get', A)).toEqual(saved);
  expect((await save(corrected)).items[0].quantity).toBe(30);
});

test('archiving referenced meals and ingredients preserves saved weeks and flags new drafts', async () => {
  const saved = await save(await preview());
  await api('put', `/api/meals/${meal.id}`, { archived: true });
  await api('put', `/api/ingredients/${eggs.id}`, { archived: true });
  expect(await api('get', A)).toEqual(saved);
  expect((await preview(A, { version: 1 })).previewToken).toBeDefined();
  const current = await preview(B);
  expect(current.previewToken).toBeUndefined();
  expect(current.warnings.map((value) => value.message).join(' ')).toMatch(/archived/);
  await api('post', `/api/meals/${meal.id}/ingredients`, { ingredientId: eggs.id, quantity: 1 }, 409);
  await api('put', `/api/meals/${meal.id}`, { archived: false });
  await api('delete', `/api/meals/ingredients/${link.id}`);
  expect((await api('post', `/api/meals/${meal.id}/ingredients`, { ingredientId: eggs.id, quantity: 1 }, 400)).fields.ingredientId).toBeDefined();
  await api('put', `/api/ingredients/${eggs.id}`, { archived: false });
  await api('post', `/api/meals/${meal.id}/ingredients`, { ingredientId: eggs.id, quantity: 1 }, 201);
  expect((await preview(B)).previewToken).toBeDefined();
});

test('unit changes are blocked by recipe, saved-week and legacy stock quantities', async () => {
  const changeUnit = () => api('put', `/api/ingredients/${eggs.id}`, { unit: 'g' }, 409);
  expect((await changeUnit()).fields.unit).toMatch(/recipe or stock/);
  await save(await preview());
  await api('delete', `/api/meals/ingredients/${link.id}`);
  await changeUnit();
  expect((await db.getIngredientById(eggs.id)).unit).toBe('count');
  const unused = await api('post', '/api/ingredients', { name: 'Flour', unit: 'g' }, 201);
  expect(await api('put', `/api/ingredients/${unused.id}`, { unit: 'lb' })).toMatchObject({ unit: 'lb' });
  await db.saveShelfCheck([{ ingredientId: unused.id, quantity: 2 }]);
  expect((await api('put', `/api/ingredients/${unused.id}`, { unit: 'g' }, 409)).fields.unit).toBeDefined();
});

test('invalid catalog names and types return field errors and preserve prior values', async () => {
  for (const name of ['', '   ', null, 'x'.repeat(256)]) {
    expect((await api('put', `/api/meals/${meal.id}`, { name }, 400)).fields.name).toBeDefined();
    expect((await api('put', `/api/ingredients/${eggs.id}`, { name }, 400)).fields.name).toBeDefined();
  }
  expect((await api('post', '/api/meals', { name: 'Dinner', type: 'dinner' }, 400)).fields.type).toBeDefined();
  expect((await api('put', `/api/meals/${meal.id}`, { archived: 'yes' }, 400)).fields.archived).toBeDefined();
  expect((await api('post', '/api/ingredients', { name: 'Unknown', unit: 'unknown' }, 400)).fields.unit).toBeDefined();
  expect((await db.getMealById(meal.id)).name).toBe(meal.name);
});

test.each([0, -1, null, '', '2', true, 0.0000001, 1e12])('rejects invalid recipe quantity %p with a field error', async (quantity) => {
  expect((await api('put', `/api/meals/ingredients/${link.id}`, { quantity }, 400)).fields.quantity).toBeDefined();
  expect((await api('post', `/api/meals/${meal.id}/ingredients`, { ingredientId: eggs.id, quantity }, 400)).fields.quantity).toBeDefined();
  expect((await db.getMealIngredientById(link.id)).quantity).toBe(1);
});
