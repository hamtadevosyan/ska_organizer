const plainRequest = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const { addMealRoster } = require('./helpers/mealRoster');
const { randomUUID } = require('node:crypto');
const planPath = '/api/menu/plans/2026-10-05';

async function breakfastWeek() {
  const meal = await db.createMeal({ name: 'Synthetic breakfast', type: 'breakfast' });
  const ingredient = await db.createIngredient({ name: 'Synthetic eggs', unit: 'count' });
  await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity: 1 });
  return [{ day: 'Monday', menu: { breakfast: meal } }];
}
async function shopping(body) {
  const response = await request(app).post('/api/shopping/generate').send(body);
  expect(response.status).toBe(200);
  return response.body.data;
}

test('an empty roster returns zero totals and blocks omitted-count calculations with actionable guidance', async () => {
  const counts = await request(app).get('/api/menu/headcounts');
  expect(counts.status).toBe(200);
  expect(counts.headers['cache-control']).toBe('no-store');
  expect(counts.body).toEqual({ data: { childrenCount: 0, staffCount: 0 } });
  const week = await breakfastWeek();
  await db.saveConfirmedMenu({ week });
  for (const path of ['/api/shopping/generate', planPath + '/import-preview']) {
    const response = await request(app).post(path).send({});
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/Add active children or staff, or enter a positive meal planning count/);
  }
  expect(await db.getWeeklyPlan('2026-10-05')).toBeNull();
  expect(await shopping({ week, childrenCount: 2, staffCount: 0 }))
    .toMatchObject({ meta: { childrenCount: 2, staffCount: 0, totalPeople: 2 }, items: [{ quantity: 2 }] });
  const manualImport = await request(app).post(planPath + '/import-preview').send({ childrenCount: 2, staffCount: 0 });
  expect(manualImport.status).toBe(200);
  expect(manualImport.body.data).toMatchObject({ childrenCount: 2, staffCount: 0, items: [{ quantity: 2 }] });
});

test.each(['admin', 'editor', 'viewer'])('%s receives only its permitted meal roster response', async role => {
  await addMealRoster(3, 2);
  await db.updateAccount(request.credentials().account.id, { role });
  const response = await request(app).get('/api/menu/headcounts');
  expect(response.status).toBe(role === 'viewer' ? 403 : 200);
  if (role === 'viewer') expect(response.body.error.code).toBe('CLASSROOM_ONLY');
  else expect(response.body).toEqual({ data: { childrenCount: 3, staffCount: 2 } });
});

test('meal roster counts require an active session and reject foreign origins', async () => {
  expect((await plainRequest(app).get('/api/menu/headcounts')).status).toBe(401);
  expect((await request(app).get('/api/menu/headcounts').set('Origin', 'https://untrusted.example')).status).toBe(403);
  await db.updateAccount(request.credentials().account.id, { disabled: true });
  expect((await request(app).get('/api/menu/headcounts')).status).toBe(401);
});

test('counts include active unassigned people beyond a directory page and exclude inactive people and sign-in accounts', async () => {
  const roster = await addMealRoster(55, 53);
  const room = await db.createRoom({ name: 'Synthetic meal room', ageMinMonths: 0, ageMaxMonths: 72, capacity: 60 });
  await db.updateChild(roster.children[0].id, { roomId: room.id });
  await db.updateStaff(roster.staff[0].id, { roomId: room.id });
  await db.createChild({ firstName: 'Inactive', lastName: 'Synthetic child', dateOfBirth: '2022-01-15', active: false });
  await db.createStaff({ name: 'Inactive synthetic employee', role: 'Teacher', active: false });
  const administrator = await db.getAccount(request.credentials().account.id);
  await db.createAccount({ id: randomUUID(), username: 'synthetic-only-login', displayName: 'Login is not an employee',
    passwordHash: administrator.passwordHash, role: 'editor', disabled: false, mustChangePassword: false });
  expect(await db.listChildren({ active: true })).toHaveLength(50);
  expect(await db.listStaff({ active: true })).toHaveLength(50);
  const response = await request(app).get('/api/menu/headcounts');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ data: { childrenCount: 55, staffCount: 53 } });
});

test('omitted shopping counts follow roster changes while explicit values including zero remain exact', async () => {
  const roster = await addMealRoster(4, 2);
  const week = await breakfastWeek();
  expect(await shopping({ week })).toMatchObject({ meta: { childrenCount: 4, staffCount: 2, totalPeople: 6 }, items: [{ quantity: 6 }] });
  expect(await shopping({ week, childrenCount: 1 })).toMatchObject({ meta: { childrenCount: 1, staffCount: 2, totalPeople: 3 }, items: [{ quantity: 3 }] });
  expect(await shopping({ week, staffCount: 0 })).toMatchObject({ meta: { childrenCount: 4, staffCount: 0, totalPeople: 4 }, items: [{ quantity: 4 }] });
  expect(await shopping({ week, childrenCount: 0, staffCount: 7 })).toMatchObject({ meta: { childrenCount: 0, staffCount: 7, totalPeople: 7 }, items: [{ quantity: 7 }] });
  await db.updateChild(roster.children[0].id, { active: false });
  await db.updateStaff(roster.staff[0].id, { active: false });
  expect((await request(app).get('/api/menu/headcounts')).body.data).toEqual({ childrenCount: 3, staffCount: 1 });
  expect(await shopping({ week })).toMatchObject({ meta: { childrenCount: 3, staffCount: 1, totalPeople: 4 }, items: [{ quantity: 4 }] });
});

test.each([
  { childrenCount: null }, { staffCount: '2' }, { childrenCount: -1 },
  { staffCount: 1.5 }, { childrenCount: 0, staffCount: 0 },
])('invalid manual counts %j are not replaced by roster values', async counts => {
  await addMealRoster(4, 2);
  const response = await request(app).post('/api/shopping/generate').send({ week: await breakfastWeek(), ...counts });
  expect(response.status).toBe(400);
  expect(response.body.error.message).toMatch(/non-negative whole numbers with a positive total/);
});

test('legacy imports use live totals or explicit overrides and leave saved dated counts and daily overrides intact', async () => {
  const roster = await addMealRoster(4, 2);
  const week = await breakfastWeek();
  await db.saveConfirmedMenu({ week });
  const original = await request(app).post(planPath + '/preview').send({ version: 0, week,
    childrenCount: 2, staffCount: 1, dailyChildrenCounts: { '2026-10-05': 1 } });
  expect(original.status).toBe(200);
  const saved = await request(app).put(planPath).send({ previewToken: original.body.data.previewToken });
  expect(saved.status).toBe(200);
  const legacy = await db.getConfirmedMenu();
  await db.updateChild(roster.children[0].id, { active: false });
  await db.updateStaff(roster.staff[0].id, { active: false });
  const imported = await request(app).post('/api/menu/plans/2026-10-12/import-preview').send({});
  expect(imported.status).toBe(200);
  expect(imported.body.data).toMatchObject({ childrenCount: 3, staffCount: 1, items: [{ quantity: 4 }] });
  const manual = await request(app).post('/api/menu/plans/2026-10-19/import-preview').send({ childrenCount: 0, staffCount: 7 });
  expect(manual.status).toBe(200);
  expect(manual.body.data).toMatchObject({ childrenCount: 0, staffCount: 7, items: [{ quantity: 7 }] });
  expect((await request(app).get(planPath)).body.data).toEqual(saved.body.data);
  expect(saved.body.data).toMatchObject({ childrenCount: 2, staffCount: 1, dailyChildrenCounts: { '2026-10-05': 1 }, items: [{ quantity: 2 }] });
  expect(await db.getWeeklyPlan('2026-10-12')).toBeNull();
  expect(await db.getConfirmedMenu()).toEqual(legacy);
});

test('a failed roster query returns an error without silently using zero or invented counts', async () => {
  const failure = jest.spyOn(db, 'countStaff').mockRejectedValueOnce(new Error('Synthetic private database message'));
  try {
    const response = await request(app).get('/api/menu/headcounts');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { message: 'Internal server error.' } });
    expect(JSON.stringify(response.body)).not.toContain('Synthetic private database message');
  } finally { failure.mockRestore(); }
});


test('fully explicit shopping counts do not depend on roster count query availability', async () => {
  const week = await breakfastWeek();
  const children = jest.spyOn(db, 'countChildren').mockRejectedValue(new Error('Synthetic roster count outage'));
  const staff = jest.spyOn(db, 'countStaff').mockRejectedValue(new Error('Synthetic roster count outage'));
  try {
    expect(await shopping({ week, childrenCount: 3, staffCount: 0 }))
      .toMatchObject({ meta: { childrenCount: 3, staffCount: 0, totalPeople: 3 }, items: [{ quantity: 3 }] });
    expect(children).not.toHaveBeenCalled();
    expect(staff).not.toHaveBeenCalled();
  } finally { children.mockRestore(); staff.mockRestore(); }
});
