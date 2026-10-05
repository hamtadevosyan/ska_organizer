const request = require('./helpers/authenticatedRequest');
const anonymous = require('supertest');
const app = require('../index');
const db = require('../services/dbAdapter');

async function room(name, capacity = 4) {
  const response = await request(app).post('/api/rooms').send({ name, capacity, ageMinMonths: 18, ageMaxMonths: 72, active: true });
  expect(response.status).toBe(201);
  return response.body.data;
}

async function child(roomId, values = {}) {
  const response = await request(app).post('/api/children').send({
    firstName: 'Synthetic', lastName: 'Child', dateOfBirth: '2022-01-15', roomId, ...values,
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function roster(roomId, filters = {}) {
  const response = await request(app).get('/api/children').query({ roomId, active: 'true', ...filters });
  expect(response.status).toBe(200);
  return response.body;
}

async function summary(roomId) {
  const response = await request(app).get('/api/rooms/' + roomId);
  expect(response.status).toBe(200);
  return response.body.data;
}

const ids = (result) => result.items.map((item) => item.id).sort();

test('an empty room has an empty roster and each populated room includes only its assigned children', async () => {
  const empty = await room('Empty class', 3);
  const first = await room('First class', 5);
  const second = await room('Second class', 2);
  const firstChild = await child(first.id, { firstName: 'Alice' });
  const secondChild = await child(first.id, { firstName: 'Ben' });
  const otherChild = await child(second.id, { firstName: 'Cleo' });
  await child(null, { firstName: 'Unassigned' });

  expect(await roster(empty.id)).toMatchObject({ items: [], total: 0 });
  expect(await summary(empty.id)).toMatchObject({ id: empty.id, capacity: 3, assignedChildCount: 0, availablePlaces: 3 });
  expect(ids(await roster(first.id))).toEqual([firstChild.id, secondChild.id].sort());
  expect(ids(await roster(second.id))).toEqual([otherChild.id]);
  expect(await summary(first.id)).toMatchObject({ capacity: 5, assignedChildCount: 2, availablePlaces: 3 });
  expect(await summary(second.id)).toMatchObject({ capacity: 2, assignedChildCount: 1, availablePlaces: 1 });
});

test('children with identical names retain separate IDs and open their own profile and attendance', async () => {
  const target = await room('Same name class');
  const first = await child(target.id, { preferredName: 'Sunny', notes: 'First record.', dateOfBirth: '2022-01-15' });
  const second = await child(target.id, { preferredName: 'Star', notes: 'Second record.', dateOfBirth: '2023-02-16', confirmDuplicate: true });
  expect(second.id).not.toBe(first.id);
  const attendance = await db.createAttendance({ childId: first.id, roomId: target.id, checkIn: '2026-09-01T09:00:00Z' });

  const listed = await roster(target.id);
  expect(listed.total).toBe(2);
  expect(ids(listed)).toEqual([first.id, second.id].sort());
  for (const expected of [first, second]) {
    const response = await request(app).get('/api/children/' + expected.id + '/profile');
    expect(response.status).toBe(200);
    expect(response.body.child).toMatchObject({
      id: expected.id, preferredName: expected.preferredName, dateOfBirth: expected.dateOfBirth, notes: expected.notes,
    });
    expect(response.body.room.id).toBe(target.id);
    expect(response.body.recentAttendance).toEqual(expected.id === first.id
      ? [expect.objectContaining({ id: attendance.id, childId: first.id })] : []);
  }
});

test('preferred-name search and pagination stay within the selected room without changing its assigned count', async () => {
  const target = await room('Search class');
  const other = await room('Other search class');
  const sunny = await child(target.id, { firstName: 'Alice', preferredName: 'Sunny' });
  const ben = await child(target.id, { firstName: 'Ben' });
  await child(other.id, { firstName: 'Cleo', preferredName: 'Sunny' });

  const searched = await roster(target.id, { q: 'SUNNY', page: 1, pageSize: 1 });
  expect(searched).toMatchObject({ total: 1, page: 1, pageSize: 1 });
  expect(ids(searched)).toEqual([sunny.id]);
  const firstPage = await roster(target.id, { page: 1, pageSize: 1 });
  const secondPage = await roster(target.id, { page: 2, pageSize: 1 });
  expect(firstPage.total).toBe(2);
  expect(secondPage.total).toBe(2);
  expect([...ids(firstPage), ...ids(secondPage)].sort()).toEqual([sunny.id, ben.id].sort());
  expect((await roster(target.id, { q: 'No matching child' })).items).toEqual([]);
  expect(await summary(target.id)).toMatchObject({ assignedChildCount: 2, capacity: 4, availablePlaces: 2 });
});

test('inactive children appear only when requested and never occupy active assigned places', async () => {
  const target = await room('Enrollment class', 2);
  const active = await child(target.id, { firstName: 'Active' });
  const inactive = await child(target.id, { firstName: 'Ended', active: false });
  const other = await room('Other enrollment class');
  await child(other.id, { firstName: 'Other ended', active: false });

  expect(ids(await roster(target.id))).toEqual([active.id]);
  expect(ids(await roster(target.id, { active: 'all' }))).toEqual([active.id, inactive.id].sort());
  expect(ids(await roster(target.id, { active: 'false' }))).toEqual([inactive.id]);
  expect(await summary(target.id)).toMatchObject({ assignedChildCount: 1, capacity: 2, availablePlaces: 1 });
  const profile = await request(app).get('/api/children/' + inactive.id + '/profile');
  expect(profile.status).toBe(200);
  expect(profile.body.child).toMatchObject({ id: inactive.id, active: false, roomId: target.id });
});

test('transfer, enrollment end and reactivation update both rosters while preserving child and attendance IDs', async () => {
  const original = await room('Original class');
  const destination = await room('Destination class');
  const enrolled = await child(original.id);
  const attendance = await db.createAttendance({ childId: enrolled.id, roomId: original.id, checkIn: '2026-09-01T09:00:00Z' });
  const path = '/api/children/' + enrolled.id;

  const transferred = await request(app).put(path + '/room').send({ roomId: destination.id });
  expect(transferred.status).toBe(200);
  expect(transferred.body).toMatchObject({ id: enrolled.id, roomId: destination.id, active: true });
  expect(ids(await roster(original.id))).toEqual([]);
  expect(ids(await roster(destination.id))).toEqual([enrolled.id]);
  expect((await summary(original.id)).assignedChildCount).toBe(0);
  expect((await summary(destination.id)).assignedChildCount).toBe(1);

  const ended = await request(app).put(path + '/enrollment').send({ active: false });
  expect(ended.status).toBe(200);
  expect(ended.body).toMatchObject({ id: enrolled.id, active: false, roomId: destination.id });
  expect(ids(await roster(destination.id))).toEqual([]);
  expect(ids(await roster(destination.id, { active: 'all' }))).toEqual([enrolled.id]);
  expect((await summary(destination.id)).assignedChildCount).toBe(0);

  const reactivated = await request(app).put(path + '/enrollment').send({ active: true });
  expect(reactivated.status).toBe(200);
  expect(reactivated.body).toMatchObject({ id: enrolled.id, active: true, roomId: destination.id });
  expect(ids(await roster(destination.id))).toEqual([enrolled.id]);
  expect(ids(await roster(original.id))).toEqual([]);
  expect((await summary(destination.id)).assignedChildCount).toBe(1);
  expect((await summary(original.id)).assignedChildCount).toBe(0);
  expect(await db.getChildById(enrolled.id)).toMatchObject({ id: enrolled.id, active: true, roomId: destination.id });
  const profile = await request(app).get(path + '/profile');
  expect(profile.status).toBe(200);
  expect(profile.body.child.id).toBe(enrolled.id);
  expect(profile.body.room.id).toBe(destination.id);
  expect(profile.body.recentAttendance).toEqual([expect.objectContaining({ id: attendance.id, childId: enrolled.id, roomId: original.id })]);
});

test('room summaries, filtered rosters and child profiles require sign-in', async () => {
  const target = await room('Private class');
  const enrolled = await child(target.id);
  for (const path of ['/api/rooms/' + target.id, '/api/children?roomId=' + target.id + '&active=all', '/api/children/' + enrolled.id + '/profile']) {
    const response = await anonymous(app).get(path);
    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('data');
    expect(response.body).not.toHaveProperty('items');
    expect(response.body).not.toHaveProperty('child');
  }
});

test('viewers can read a room roster and profile but cannot change its children, assignments or settings', async () => {
  const target = await room('Viewer class');
  const other = await room('Viewer destination');
  const enrolled = await child(target.id);
  const { account } = request.credentials();
  await db.updateAccount(account.id, { role: 'viewer' });

  expect(ids(await roster(target.id))).toEqual([enrolled.id]);
  expect((await summary(target.id)).assignedChildCount).toBe(1);
  expect((await request(app).get('/api/children/' + enrolled.id + '/profile')).status).toBe(200);
  expect((await request(app).put('/api/children/' + enrolled.id).send({ firstName: 'Forbidden' })).status).toBe(403);
  expect((await request(app).put('/api/children/' + enrolled.id + '/room').send({ roomId: other.id })).status).toBe(403);
  expect((await request(app).put('/api/children/' + enrolled.id + '/enrollment').send({ active: false })).status).toBe(403);
  expect((await request(app).put('/api/rooms/' + target.id).send({ capacity: 1 })).status).toBe(403);
  expect(await db.getChildById(enrolled.id)).toMatchObject({ id: enrolled.id, firstName: 'Synthetic', roomId: target.id, active: true });
  expect(ids(await roster(target.id))).toEqual([enrolled.id]);
  expect(ids(await roster(other.id))).toEqual([]);
  expect(await summary(target.id)).toMatchObject({ assignedChildCount: 1, capacity: 4 });
});
