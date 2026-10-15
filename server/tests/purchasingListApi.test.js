const { randomUUID } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const { amount } = require('../services/inventoryValidation');

const weekStart = '2026-10-12';
const path = '/api/purchasing/' + weekStart;
const input = { includeMeals: true, roomIds: [], lowStockTargets: [] };
let item, mealPlan, ingredient;
const choices = (list, overrides = {}) => list.lines.map((line) => ({ id: line.id, buyQuantity: line.buyQuantity,
  selected: line.selected, checked: line.checked, ...overrides }));
async function api(method, url, body, expected = 200) {
  const response = await request(app)[method](url).send(body);
  expect({ status: response.status, error: response.body.error }).toEqual({ status: expected,
    error: expected >= 400 ? expect.anything() : undefined });
  return response.body.data;
}
const preview = (values = {}, url = path) => api('post', url + '/preview', { ...input, ...values });
const save = (calculation, overrides = {}) => api('put', path, { version: calculation.list.version,
  token: calculation.token, choices: choices(calculation.list), ...overrides });

beforeEach(async () => {
  ingredient = await db.createIngredient({ name: 'Synthetic flour', unit: 'g' });
  const meal = await db.createMeal({ name: 'Saved breakfast', type: 'breakfast' });
  item = await api('post', '/api/inventory', { name: 'Synthetic flour stock', category: 'Food', location: 'Kitchen / Shelf 1',
    ingredientId: ingredient.id, unit: 'g', openingQuantity: '3', reorderThreshold: '5', reason: 'Opening count', requestId: randomUUID() }, 201);
  const savedIngredient = { id: ingredient.id, name: ingredient.name, unit: ingredient.unit };
  mealPlan = await db.saveWeeklyPlan({ weekStart, childrenCount: 4, staffCount: 1,
    week: [{ day: 'Monday', menu: { breakfast: meal } }], recipes: { Monday: { breakfast: {
      meal, ingredients: [{ ingredient: savedIngredient, quantityPerPerson: 2 }], problems: [],
    } } }, stockSource: 'inventory', stockTakenAt: '2026-10-10T10:00:00Z', inHouse: { [ingredient.id]: 3 },
    items: [{ ingredient: savedIngredient, quantity: 10, inStorage: 3, toBuy: 7 }] }, 0);
});

test('reviewed quantities and check-offs persist without changing meal history or inventory', async () => {
  const inventoryBefore = await db.getInventoryById(item.id);
  expect(amount(inventoryBefore.quantity)).toBe(amount('3'));
  expect(inventoryBefore.version).toBe(1);
  expect(await api('get', path)).toBeNull();
  const calculation = await preview();
  expect(calculation.list.lines[0]).toMatchObject({ needed: '10', inStorage: '3', toBuy: '7' });
  const saved = await save(calculation, { choices: choices(calculation.list, { buyQuantity: '8.5', selected: true, checked: true }) });
  expect(saved).toMatchObject({ version: 1, savedAt: expect.any(String), lines: [{ buyQuantity: '8.5', checked: true }] });
  expect(await api('get', path)).toEqual(saved);
  const updated = await api('put', path, { version: 1, choices: choices(saved, { selected: false, checked: false }) });
  expect(updated).toMatchObject({ version: 2, stockTakenAt: saved.stockTakenAt, lines: [{ buyQuantity: '8.5', selected: false }] });
  expect(await db.getWeeklyPlan(weekStart)).toEqual(mealPlan);
  expect(await db.getInventoryById(item.id)).toEqual(inventoryBefore);
  expect(await db.countInventoryMovements(item.id)).toBe(1);
  expect((await db.listAudit({ actions: ['purchasing_list.save'] })).map((event) => event.actorId)).toEqual([
    request.credentials().account.id, request.credentials().account.id,
  ]);
});

test('saved stock samples stay unchanged until explicit refresh and saved source recipes stay historical', async () => {
  const calculation = await preview();
  const saved = await save(calculation);
  await api('post', '/api/inventory/' + item.id + '/movements', { type: 'correction', quantity: '9', unit: 'g', version: item.version,
    reason: 'Physical count changed after review', requestId: randomUUID() });
  await db.updateIngredient(ingredient.id, { name: 'Current renamed flour' });
  expect(await api('get', path)).toEqual(saved);
  const refreshed = await preview();
  expect(refreshed.list).toMatchObject({ version: 1, mealPlan: { version: mealPlan.version, savedAt: mealPlan.savedAt },
    lines: [{ needed: '10', inStorage: '9', toBuy: '1' }] });
  expect(refreshed.list.lines[0].sources[0].label).toContain('Saved breakfast');
  expect(await api('get', path)).toEqual(saved);
  await save(refreshed);
  expect((await api('get', path)).lines[0].toBuy).toBe('1');
  expect(await db.getWeeklyPlan(weekStart)).toEqual(mealPlan);
});

test('competing first saves and stale edited versions cannot overwrite a reviewed list', async () => {
  const one = await preview();
  const two = await preview();
  const responses = await Promise.all([one, two].map((value) => request(app).put(path).send({ version: 0, token: value.token, choices: choices(value.list) })));
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const saved = await api('get', path);
  await api('put', path, { version: 1, token: one.token, choices: choices(one.list) }, 409);
  await api('put', path, { version: 0, choices: choices(saved) }, 409);
  expect(await api('get', path)).toEqual(saved);
});

test('a signed preview cannot be forged or saved into another week', async () => {
  const calculation = await preview();
  await api('put', path, { version: 0, token: calculation.token.slice(0, -1) + '!', choices: choices(calculation.list) }, 409);
  await api('put', '/api/purchasing/2026-10-19', { version: 0, token: calculation.token, choices: choices(calculation.list) }, 400);
  await api('put', path, { version: 0, snapshot: calculation.list, choices: choices(calculation.list) }, 400);
  expect(await api('get', path)).toBeNull();
});

test('one-hour preview expiration requires a new review without erasing an existing list', async () => {
  const calculation = await preview();
  const saved = await save(calculation);
  const next = await preview();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600001);
  // Exercise calculation expiry directly: advancing an HTTP request by an hour
  // would also expire its ordinary idle session before the preview is decoded.
  try { await expect(require('../services/purchasingService').save(weekStart,
    { version: 1, token: next.token, choices: choices(next.list) })).rejects.toMatchObject({ status: 409, code: 'PURCHASING_PREVIEW_EXPIRED' }); }
  finally { clock.mockRestore(); }
  expect(await api('get', path)).toEqual(saved);
});

test.each([
  ['unknown field', { snapshot: {} }], ['non-boolean include', { includeMeals: 'true' }], ['invalid room list', { roomIds: null }],
  ['duplicate room', { roomIds: ['room', 'room'] }], ['too many rooms', { roomIds: Array.from({ length: 101 }, (_, i) => 'room-' + i) }],
  ['invalid target', { lowStockTargets: [{ itemId: 'stock', targetQuantity: '1e3' }] }],
  ['unknown target field', { lowStockTargets: [{ itemId: 'stock', targetQuantity: '10', unit: 'count' }] }],
  ['no sources', { includeMeals: false }],
])('preview rejects %s without saving', async (_label, changes) => {
  await api('post', path + '/preview', { ...input, ...changes }, 400);
  expect(await api('get', path)).toBeNull();
});

test.each([
  ['negative buy amount', { buyQuantity: '-1' }], ['overprecise amount', { buyQuantity: '0.1234567' }],
  ['client stock', { inStorage: '100' }], ['invalid checkbox', { selected: 'yes' }],
  ['checked but unselected', { selected: false, checked: true }], ['unknown line', { id: 'inventory:other' }],
])('review rejects %s without saving', async (_label, changes) => {
  const calculation = await preview();
  await api('put', path, { version: 0, token: calculation.token, choices: choices(calculation.list, changes) }, 400);
  expect(await api('get', path)).toBeNull();
});

test('unresolved saved recipe and unlinked stock produce issues and no save token', async () => {
  const invalid = structuredClone(mealPlan); invalid.recipes.Monday.breakfast.problems = ['Review ingredient quantity'];
  await db.saveWeeklyPlan(invalid, 1);
  const calculation = await preview();
  expect(calculation.token).toBe('');
  expect(calculation.list.issues.map((issue) => issue.code)).toContain('RECIPE_INCOMPLETE');
  await api('put', path, { version: 0, token: calculation.token, choices: choices(calculation.list) }, 409);
});

test('selected saved room snapshots and legacy material hints are reviewed without borrowing current quantities', async () => {
  const room = await db.createRoom({ name: 'Synthetic room', ageMinMonths: 0, ageMaxMonths: 36, capacity: 12, active: true });
  const activity = await db.createActivity({ name: 'Old materials', durationMinutes: 30, ageMinMonths: null, ageMaxMonths: null,
    materials: [{ itemId: item.id, unit: 'g', quantity: '100', reusable: false }], materialsNotes: 'Other supplies require review', version: 1 });
  await db.saveScheduleWeek({ roomId: room.id, weekStart, version: 1, savedAt: '2026-10-10T10:00:00Z' });
  await db.saveScheduleEntries(room.id, weekStart, [{ date: weekStart, startTime: '09:00', endTime: '10:00', activityId: activity.id,
    activitySnapshot: { id: activity.id, name: activity.name, version: 1, materials: [{ itemId: item.id, unit: 'g', quantity: '2', reusable: false }] } }]);
  const calculation = await preview({ includeMeals: false, roomIds: [room.id] });
  expect(calculation.list.lines[0]).toMatchObject({ needed: '2', toBuy: '0' });
  expect(calculation.list.issues.map((issue) => issue.code)).toContain('ACTIVITY_MATERIAL_UNLINKED');
  expect(calculation.token).toBe('');
  expect((await preview({ includeMeals: false, lowStockTargets: [{ itemId: item.id, targetQuantity: '12' }] })).list.lines[0]).toMatchObject({ needed: '12', toBuy: '9' });
  const options = await api('get', '/api/purchasing/options');
  expect(options.rooms).toContainEqual({ id: room.id, name: room.name, archived: false });
  expect(options.lowStock).toContainEqual({ id: item.id, name: item.name, location: item.location, unit: 'g', quantity: '3', reorderThreshold: '5', version: 1 });
});

test.each(['viewer', 'editor'])('%s can inspect and preview while only an editor can save', async (role) => {
  const administrator = await db.getAccount(request.credentials().account.id);
  const account = await db.createAccount({ id: randomUUID(), username: 'purchasing-' + randomUUID().slice(0, 8), displayName: 'Synthetic purchasing operator',
    passwordHash: administrator.passwordHash, role, disabled: false, mustChangePassword: false });
  const login = await anonymous(app).post('/api/auth/login').set('Origin', request.origin).send({ username: account.username, password: request.password });
  expect(login.status).toBe(200);
  const actor = (method, url, body) => anonymous(app)[method](url).set('Origin', request.origin)
    .set('Cookie', login.headers['set-cookie'][0].split(';')[0]).set('X-CSRF-Token', login.body.csrfToken).send(body);
  const calculation = await actor('post', path + '/preview', input);
  expect(calculation.status).toBe(200);
  expect((await actor('get', '/api/purchasing/options')).status).toBe(200);
  expect((await actor('get', path)).status).toBe(200);
  const { list, token } = calculation.body.data;
  const saving = await actor('put', path, { version: 0, token, choices: choices(list) });
  expect(saving.status).toBe(role === 'editor' ? 200 : 403);
});

test('anonymous access, missing CSRF and foreign origins cannot preview or save', async () => {
  expect((await anonymous(app).get(path)).status).toBe(401);
  expect((await anonymous(app).post(path + '/preview').set('Origin', request.origin)
    .set('Cookie', request.credentials().cookie).send(input)).status).toBe(403);
  expect((await anonymous(app).post(path + '/preview').set('Origin', 'https://other.invalid')
    .set('Cookie', request.credentials().cookie).set('X-CSRF-Token', request.credentials().csrf).send(input)).status).toBe(403);
});

test('an audit failure rolls back the reviewed list version and every choice', async () => {
  const inventoryBefore = await db.getInventoryById(item.id);
  expect(amount(inventoryBefore.quantity)).toBe(amount('3'));
  expect(inventoryBefore.version).toBe(1);
  const calculation = await preview();
  const saved = await save(calculation);
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit storage outage'));
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await api('put', path, { version: 1, choices: choices(saved, { buyQuantity: '9', checked: true }) }, 500); }
  finally { audit.mockRestore(); logging.mockRestore(); }
  expect(await api('get', path)).toEqual(saved);
  expect(await db.getInventoryById(item.id)).toEqual(inventoryBefore);
  expect(await db.listAudit({ actions: ['purchasing_list.save'] })).toHaveLength(1);
});

test('a bounded source-rich signed calculation can exceed the ordinary JSON limit after authentication', async () => {
  const room = await db.createRoom({ name: 'Synthetic source-rich room', ageMinMonths: 0, ageMaxMonths: 36, capacity: 12, active: true });
  const activity = await db.createActivity({ name: 'Synthetic activity with documented material sources for a purchasing review', durationMinutes: 30,
    ageMinMonths: null, ageMaxMonths: null, materials: [], version: 1 });
  await db.saveScheduleWeek({ roomId: room.id, weekStart, version: 1, savedAt: '2026-10-10T10:00:00Z' });
  await db.saveScheduleEntries(room.id, weekStart, Array.from({ length: 500 }, (_, index) => ({ id: randomUUID(),
    date: weekStart, startTime: '09:00', endTime: '10:00', activityId: activity.id,
    activitySnapshot: { id: activity.id, name: activity.name + ' ' + index, version: 1, materialsNotes: '', materialsLinks: [],
      materials: [{ itemId: item.id, quantity: '1', unit: 'g', reusable: false }] } })));
  const calculation = await preview({ includeMeals: false, roomIds: [room.id] });
  expect(Buffer.byteLength(calculation.token)).toBeGreaterThan(100 * 1024);
  expect(Buffer.byteLength(calculation.token)).toBeLessThan(700000);
  expect((await save(calculation)).lines[0]).toMatchObject({ needed: '500', inStorage: '3', toBuy: '497' });
  expect((await anonymous(app).put(path).set('Origin', request.origin)
    .send({ version: 0, token: calculation.token, choices: choices(calculation.list) })).status).toBe(401);
});
