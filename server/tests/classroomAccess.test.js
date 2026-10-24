const { randomUUID } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const classroom = require('../services/classroomService');
const weekStart = '2026-10-19';
const token = () => request.credentials().cookie.split('=')[1];
const room = (name = 'Own class') => db.createRoom({ name, active: true, capacity: 220, ageMinMonths: 24, ageMaxMonths: 60 });
async function viewer(assigned) {
  return db.updateAccount(request.credentials().account.id, { role: 'viewer', roomId: assigned?.id ?? null });
}
async function get(path = '') {
  const response = await request(app).get('/api/classroom' + path);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.body.data;
}
async function child(assigned, changes = {}) {
  return db.createChild({ firstName: 'Synthetic', lastName: 'Child', dateOfBirth: '2023-01-01', active: true,
    roomId: assigned.id, notes: 'PRIVATE CHILD NOTES', ...changes });
}
async function schedule(assigned, { header = true, snapshot = true } = {}) {
  const activity = await db.createActivity({ name: 'Current catalog name', description: 'PRIVATE CURRENT DESCRIPTION', durationMinutes: 45 });
  const entries = [{ id: randomUUID(), date: weekStart, startTime: '09:00', endTime: '09:30', timeBlock: null,
    activityId: activity.id, activitySnapshot: snapshot ? { name: 'Saved class activity', description: 'Saved instructions', durationMinutes: 30,
      materials: [{ name: 'PRIVATE MATERIAL', quantity: 20 }], privateField: 'PRIVATE SNAPSHOT FIELD' } : null }];
  await db.saveScheduleEntries(assigned.id, weekStart, entries);
  if (header) await db.saveScheduleWeek({ roomId: assigned.id, weekStart, version: 1, savedAt: new Date().toISOString() });
  return entries;
}

test('class views require a signed-in Class viewer and enforce temporary password changes', async () => {
  expect((await anonymous(app).get('/api/classroom')).status).toBe(401);
  expect((await request(app).get('/api/classroom')).body.error.code).toBe('CLASSROOM_VIEWER_ONLY');
  await viewer(await room());
  await db.updateAccount(request.credentials().account.id, { mustChangePassword: true });
  expect((await request(app).get('/api/classroom')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
});

test('overview includes only the assigned class allowlist and its active child count', async () => {
  const own = await room(); const other = await room('PRIVATE OTHER CLASS');
  await child(own); await child(own, { active: false }); await child(other);
  await viewer(own);
  const data = await get();
  expect(data).toEqual({ state: 'assigned', room: { id: own.id, name: own.name, capacity: 220, ageMinMonths: 24, ageMaxMonths: 60 },
    today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), timeZone: expect.any(String), activeChildCount: 1 });
  expect(JSON.stringify(data)).not.toContain('PRIVATE');
});

test('children include every assigned active record across pages with no private fields', async () => {
  const own = await room(); const other = await room();
  for (let index = 0; index < 205; index++) await child(own, { firstName: 'Child ' + index, preferredName: index ? null : 'Sunny' });
  await child(other, { firstName: 'PRIVATE OTHER CHILD' }); await child(own, { active: false });
  await viewer(own);
  const list = jest.spyOn(db, 'listChildren');
  try {
    const data = await get('/children');
    expect(data.total).toBe(205); expect(data.items).toHaveLength(205);
    expect(new Set(data.items.map((row) => row.id)).size).toBe(205);
    for (const row of data.items) expect(Object.keys(row).sort()).toEqual(['firstName', 'id', 'lastName', 'preferredName']);
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE|dateOfBirth|notes|attendance|document/);
    expect(list).toHaveBeenCalledWith({ roomId: own.id, active: true, page: 2, pageSize: 200 });
  } finally { list.mockRestore(); }
});

test.each(['unassigned', 'unavailable'])('%s class returns no global children, activities or meals', async (state) => {
  const own = await room('PRIVATE ARCHIVED CLASS');
  await child(own); await schedule(own);
  await db.saveWeeklyPlan({ weekStart, week: [{ day: 'Monday', menu: { breakfast: { name: 'PRIVATE SAVED MEAL', type: 'breakfast' } } }] }, 0);
  await viewer(state === 'unassigned' ? null : own);
  if (state === 'unavailable') await db.updateRoom(own.id, { active: false });
  expect(await get()).toMatchObject({ state, room: null, activeChildCount: 0 });
  expect(await get('/children')).toEqual({ state, room: null, items: [], total: 0 });
  expect(await get('/activities?weekStart=' + weekStart)).toMatchObject({ state, room: null, entries: [], hasPlan: false, version: 0, savedAt: null });
  expect(await get('/meals?weekStart=' + weekStart)).toMatchObject({ state, room: null, week: [], hasPlan: false });
});

test('an incomplete active room remains a valid explicit class assignment', async () => {
  const own = await room('Legacy class');
  await viewer(own);
  // A projection should not invent configuration for historical data. Current
  // PostgreSQL constraints prohibit inserting this legacy shape as a new row.
  const lookup = jest.spyOn(db, 'getRoomById').mockResolvedValue({ ...own, ageMinMonths: null, ageMaxMonths: null, capacity: null });
  try { expect((await get()).room).toEqual({ id: own.id, name: 'Legacy class', ageMinMonths: null, ageMaxMonths: null, capacity: null }); }
  finally { lookup.mockRestore(); }
});

test('an assignment whose room cannot be resolved fails closed without reading children', async () => {
  const own = await room(); await viewer(own);
  const lookup = jest.spyOn(db, 'getRoomById').mockResolvedValue(null);
  const children = jest.spyOn(db, 'listChildren');
  try {
    expect(await get('/children')).toEqual({ state: 'unavailable', room: null, items: [], total: 0 });
    expect(children).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); children.mockRestore(); }
});

test('saved activities expose only assigned class snapshots, never stock, provenance or current private catalog details', async () => {
  const own = await room(); const other = await room();
  const [entry] = await schedule(own); await schedule(other);
  await viewer(own);
  const data = await get('/activities?weekStart=' + weekStart);
  expect(data).toMatchObject({ hasPlan: true, version: 1, weekStart, entries: [{ id: entry.id, date: weekStart,
    startTime: '09:00', endTime: '09:30', timeBlock: null, activity: { name: 'Saved class activity', description: 'Saved instructions', durationMinutes: 30 } }] });
  expect(data.entries).toHaveLength(1);
  expect(Object.keys(data.entries[0]).sort()).toEqual(['activity', 'date', 'endTime', 'id', 'startTime', 'timeBlock']);
  expect(JSON.stringify(data)).not.toMatch(/PRIVATE|material|activityId|roomId|requestId/);
});

test('activities without a saved week header do not expose orphan entries', async () => {
  const own = await room(); await schedule(own, { header: false }); await viewer(own);
  expect(await get('/activities?weekStart=' + weekStart)).toMatchObject({ hasPlan: false, version: 0, savedAt: null, entries: [] });
});

test('legacy activities without snapshots fall back to a linked name without its current description', async () => {
  const own = await room(); await schedule(own, { snapshot: false }); await viewer(own);
  expect((await get('/activities?weekStart=' + weekStart)).entries[0].activity)
    .toEqual({ name: 'Current catalog name', description: '', durationMinutes: null });
});

test('saved meals expose shared facility menu names only, in fixed day and slot order', async () => {
  const own = await room();
  await db.saveWeeklyPlan({ weekStart, childrenCount: 90, staffCount: 10, items: ['PRIVATE RECIPE'], inHouse: { privateStock: 99 },
    week: [{ day: 'Monday', menu: { lunch: { id: 'private-id', name: 'Saved lunch', type: 'lunch', ingredients: ['PRIVATE INGREDIENT'] },
      breakfast: { name: 'Saved breakfast', type: 'breakfast', notes: 'PRIVATE NOTES' }, unknown: { name: 'PRIVATE UNKNOWN SLOT' } } },
    { day: 'Sunday', menu: { breakfast: { name: 'PRIVATE WEEKEND MEAL' } } }] }, 0);
  await viewer(own);
  const data = await get('/meals?weekStart=' + weekStart);
  expect(data).toMatchObject({ scope: 'facility', hasPlan: true, version: 1, week: [
    { day: 'Monday', meals: [{ slot: 'breakfast', name: 'Saved breakfast', type: 'breakfast' }, { slot: 'lunch', name: 'Saved lunch', type: 'lunch' }] },
    { day: 'Tuesday', meals: [] }, { day: 'Wednesday', meals: [] }, { day: 'Thursday', meals: [] }, { day: 'Friday', meals: [] }] });
  expect(JSON.stringify(data)).not.toMatch(/PRIVATE|childrenCount|staffCount|inHouse|ingredient|recipe|previewToken/);
});

test('an unsaved dated meal week does not fall back to a legacy confirmed menu or generation', async () => {
  await db.saveConfirmedMenu({ week: [{ day: 'Monday', menu: { breakfast: { name: 'PRIVATE LEGACY MENU' } } }] });
  await viewer(await room());
  expect(await get('/meals?weekStart=' + weekStart)).toMatchObject({ hasPlan: false, version: 0, savedAt: null, week: [] });
});

test('unknown filters, duplicated dates and non-Monday dates cannot select or widen class scope', async () => {
  await viewer(await room());
  for (const suffix of ['?roomId=other', '/children?page=2', '/children?includeArchived=true', '/activities?weekStart=' + weekStart + '&roomId=other',
    '/activities', '/activities?weekStart=2026-10-20', '/activities?weekStart=2026-02-30',
    '/meals?weekStart=' + weekStart + '&weekStart=2026-10-26', '/meals?weekStart=' + weekStart + '&scope=all']) {
    expect((await request(app).get('/api/classroom' + suffix)).status).toBe(400);
  }
});

test('forged headers and GET bodies do not override the live assigned class', async () => {
  const own = await room(); const other = await room(); await child(other); await viewer(own);
  const response = await request(app).get('/api/classroom/children').set('X-Room-Id', other.id).send({ roomId: other.id });
  expect(response.status).toBe(200); expect(response.body.data).toMatchObject({ room: { id: own.id }, items: [], total: 0 });
});

test('class projection HEAD is supported, and every mutation is rejected without writing', async () => {
  const own = await room(); await viewer(own);
  const beforeAudits = await db.listAudit();
  for (const path of ['', '/children', '/activities?weekStart=' + weekStart, '/meals?weekStart=' + weekStart]) {
    expect((await request(app).head('/api/classroom' + path)).status).toBe(200);
    expect((await request(app).post('/api/classroom' + path).send({ roomId: own.id })).body.error.code).toBe('CLASSROOM_READ_ONLY');
  }
  expect(await db.countChildren()).toBe(0); expect(await db.listAudit()).toEqual(beforeAudits);
});

test('all operational reads, HEAD requests and draft generation remain closed to a Class viewer', async () => {
  await viewer(await room());
  const paths = ['/dashboard', '/reports', '/children', '/children/forged/profile', '/rooms', '/staff', '/staff-compliance',
    '/inventory', '/inventory/groups', '/activity', '/schedule/week', '/schedule/suggestions', '/schedule/plan', '/menu/week',
    '/menu/generate', '/menu/plans/' + weekStart, '/menu/plans/' + weekStart + '/shopping', '/shopping', '/shelf/final',
    '/meals', '/ingredients', '/purchasing/' + weekStart, '/attendance'];
  for (const path of paths) for (const method of ['get', 'head']) {
    const response = await request(app)[method]('/api' + path);
    expect({ path, method, status: response.status }).toEqual({ path, method, status: 403 });
    if (method === 'get') expect(response.body.error.code).toBe('CLASSROOM_ONLY');
  }
  for (const path of ['/schedule/plan/preview', '/schedule/plan/generate', '/shopping/generate',
    '/menu/plans/' + weekStart + '/preview', '/purchasing/' + weekStart + '/preview', '/meals/recipe-photo']) {
    expect((await request(app).post('/api' + path).send({ image: 'invalid' })).body.error.code).toBe('CLASSROOM_ONLY');
  }
});

test('operational middleware rechecks a role changed after the first session lookup', async () => {
  const current = await db.getAccount(request.credentials().account.id);
  await viewer(await room());
  const lookup = jest.spyOn(auth, 'sessionAccount').mockResolvedValueOnce(current);
  try { expect((await request(app).get('/api/children')).body.error.code).toBe('CLASSROOM_ONLY'); }
  finally { lookup.mockRestore(); }
});

test.each(['reassign', 'archive', 'revoke', 'role'])('projection waits for live authorization after a concurrent %s', async (change) => {
  const own = await room(); const other = await room('New class');
  await child(own, { firstName: 'Old child' }); await child(other, { firstName: 'New child' }); await viewer(own);
  let release; let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const blocker = db.withAuthLock(async () => {
    started(); await gate;
    if (change === 'reassign') await db.updateAccount(request.credentials().account.id, { roomId: other.id });
    if (change === 'archive') await db.updateRoom(own.id, { active: false });
    if (change === 'revoke') await db.revokeSessions(request.credentials().account.id);
    if (change === 'role') await db.updateAccount(request.credentials().account.id, { role: 'editor', roomId: null });
  });
  await entered;
  const pending = classroom.children(token());
  const rejection = change === 'revoke' ? expect(pending).rejects.toMatchObject({ status: 401 })
    : change === 'role' ? expect(pending).rejects.toMatchObject({ status: 403, code: 'CLASSROOM_VIEWER_ONLY' }) : null;
  release(); await blocker;
  if (rejection) await rejection;
  else {
    const result = await pending;
    expect(result).toMatchObject(change === 'archive' ? { state: 'unavailable', room: null, items: [] }
      : { room: { id: other.id }, items: [{ firstName: 'New child' }] });
    expect(JSON.stringify(result)).not.toContain('Old child');
  }
});

test('administrator and editor operational access remains available', async () => {
  const own = await room(); await child(own);
  expect((await request(app).get('/api/children')).status).toBe(200);
  await db.updateAccount(request.credentials().account.id, { role: 'editor' });
  expect((await request(app).get('/api/children')).status).toBe(200);
  expect((await request(app).get('/api/staff')).status).toBe(200);
  expect((await request(app).get('/api/classroom')).body.error.code).toBe('CLASSROOM_VIEWER_ONLY');
});
