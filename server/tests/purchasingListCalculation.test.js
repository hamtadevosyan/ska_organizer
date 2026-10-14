const { calculate, demand } = require('../services/purchasingCalculation');
const { amount } = require('../services/inventoryValidation');

const weekStart = '2026-10-12';
const stock = (id = 'a', overrides = {}) => ({ id, name: 'Flour ' + id, unit: 'g', quantity: '0', location: 'Shelf ' + id,
  ingredientId: 'flour', version: 1, reorderThreshold: '0', ...overrides });
const material = (itemId, quantity, reusable = false, unit = 'g') => ({ itemId, quantity, reusable, unit });
const entry = (materials, overrides = {}) => ({ id: 'activity-entry', date: weekStart, startTime: '09:00', endTime: '10:00',
  activitySnapshot: { name: 'Sensory activity', materials }, ...overrides });
const plan = (roomId, entries) => ({ room: { id: roomId, name: 'Room ' + roomId }, header: { version: 2, savedAt: '2026-10-10T10:00:00Z' }, entries });
function meal(quantity = 10, unit = 'g') {
  const ingredient = { id: 'flour', name: 'Flour', unit };
  const meal = { id: 'breakfast', name: 'Breakfast', type: 'breakfast' };
  return { weekStart, version: 3, savedAt: '2026-10-10T12:00:00Z', childrenCount: 1, staffCount: 0,
    week: [{ day: 'Monday', menu: { breakfast: meal } }],
    recipes: { Monday: { breakfast: { meal, ingredients: [{ ingredient, quantityPerPerson: quantity }], problems: [] } } },
    items: [{ ingredient, quantity, inStorage: 100, toBuy: 0 }] };
}
const preview = (overrides = {}) => calculate({ weekStart, version: 0, includeMeals: false, roomIds: [], lowStockTargets: [],
  mealPlan: null, activityPlans: [], inventory: [], stockTakenAt: '2026-10-14T12:00:00Z', ...overrides });

test('food and exact activity requirements share stock once, and total coverage overlaps both demands', () => {
  const result = preview({ includeMeals: true, mealPlan: meal(), inventory: [stock('a', { quantity: '10' }), stock('b')],
    roomIds: ['room-a'], activityPlans: [plan('room-a', [entry([material('a', '20')])])],
    lowStockTargets: [{ itemId: 'a', targetQuantity: '30' }] });
  expect(result.issues).toEqual([]);
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ itemId: 'a', needed: '30', inStorage: '10', toBuy: '20', buyQuantity: '20',
    stockItems: [{ id: 'a', allocated: '10' }] });
  expect(result.lines[0].sources.map((source) => source.kind)).toEqual(['activity', 'low-stock', 'meal']);
  expect(result.mealPlan).toEqual({ version: 3, savedAt: '2026-10-10T12:00:00Z' });
  expect(result.activityPlans).toEqual([{ roomId: 'room-a', roomName: 'Room room-a', version: 2, savedAt: '2026-10-10T10:00:00Z' }]);
});

test('available food stock across locations is used before unmet targets, while exact activity stock never moves silently', () => {
  const result = preview({ includeMeals: true, mealPlan: meal(25), inventory: [stock('a', { quantity: '5' }), stock('b', { quantity: '20' }), stock('c', { quantity: '10' })],
    roomIds: ['room-a'], activityPlans: [plan('room-a', [entry([material('a', '15')])])],
    lowStockTargets: [{ itemId: 'a', targetQuantity: '40' }, { itemId: 'c', targetQuantity: '15' }] });
  const byId = new Map(result.lines.map((line) => [line.itemId, line]));
  expect(byId.get('a')).toMatchObject({ needed: '40', inStorage: '5', toBuy: '35' });
  expect(byId.get('b')).toMatchObject({ needed: '20', inStorage: '20', toBuy: '0' });
  expect(byId.get('c')).toMatchObject({ needed: '15', inStorage: '10', toBuy: '5' });
  expect(byId.get('a').sources.filter((source) => source.kind === 'meal')).toEqual([]);
  expect(byId.get('c').sources.find((source) => source.kind === 'meal').quantity).toBe('5');
});

test('reusable equipment combines simultaneous rooms, releases at a boundary and adds consumables once', () => {
  const equipment = stock('a', { ingredientId: null, unit: 'count', quantity: '4' });
  const result = preview({ inventory: [equipment], roomIds: ['one', 'two'], activityPlans: [
    plan('one', [entry([material('a', '3', true, 'count')]), entry([material('a', '7', true, 'count')], { startTime: '11:00', endTime: '12:00' }),
      entry([material('a', '2', false, 'count')])]),
    plan('two', [entry([material('a', '2', true, 'count')], { startTime: '09:30', endTime: '10:30' }),
      entry([material('a', '6', true, 'count')], { startTime: '12:00', endTime: '13:00' })]),
  ] });
  expect(result.lines[0]).toMatchObject({ needed: '9', inStorage: '4', toBuy: '5' });
  expect(result.lines[0].notes.join(' ')).toContain('largest simultaneous total');
  const one = preview({ inventory: [equipment], roomIds: ['two'], activityPlans: [
    plan('two', [entry([material('a', '2', true, 'count')]), entry([material('a', '6', true, 'count')], { startTime: '10:00', endTime: '11:00' })])] });
  expect(one.lines[0].needed).toBe('6');
});

test('legacy untimed reusable activity occupies its day with a visible conservative note', () => {
  const result = preview({ inventory: [stock('a', { unit: 'count', ingredientId: null })], roomIds: ['one', 'two'], activityPlans: [
    plan('one', [entry([material('a', '4', true, 'count')], { startTime: null, endTime: null, timeBlock: 'morning' })]),
    plan('two', [entry([material('a', '3', true, 'count')], { startTime: '14:00', endTime: '15:00' })]),
  ] });
  expect(result.issues).toEqual([]);
  expect(result.lines[0].needed).toBe('7');
  expect(result.lines[0].notes.join(' ')).toContain('whole day');
});

test('stock from a different equipment record and location cannot cover an exact requirement', () => {
  const result = preview({ inventory: [stock('a', { name: 'Scissors', unit: 'count', ingredientId: null }),
    stock('b', { name: 'Scissors', unit: 'count', ingredientId: null, quantity: '100' })], roomIds: ['one'],
    activityPlans: [plan('one', [entry([material('a', '4', true, 'count')])])] });
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ itemId: 'a', location: 'Shelf a', toBuy: '4', stockItems: [{ id: 'a' }] });
});

test('compatible required quantities round up and stock availability never rounds up', () => {
  expect(demand(amount('1'), 'oz', 'g')).toBe(amount('28.349524'));
  const result = preview({ includeMeals: true, mealPlan: meal(1, 'oz'), inventory: [stock('a', { quantity: '0.000001' })] });
  expect(result.issues).toEqual([]);
  expect(result.lines[0]).toMatchObject({ unit: 'g', needed: '28.349524', inStorage: '0.000001', toBuy: '28.349523' });
  expect(result.lines[0].sources.filter((source) => source.kind === 'meal')).toEqual([
    { kind: 'meal', label: 'Monday · Breakfast', quantity: '1', unit: 'oz', date: weekStart },
  ]);
});

test('fractional compatible stock allocations cannot promise a millionth that is not physically available', () => {
  const result = preview({ includeMeals: true, mealPlan: meal(0.000001, 'oz'), inventory: [stock('a', { quantity: '0.000001' }), stock('b', { quantity: '0.000001' })] });
  expect(result.lines).toHaveLength(1);
  expect(result.lines[0]).toMatchObject({ needed: '0.000029', inStorage: '0.000001', toBuy: '0.000028' });
});

test('very small converted quantities retain every meal source in its saved recipe unit', () => {
  const saved = meal(0.000002);
  saved.recipes.Monday.breakfast.ingredients[0].quantityPerPerson = 0.000001;
  saved.week.push({ day: 'Tuesday', menu: structuredClone(saved.week[0].menu) });
  saved.recipes.Tuesday = structuredClone(saved.recipes.Monday);
  const result = preview({ includeMeals: true, mealPlan: saved, inventory: [stock('a', { unit: 'lb' })] });
  expect(result.issues).toEqual([]);
  expect(result.lines[0]).toMatchObject({ unit: 'lb', needed: '0.000001', toBuy: '0.000001' });
  expect(result.lines[0].sources.map((source) => ({ label: source.label, quantity: source.quantity, unit: source.unit }))).toEqual([
    { label: 'Monday · Breakfast', quantity: '0.000001', unit: 'g' },
    { label: 'Tuesday · Breakfast', quantity: '0.000001', unit: 'g' },
  ]);
});

test('incompatible food links and unlinked food remain visible with actionable issues', () => {
  const result = preview({ includeMeals: true, mealPlan: meal(), inventory: [stock('a', { unit: 'pack', quantity: '100' })] });
  expect(result.issues.map((issue) => issue.code)).toEqual(['FOOD_UNIT_INCOMPATIBLE', 'FOOD_UNLINKED']);
  expect(result.lines[0]).toMatchObject({ itemId: null, ingredientId: 'flour', needed: '10', inStorage: '0', toBuy: '10' });
  for (const issue of result.issues) expect(issue).toMatchObject({ href: '/inventory', resolution: expect.any(String) });
});

test('missing saved snapshots, unknown materials and incomplete recipes are never rebuilt from current catalogs', () => {
  const savedMeal = meal(); savedMeal.recipes.Monday.breakfast.problems = ['Missing ingredient'];
  const result = preview({ includeMeals: true, mealPlan: savedMeal, inventory: [stock()], roomIds: ['one'],
    activityPlans: [plan('one', [entry([], { activitySnapshot: null }), entry([material('gone', '2')]),
      entry([material('a', '0')]), entry([material('a', '1', false, 'pack')]), entry([], { materialHintsUnknown: true })])] });
  expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    'ACTIVITY_SNAPSHOT_MISSING', 'MATERIAL_MISSING', 'MATERIAL_QUANTITY_UNKNOWN', 'MATERIAL_UNIT_INCOMPATIBLE',
    'ACTIVITY_MATERIAL_UNLINKED', 'RECIPE_INCOMPLETE', 'FOOD_SOURCE_MISSING',
  ]));
});

test('missing selected plans give guidance, and another date cannot contribute demand to this week', () => {
  const result = preview({ includeMeals: true, roomIds: ['one', 'two'], inventory: [stock()], activityPlans: [
    { room: { id: 'one', name: 'One' }, header: null, entries: [] },
    plan('two', [entry([material('a', '3')], { date: '2026-10-19' })]),
  ] });
  expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MEAL_PLAN_MISSING', 'ACTIVITY_PLAN_MISSING', 'ACTIVITY_DATE_INVALID']));
  expect(result.lines).toEqual([]);
});

test.each([
  ['non-array meal demand', (saved) => { saved.items = {}; }],
  ['null meal demand line', (saved) => { saved.items = [null]; }],
  ['non-array meal week', (saved) => { saved.week = {}; }],
  ['null meal day', (saved) => { saved.week = [null]; }],
  ['null meal selection', (saved) => { saved.week[0].menu.breakfast = null; }],
  ['empty day selections', (saved) => { saved.week[0].menu = {}; }],
  ['duplicate meal day', (saved) => { saved.week.push(structuredClone(saved.week[0])); }],
  ['null recipe ingredient', (saved) => { saved.recipes.Monday.breakfast.ingredients = [null]; }],
  ['non-array recipe ingredients', (saved) => { saved.recipes.Monday.breakfast.ingredients = {}; }],
])('%s remains an actionable incomplete historical plan rather than crashing or allowing a complete list', (_label, mutate) => {
  const saved = meal(); mutate(saved);
  const result = preview({ includeMeals: true, mealPlan: saved, inventory: [stock()] });
  expect(result.issues.length).toBeGreaterThan(0);
  for (const issue of result.issues) {
    expect(issue.message).toEqual(expect.any(String));
    expect(issue.resolution).toEqual(expect.any(String));
  }
});

test.each([
  ['null activity entry', (saved) => { saved.entries = [null]; }],
  ['null material entry', (saved) => { saved.entries[0].activitySnapshot.materials = [null]; }],
  ['malformed material notes', (saved) => { saved.entries[0].activitySnapshot.materialsNotes = {}; }],
  ['malformed material links', (saved) => { saved.entries[0].activitySnapshot.materialsLinks = 'unquantified supplies'; }],
])('%s cannot silently make historical activity requirements look complete', (_label, mutate) => {
  const saved = plan('one', [entry([material('a', '1')])]); mutate(saved);
  const result = preview({ inventory: [stock()], roomIds: ['one'], activityPlans: [saved] });
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.issues.every((issue) => typeof issue.resolution === 'string' && issue.resolution.length > 0)).toBe(true);
});
