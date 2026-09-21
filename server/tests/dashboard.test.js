const { randomUUID } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const time = require('../services/facilityTime');
const dashboard = (date) => request(app).get('/api/dashboard').query(date ? { date } : {});
const room = () => db.createRoom({ name: 'Dashboard room', capacity: 100, ageMinMonths: 12, ageMaxMonths: 72 });
const child = (values = {}) => db.createChild({ firstName: 'Synthetic', lastName: 'Dashboard', active: true, ...values });
afterEach(() => jest.restoreAllMocks());

test('empty storage shows truthful zeros, no plans or sample events, and the facility date', async () => {
  const response = await dashboard();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toMatchObject({ today: time.dateAt(response.body.takenAt), date: time.dateAt(response.body.takenAt), timeZone: time.timeZone(),
    totalStudents: 0, totalStaff: 0, inventoryCount: 0, sections: {
      enrollment: { data: { count: 0 } }, attendance: { data: { count: 0, reviewRequired: false } }, staff: { data: { count: 0 } },
      inventory: { data: { total: 0, low: 0, out: 0 } }, meals: { data: { savedAt: null, items: [] } },
      activities: { data: { rooms: [] } }, changes: { data: [] },
    } });
  expect(await db.getWeeklyPlan(response.body.weekStart)).toBeNull();
});

test('counts use all enrolled children and active staff, and stock thresholds never double-count zero amounts', async () => {
  await db.withTransaction(async () => {
    for (let index = 0; index < 55; index++) await child({ lastName: 'Child ' + index });
  });
  const inactive = await child({ active: false });
  const teacher = await db.createStaff({ name: 'Teacher', role: 'Teacher', active: true });
  await db.createStaff({ name: 'Former teacher', role: 'Teacher', active: false });
  const group = await db.createInventoryGroup({ name: 'Dashboard supplies', nameKey: 'dashboard supplies', kind: 'supplies' });
  const quantities = [['0', '0'], ['0', '5'], ['0.000001', '0.000001'], ['2', '2'], ['2.000001', '2']];
  for (const [quantity, reorderThreshold] of quantities) await db.createInventory({ name: 'Stock ' + quantity + reorderThreshold,
    groupId: group.id, category: group.name, location: 'Cupboard', unit: 'count', quantity, reorderThreshold });
  const first = await dashboard('2026-09-14');
  expect(first.body).toMatchObject({ totalStudents: 55, totalStaff: 1, inventoryCount: 5,
    sections: { inventory: { data: { total: 5, low: 2, out: 2 } } } });
  await db.updateChild(inactive.id, { active: true });
  await db.updateStaff(teacher.id, { active: false });
  expect((await dashboard()).body).toMatchObject({ totalStudents: 56, totalStaff: 0 });
});

test('present now follows current open visits, ignores voided visits, and flags uncertain headcounts', async () => {
  const target = await room(); const person = await child({ roomId: target.id });
  const first = await db.createAttendance({ childId: person.id, roomId: target.id, checkIn: new Date().toISOString(), checkOut: null });
  expect((await dashboard('2025-01-01')).body.sections.attendance.data).toEqual({ count: 1, reviewRequired: false });
  await db.updateAttendance(first.id, { checkOut: new Date().toISOString() });
  expect((await dashboard()).body.sections.attendance.data.count).toBe(0);
  const current = await db.createAttendance({ childId: person.id, roomId: target.id, checkIn: new Date().toISOString() });
  const duplicate = await db.createAttendance({ childId: person.id, roomId: target.id, checkIn: new Date().toISOString(), needsReview: true });
  expect((await dashboard()).body.sections.attendance.data).toEqual({ count: null, reviewRequired: true });
  await db.updateAttendance(duplicate.id, { voided: true });
  expect((await dashboard()).body.sections.attendance.data.count).toBe(1);
  for (const values of [
    { checkIn: new Date(Date.now() - 2 * 86400000).toISOString() },
    { checkIn: new Date(Date.now() + 86400000).toISOString() },
    { checkIn: null, needsReview: true },
    { checkIn: new Date().toISOString(), needsReview: true },
  ]) {
    await db.updateAttendance(current.id, values);
    expect((await dashboard()).body.sections.attendance.data).toEqual({ count: null, reviewRequired: true });
  }
});

test('date selection reads saved meal and activity snapshots, includes weekends and never changes storage', async () => {
  const target = await room(); const emptyRoom = await db.createRoom({ name: 'Empty room', active: true, capacity: 10, ageMinMonths: 12, ageMaxMonths: 72 });
  const savedMeal = await db.createMeal({ name: 'Saved breakfast', type: 'breakfast' });
  const snapshot = { weekStart: '2026-09-14', week: [{ day: 'Monday', menu: { breakfast: savedMeal } }], items: [], inHouse: {}, recipes: {} };
  const plan = await db.saveWeeklyPlan(snapshot, 0);
  await db.updateMeal(savedMeal.id, { name: 'Changed catalog name', archived: true });
  const activity = await db.createActivity({ name: 'Saved reading', durationMinutes: 20 });
  const rows = [
    { id: randomUUID(), date: '2026-09-14', startTime: '15:00', endTime: '15:20', activityId: activity.id, activitySnapshot: activity },
    { id: randomUUID(), date: '2026-09-14', startTime: '08:00', endTime: '08:20', activityId: activity.id, activitySnapshot: activity },
    { id: randomUUID(), date: '2026-09-20', timeBlock: 'morning', activityId: activity.id, activitySnapshot: activity },
  ];
  await db.saveScheduleEntries(target.id, '2026-09-14', rows);
  await db.saveScheduleWeek({ roomId: target.id, weekStart: '2026-09-14', version: 1, savedAt: new Date().toISOString() });
  await db.updateActivity(activity.id, { name: 'Changed activity catalog' });
  const auditBefore = await db.listAudit();
  const entriesBefore = await db.listScheduleEntries(target.id, '2026-09-14');
  const monday = (await dashboard('2026-09-14')).body;
  expect(monday.sections.meals.data.items).toEqual([{ slot: 'breakfast', label: 'Breakfast', name: 'Saved breakfast' }]);
  expect(monday.sections.activities.data.rooms.find((r) => r.id === target.id).entries.map((e) => [e.startTime, e.name]))
    .toEqual([['08:00', 'Saved reading'], ['15:00', 'Saved reading']]);
  expect(monday.sections.activities.data.rooms.find((r) => r.id === emptyRoom.id).entries).toEqual([]);
  await db.updateRoom(target.id, { active: false });
  const sunday = (await dashboard('2026-09-20')).body;
  expect(sunday.weekStart).toBe('2026-09-14');
  expect(sunday.sections.meals.data.items).toEqual([]);
  expect(sunday.sections.activities.data.rooms.find((r) => r.id === target.id)).toMatchObject({ active: false, entries: [{ name: 'Saved reading', timeBlock: 'morning' }] });
  const next = (await dashboard('2026-09-21')).body;
  expect(next.sections.meals.data).toEqual({ savedAt: null, items: [] });
  expect(next.sections.activities.data.rooms.map((r) => r.id)).toEqual([emptyRoom.id]);
  expect(await db.getWeeklyPlan('2026-09-14')).toEqual(plan);
  expect(await db.getWeeklyPlan('2026-09-21')).toBeNull();
  expect(await db.listScheduleEntries(target.id, '2026-09-14')).toEqual(entriesBefore);
  expect(await db.listAudit()).toEqual(auditBefore);
});

test('recent changes filter operational events before pagination and expose only safe summaries', async () => {
  const created = await request(app).post('/api/staff').send({ name: 'Private name', role: 'Teacher', active: true, roomId: null });
  expect(created.status).toBe(201);
  expect((await dashboard()).body.sections.changes.data[0]).toMatchObject({ label: 'Staff member added', href: '/staff' });
  await db.withTransaction(async () => {
    for (let index = 0; index < 12; index++) await db.appendAudit({ id: 'event-' + index, action: 'inventory.adjust', entityId: 'private-id',
      actorId: request.credentials().account.id, actorUsername: 'private-user', occurredAt: new Date(Date.now() + index * 1000).toISOString() });
    for (let index = 0; index < 55; index++) await db.appendAudit({ actorUsername: 'private-user', action: 'account.reset_password', occurredAt: new Date(Date.now() + 60000).toISOString() });
  });
  const changes = (await dashboard()).body.sections.changes.data;
  expect(changes).toHaveLength(10);
  expect(changes[0].id).toBe('event-11');
  expect(changes.at(-1).id).toBe('event-2');
  for (const event of changes) expect(Object.keys(event).sort()).toEqual(['href', 'id', 'label', 'occurredAt']);
  expect(JSON.stringify(changes)).not.toMatch(/private-|password|account\./);
});

test('section failures omit their totals, preserve other sections, redact errors and recover on refresh', async () => {
  for (const [method, section] of [['countChildren', 'enrollment'], ['listAttendance', 'attendance'], ['countStaff', 'staff'],
    ['countInventory', 'inventory'], ['getWeeklyPlan', 'meals'], ['listRooms', 'activities'], ['listAudit', 'changes']]) {
    const failed = jest.spyOn(db, method).mockRejectedValueOnce(new Error('Private connection details'));
    const response = await dashboard();
    expect(response.status).toBe(200);
    expect(response.body.sections[section].error).toMatch(/^Could not load/);
    expect(response.body.sections[section]).not.toHaveProperty('data');
    expect(Object.values(response.body.sections).filter((value) => value.error)).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('Private');
    if (section === 'staff') expect(response.body).not.toHaveProperty('totalStaff');
    failed.mockRestore();
    expect((await dashboard()).body.sections[section]).toHaveProperty('data');
  }
});

test('only signed-in operational users can read, and invalid dates and unsupported filters are rejected', async () => {
  expect((await anonymous(app).get('/api/dashboard')).status).toBe(401);
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await dashboard()).status).toBe(200);
  for (const query of [{ date: '2026-02-30' }, { date: '' }, { date: ['2026-09-14', '2026-09-15'] }, { roomId: 'room' }]) {
    expect((await request(app).get('/api/dashboard').query(query)).status).toBe(400);
  }
  await db.updateAccount(request.credentials().account.id, { disabled: true });
  expect((await dashboard()).status).toBe(401);
});
