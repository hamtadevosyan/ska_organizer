const request = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');
const A = '/api/menu/plans/2026-09-07';
const B = '/api/menu/plans/2026-09-14';
let meal, eggs, link, draft;
async function api(method, path, body, status = 200) {
  const response = await request(app)[method](path).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status < 400 ? undefined : expect.anything() });
  return response.body.data;
}
const preview = (path = A, changes = {}) => api('post', `${path}/preview`, { ...draft, ...changes });
const save = (path, plan) => api('put', path, { previewToken: plan.previewToken });
beforeEach(async () => {
  meal = await db.createMeal({ name: 'Egg breakfast', type: 'breakfast' });
  eggs = await db.createIngredient({ name: 'Eggs', unit: 'count' });
  link = await db.addMealIngredient({ mealId: meal.id, ingredientId: eggs.id, quantity: 1 });
  draft = { version: 0, childrenCount: 4, staffCount: 1, inHouse: { [eggs.id]: 2 },
    week: ['Monday', 'Tuesday', 'Wednesday'].map((day) => ({ day, menu: { breakfast: meal } })) };
});

test('reopens two independent weeks with 15 needed, 2 in house and 13 to buy', async () => {
  expect(await api('get', A)).toBeNull();
  const first = await save(A, await preview());
  const second = await save(B, await preview(B, { childrenCount: 1, staffCount: 1, inHouse: {} }));
  expect(await api('get', A)).toEqual(first);
  expect(await api('get', B)).toEqual(second);
  expect(first).toMatchObject({ childrenCount: 4, staffCount: 1, version: 1, inHouse: { [eggs.id]: 2 } });
  for (const path of [`${A}/shopping`, '/api/shelf/final?weekStart=2026-09-07']) {
    expect(await api('get', path)).toMatchObject({ meta: { childrenCount: 4, staffCount: 1, totalPeople: 5 },
      items: [{ quantity: 15, inStorage: 2, toBuy: 13 }] });
  }
  expect(second.items[0]).toMatchObject({ quantity: 6, inStorage: 0, toBuy: 6 });
  // Changing a detached read must not mutate storage, including in mock mode.
  const detached = await db.getWeeklyPlan('2026-09-07');
  detached.week[0].menu.breakfast.name = 'Unsaved';
  expect(await api('get', A)).toEqual(first);
});

test('draft changes are read-only and existing slots retain recipe history after edits or deletion', async () => {
  const calculated = await preview();
  await db.updateMealIngredient(link.id, { quantity: 10 });
  // Save exactly the quantities that were reviewed before the recipe edit.
  const saved = await save(A, calculated);
  expect(saved.items[0].quantity).toBe(15);
  await db.deleteMeal(meal.id);
  await db.updateIngredient(eggs.id, { name: 'Renamed eggs', unit: 'g' });
  const edited = await preview(A, { version: 1, childrenCount: 5 });
  expect(edited.items[0]).toMatchObject({ ingredient: { name: 'Eggs', unit: 'count' }, quantity: 18, toBuy: 16 });
  expect(await api('get', A)).toEqual(saved);
  expect((await api('get', `${A}/shopping`)).items[0].quantity).toBe(15);
  const replacement = await db.createMeal({ name: 'New breakfast', type: 'breakfast' });
  await db.addMealIngredient({ mealId: replacement.id, ingredientId: eggs.id, quantity: 2 });
  const newWeek = draft.week.map((day) => ({ ...day, menu: { breakfast: replacement } }));
  const newPreview = await preview(B, { week: newWeek });
  expect(newPreview.items[0]).toMatchObject({ ingredient: { unit: 'g' }, quantity: 30 });
});

test('a rejected save leaves every field of the prior version intact', async () => {
  const saved = await save(A, await preview());
  const editing = await preview(A, { version: 1, childrenCount: 6, inHouse: { [eggs.id]: 8 } });
  const failure = jest.spyOn(db, 'saveWeeklyPlan').mockRejectedValueOnce(new Error('Storage unavailable'));
  await api('put', A, { previewToken: editing.previewToken }, 500);
  failure.mockRestore();
  expect(await api('get', A)).toEqual(saved);
  const retried = await save(A, editing);
  expect(retried).toMatchObject({ version: 2, childrenCount: 6, inHouse: { [eggs.id]: 8 },
    items: [{ quantity: 21, inStorage: 8, toBuy: 13 }] });
});

test('concurrent first saves cannot silently overwrite each other', async () => {
  const first = await preview();
  const second = await preview(A, { childrenCount: 6 });
  const responses = await Promise.all([first, second].map((plan) => request(app).put(A).send({ previewToken: plan.previewToken })));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await api('get', A)).toEqual(responses.find((r) => r.status === 200).body.data);
  await api('post', `${A}/preview`, draft, 409);
});

test.each([-1, 1.5, null, '4', 'Infinity', true, 9007199254740992])('rejects invalid headcount %p without saving', async (childrenCount) => {
  await api('post', `${A}/preview`, { ...draft, childrenCount }, 400);
  expect(await api('get', A)).toBeNull();
});
test('rejects zero total, invalid stock, malformed weeks and wrong meal types', async () => {
  const cases = [{ childrenCount: 0, staffCount: 0 }, { staffCount: 1.5 },
    { inHouse: { [eggs.id]: -1 } }, { inHouse: { [eggs.id]: null } }, { inHouse: [] },
    { week: [] }, { week: [draft.week[0], draft.week[0]] },
    { week: [{ day: 'Monday', menu: { lunch: meal } }] }];
  for (const changes of cases) await api('post', `${A}/preview`, { ...draft, ...changes }, 400);
  for (const date of ['2026-09-08', '2026-02-30', 'not-a-date']) await api('get', `/api/menu/plans/${date}`, undefined, 400);
  await api('get', `${A}/shopping`, undefined, 404);
});
test('rejects tampered, wrong-week and expired calculations', async () => {
  const plan = await preview();
  await api('put', A, { previewToken: `${plan.previewToken}x` }, 409);
  await api('put', B, { previewToken: plan.previewToken }, 400);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600001);
  await api('put', A, { previewToken: plan.previewToken }, 409);
  clock.mockRestore();
  expect(await api('get', A)).toBeNull();
});
test('imports the earlier undated menu into an explicit week without overwriting legacy data', async () => {
  await db.saveConfirmedMenu({ week: draft.week });
  await db.saveShelfCheck([{ ingredientId: eggs.id, quantity: 2 }]);
  const legacy = await db.getConfirmedMenu();
  const imported = await api('post', `${A}/import-preview`);
  expect(imported).toMatchObject({ childrenCount: 20, staffCount: 5, items: [{ quantity: 75, inStorage: 2, toBuy: 73 }] });
  expect(await api('get', A)).toBeNull();
  await save(A, imported);
  expect(await db.getConfirmedMenu()).toEqual(legacy);
});
