const { randomUUID } = require('node:crypto');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const { amount } = require('../services/inventoryValidation');

const weekStart = '2026-10-12';
const purchasingPath = '/api/purchasing/' + weekStart;
async function api(method, path, body, expected = 200) {
  const response = await request(app)[method](path).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status: expected,
    error: expected >= 400 ? expect.anything() : undefined });
  return response.body.data;
}
async function stock(changes = {}) {
  return api('post', '/api/inventory', { name: 'Synthetic paper', category: 'Synthetic supplies',
    location: 'Art shelf', unit: 'count', openingQuantity: '3', reorderThreshold: '5',
    ingredientId: null, reason: 'Synthetic opening count', requestId: randomUUID(), ...changes }, 201);
}
async function makeInactive(item, state = 'item') {
  const now = new Date().toISOString();
  if (state === 'item') await db.updateInventory(item.id, { archived: true, archivedAt: now, version: item.version + 1 });
  else {
    const group = await db.getInventoryGroupById(item.groupId);
    await db.updateInventoryGroup(group.id, { archived: true, archivedAt: now, version: group.version + 1 });
  }
}
const choices = (list, selected) => list.lines.map((line) => ({ id: line.id, buyQuantity: line.buyQuantity,
  selected: selected ?? line.selected, checked: false }));
const source = (item) => ({ includeMeals: false, roomIds: [], lowStockTargets: [{ itemId: item.id, targetQuantity: '10' }] });
async function mealFixture() {
  const ingredient = await db.createIngredient({ name: 'Synthetic flour', unit: 'g' });
  const meal = await db.createMeal({ name: 'Synthetic breakfast', type: 'breakfast' });
  await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity: 2 });
  const item = await stock({ name: 'Synthetic flour stock', category: 'Synthetic food', unit: 'g', ingredientId: ingredient.id });
  return { ingredient, meal, item, input: { childrenCount: 4, staffCount: 1, version: 0,
    week: [{ day: 'Monday', menu: { breakfast: { id: meal.id } } }] } };
}
async function activityFixture(item) {
  const room = await api('post', '/api/rooms', { name: 'Synthetic activity room', ageMinMonths: 24, ageMaxMonths: 60, capacity: 12 }, 201);
  const activity = await api('post', '/api/activity', { name: 'Synthetic paper activity', description: 'Use paper.', durationMinutes: 20,
    ageMinMonths: 18, ageMaxMonths: 72, materials: [{ itemId: item.id, quantity: '7', unit: item.unit, reusable: false }] }, 201);
  const entry = { id: randomUUID(), date: weekStart, startTime: '09:00', endTime: '09:20', activityId: activity.id };
  const plan = await api('post', '/api/schedule/plan', { roomId: room.id, weekStart, version: 0, entries: [entry], requestId: randomUUID() });
  return { room, activity, entry, plan };
}

test.each(['item', 'parent'])('new dated meal stock excludes archived %s while saved shopping and manual shelf values stay unchanged', async (state) => {
  const { ingredient, item, input } = await mealFixture();
  const preview = await api('post', '/api/menu/plans/' + weekStart + '/preview', input);
  expect(preview.items[0]).toMatchObject({ quantity: 10, inStorage: 3, toBuy: 7 });
  const saved = await api('put', '/api/menu/plans/' + weekStart, { previewToken: preview.previewToken });
  const historicShopping = await api('get', '/api/shelf/final?weekStart=' + weekStart);
  const manual = [{ ingredientId: ingredient.id, quantity: 11, expiresAt: null }];
  await db.saveShelfCheck(manual);
  await makeInactive(item, state);
  const refreshed = await api('post', '/api/menu/plans/' + weekStart + '/preview', { ...input, version: saved.version });
  expect(refreshed.items[0]).toMatchObject({ quantity: 10, inStorage: 0, toBuy: 10, stockItems: [] });
  expect(await db.getWeeklyPlan(weekStart)).toEqual(saved);
  expect(await api('get', '/api/shelf/final?weekStart=' + weekStart)).toEqual(historicShopping);
  expect(await db.getShelf()).toEqual(manual);
  expect(amount((await db.getInventoryById(item.id)).quantity)).toBe(amount('3'));
});

test.each(['item', 'parent'])('activities cannot create or edit material links to an archived %s', async (state) => {
  const item = await stock();
  const { activity } = await activityFixture(item);
  await makeInactive(item, state);
  const material = { itemId: item.id, quantity: '1', unit: item.unit, reusable: false };
  await api('post', '/api/activity', { name: 'Rejected material', durationMinutes: 20, materials: [material] }, 409);
  await api('put', '/api/activity/' + activity.id, { name: 'Rejected edit', version: activity.version }, 409);
  expect(await db.getActivityById(activity.id)).toMatchObject({ name: activity.name, version: activity.version, materials: activity.materials });
});

test('saved, generated and copied activity plans retain archived requirements and show zero current availability', async () => {
  const item = await stock();
  const { room, activity, entry, plan } = await activityFixture(item);
  await makeInactive(item);
  const loaded = await api('get', '/api/schedule/plan?roomId=' + room.id + '&weekStart=' + weekStart);
  expect(loaded.entries).toEqual(plan.entries);
  expect(loaded).toMatchObject({ version: plan.version, savedAt: plan.savedAt,
    materials: [{ itemId: item.id, name: item.name, needed: '7', available: '0', shortage: '7', issue: expect.stringMatching(/archived/) }] });
  const generated = await api('post', '/api/schedule/plan/generate', { roomId: room.id, weekStart,
    version: plan.version, entries: [entry], slots: [{ id: 'next-slot', date: weekStart, startTime: '10:00', endTime: '10:30' }], allowRepeats: true });
  expect(generated.materials[0]).toMatchObject({ itemId: item.id, available: '0', issue: expect.stringMatching(/archived/) });
  expect(generated.warnings.join(' ')).toMatch(/unavailable materials/);
  const nextWeek = '2026-10-19';
  const copy = await api('post', '/api/schedule/plan', { roomId: room.id, weekStart: nextWeek, version: 0, requestId: randomUUID(),
    entries: [{ ...entry, id: randomUUID(), date: nextWeek, copyFrom: { roomId: room.id, weekStart, version: plan.version, entryId: entry.id } }] });
  expect(copy.entries[0].activity).toEqual(plan.entries[0].activity);
  expect(copy.materials[0]).toMatchObject({ itemId: item.id, name: item.name, available: '0', shortage: '7', issue: expect.stringMatching(/archived/) });
  expect(await db.getActivityById(activity.id)).toMatchObject({ materials: activity.materials });
  expect((await api('get', '/api/schedule/plan?roomId=' + room.id + '&weekStart=' + weekStart)).entries).toEqual(plan.entries);
});

test.each(['item', 'parent'])('purchasing diagnoses exact archived %s references without borrowing similarly named supplies', async (state) => {
  const item = await stock();
  const { room, plan } = await activityFixture(item);
  const other = await stock({ name: item.name, category: 'Other supplies', location: 'Different shelf', openingQuantity: '100' });
  await makeInactive(item, state);
  const preview = await api('post', purchasingPath + '/preview', { ...source(item), roomIds: [room.id] });
  expect(preview.token).toBe('');
  expect(preview.list.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MATERIAL_ARCHIVED', 'LOW_STOCK_ITEM_ARCHIVED']));
  expect(preview.list.issues.find((issue) => issue.code === 'MATERIAL_ARCHIVED').message).toContain('7 count of ' + item.name + ' at ' + item.location);
  expect(preview.list.lines.some((line) => line.itemId === other.id)).toBe(false);
  const options = await api('get', '/api/purchasing/options');
  expect(options.lowStock.some((row) => row.id === item.id)).toBe(false);
  expect((await api('get', '/api/schedule/plan?roomId=' + room.id + '&weekStart=' + weekStart)).entries).toEqual(plan.entries);
});

test('food purchasing uses active linked stock only and does not revive an archived incompatible unit', async () => {
  const { ingredient, item, input } = await mealFixture();
  const mealPreview = await api('post', '/api/menu/plans/' + weekStart + '/preview', input);
  const savedMeal = await api('put', '/api/menu/plans/' + weekStart, { previewToken: mealPreview.previewToken });
  const active = await stock({ name: 'Active flour', category: 'Active food', location: 'Active shelf', unit: 'g', ingredientId: ingredient.id, openingQuantity: '1' });
  await makeInactive(item);
  // Legacy bad units in a retained archived row must not block an active pool.
  await db.updateInventory(item.id, { unit: 'pack' });
  const preview = await api('post', purchasingPath + '/preview', { includeMeals: true, roomIds: [], lowStockTargets: [] });
  expect(preview.list.issues).toEqual([]);
  expect(preview.list.lines).toEqual([expect.objectContaining({ itemId: active.id, inStorage: '1', needed: '10', toBuy: '9' })]);
  await makeInactive(active);
  const unavailable = await api('post', purchasingPath + '/preview', { includeMeals: true, roomIds: [], lowStockTargets: [] });
  expect(unavailable.list.issues.map((issue) => issue.code)).toEqual(['FOOD_UNLINKED']);
  expect(unavailable.list.lines[0]).toMatchObject({ itemId: null, ingredientId: ingredient.id, inStorage: '0', needed: '10', toBuy: '10' });
  expect(await db.getWeeklyPlan(weekStart)).toEqual(savedMeal);
});

test.each(['item', 'parent'])('a signed purchasing review cannot select an archived %s, but explicit unselection can be saved', async (state) => {
  const item = await stock();
  const preview = await api('post', purchasingPath + '/preview', source(item));
  await makeInactive(item, state);
  await api('put', purchasingPath, { version: 0, token: preview.token, choices: choices(preview.list) }, 409);
  expect(await db.getPurchasingList(weekStart)).toBeNull();
  const saved = await api('put', purchasingPath, { version: 0, token: preview.token, choices: choices(preview.list, false) });
  expect(saved.lines[0]).toMatchObject({ itemId: item.id, inStorage: '3', toBuy: '7', selected: false });
  await api('put', purchasingPath, { version: saved.version, choices: choices(saved, true) }, 409);
  expect(await db.getPurchasingList(weekStart)).toEqual(saved);
  expect(amount((await db.getInventoryById(item.id)).quantity)).toBe(amount('3'));
});

test('archiving after a purchasing save preserves its snapshot and permits clearing its purchase selection', async () => {
  const item = await stock();
  const preview = await api('post', purchasingPath + '/preview', source(item));
  const saved = await api('put', purchasingPath, { version: 0, token: preview.token, choices: choices(preview.list) });
  await makeInactive(item);
  expect(await api('get', purchasingPath)).toEqual(saved);
  await api('put', purchasingPath, { version: saved.version, choices: choices(saved) }, 409);
  expect(await api('get', purchasingPath)).toEqual(saved);
  const cleared = await api('put', purchasingPath, { version: saved.version, choices: choices(saved, false) });
  expect(cleared).toMatchObject({ version: 2, stockTakenAt: saved.stockTakenAt });
  expect(cleared.lines[0]).toEqual({ ...saved.lines[0], selected: false });
});
