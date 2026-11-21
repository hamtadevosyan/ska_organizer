const { randomUUID } = require('node:crypto');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const validation = require('../services/activityValidation');

const video = { title: 'Synthetic how-to example', publisher: 'Synthetic publisher', url: 'https://example.org/tutorial' };
const search = { title: 'Search YouTube for how-to videos', publisher: 'YouTube',
  url: 'https://www.youtube.com/results?search_query=preschool+color+sorting', kind: 'search' };
const create = (changes = {}) => request(app).post('/api/activity').send({ name: 'A complete activity', description: 'Prepare, demonstrate and practice.', durationMinutes: 20, ...changes });

test('how-to links survive library create, edit and reload without becoming material links', async () => {
  const created = await create({ tutorialLinks: [{ ...video, title: '  Synthetic how-to example  ' }] });
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({ tutorialLinks: [video], materials: [] });
  const { id } = created.body.data;
  const edited = await request(app).put('/api/activity/' + id).send({ name: 'An edited activity', version: 1 });
  expect(edited.status).toBe(200);
  expect(edited.body.data).toMatchObject({ version: 2, tutorialLinks: [video] });
  expect((await request(app).get('/api/activity')).body.data[0].tutorialLinks).toEqual([video]);
  expect((await db.getActivityById(id)).materialsLinks ?? []).toEqual([]);
  const cleared = await request(app).put('/api/activity/' + id).send({ tutorialLinks: [], version: 2 });
  expect(cleared.status).toBe(200);
  expect((await db.getActivityById(id)).tutorialLinks).toEqual([]);
});

test.each([['video example', video], ['video search', search]])('saved weeks preserve their %s when catalog links are edited or removed', async (label, link) => {
  const room = await db.createRoom({ name: 'Own class', active: true, capacity: 12, ageMinMonths: 24, ageMaxMonths: 60 });
  const created = await create({ tutorialLinks: [link] });
  expect(created.status).toBe(201);
  const saved = await request(app).post('/api/schedule/plan').send({ roomId: room.id, weekStart: '2026-10-19', version: 0, requestId: randomUUID(),
    entries: [{ id: randomUUID(), date: '2026-10-19', startTime: '09:00', endTime: '09:20', activityId: created.body.data.id }] });
  expect(saved.status).toBe(200);
  expect(saved.body.data.materials).toEqual([]);
  expect(saved.body.data.entries[0].activity.tutorialLinks).toEqual([link]);
  const cleared = await request(app).put('/api/activity/' + created.body.data.id).send({ tutorialLinks: [], version: 1 });
  expect(cleared.status).toBe(200);
  const loaded = await request(app).get('/api/schedule/plan').query({ roomId: room.id, weekStart: '2026-10-19' });
  expect(loaded.status).toBe(200);
  expect(loaded.body.data.entries[0].activity.tutorialLinks).toEqual([link]);
  expect(loaded.body.data.materials).toEqual([]);
});

test('a marked video search survives library edits, reloads and classroom snapshot projection', async () => {
  const room = await db.createRoom({ name: 'Own class', active: true, capacity: 12, ageMinMonths: 24, ageMaxMonths: 60 });
  const created = await create({ tutorialLinks: [search] });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  const edited = await request(app).put('/api/activity/' + id).send({ description: 'Reviewed instructions.', version: 1 });
  expect(edited.status).toBe(200);
  expect(edited.body.data.tutorialLinks).toEqual([search]);
  expect((await request(app).get('/api/activity')).body.data[0].tutorialLinks).toEqual([search]);
  const saved = await request(app).post('/api/schedule/plan').send({ roomId: room.id, weekStart: '2026-10-19', version: 0, requestId: randomUUID(),
    entries: [{ id: randomUUID(), date: '2026-10-19', startTime: '09:00', endTime: '09:20', activityId: id }] });
  expect(saved.status).toBe(200);
  const entries = await db.listScheduleEntries(room.id, '2026-10-19');
  entries[0].activitySnapshot.tutorialLinks = [{ ...search, privateField: 'PRIVATE LINK METADATA' }];
  await db.saveScheduleEntries(room.id, '2026-10-19', entries);
  await db.updateActivity(id, { tutorialLinks: [video] });
  await db.updateAccount(request.credentials().account.id, { role: 'viewer', roomId: room.id });
  const classroom = await request(app).get('/api/classroom/activities').query({ weekStart: '2026-10-19' });
  expect(classroom.status).toBe(200);
  expect(classroom.body.data.entries[0].activity.tutorialLinks).toEqual([search]);
  expect(JSON.stringify(classroom.body)).not.toContain('PRIVATE LINK METADATA');
});

test('search URLs normalize their single query and retain the existing metadata and URL bounds', async () => {
  const prefix = 'https://www.youtube.com/results?search_query=';
  const bounded = { ...search, title: 't'.repeat(150), publisher: 'p'.repeat(100), url: prefix + 'x'.repeat(500 - prefix.length) };
  const created = await create({ tutorialLinks: [bounded, { ...search, url: prefix + 'paper%20collage' }, video] });
  expect(created.status).toBe(201);
  expect(created.body.data.tutorialLinks).toEqual([bounded, { ...search, url: prefix + 'paper+collage' }, video]);
});

test.each(['字'.repeat(100), '🧩'.repeat(50)])('bounded generated Unicode search links can be saved: %s', async name => {
  const links = require('../services/activityVideoExamples').match({ name });
  const created = await create({ tutorialLinks: links });
  expect(created.status).toBe(201);
  expect(created.body.data.tutorialLinks).toEqual(links);
});

test('activities and snapshots without how-to links retain an empty compatible list', async () => {
  const created = await create();
  expect(created.status).toBe(201);
  expect(created.body.data.tutorialLinks).toEqual([]);
  expect(validation.snapshot({ id: 'old', name: 'Old saved activity' }).tutorialLinks).toEqual([]);
});

test.each([
  null, {}, 'https://example.org', Array(4).fill(video),
  [{ ...video, url: 'http://example.org/tutorial' }],
  [{ ...video, url: 'javascript:alert(1)' }],
  [{ ...video, url: 'data:text/html,test' }],
  [{ ...video, url: 'https://user:password@example.org/tutorial' }],
  [{ ...video, url: 'https://example.org/\nother' }],
  [{ ...video, url: 'https://example.org\\other' }],
  [{ ...video, url: 'https://' }],
  [{ ...video, url: 'https://example.org/' + 'x'.repeat(500) }],
  [{ ...video, url: 'https://example.org/' + '字'.repeat(100) }],
  [{ ...video, title: '' }], [{ ...video, title: 'x'.repeat(151) }], [{ ...video, title: '<img src=x>' }],
  [{ ...video, publisher: ' ' }], [{ ...video, publisher: 'x'.repeat(101) }], [{ ...video, publisher: 'Publisher\u0000' }],
  [{ ...video, html: '<iframe>' }], [video, video], [null],
  [{ ...search, kind: 'video' }], [{ ...search, kind: null }], [{ ...search, kind: false }],
  [{ ...search, kind: 'SEARCH' }], [{ ...search, extra: true }],
  [{ ...search, url: 'https://example.org/results?search_query=blocks' }],
  [{ ...search, url: 'https://youtube.com/results?search_query=blocks' }],
  [{ ...search, url: 'https://www.youtube.com.evil.invalid/results?search_query=blocks' }],
  [{ ...search, url: 'https://www.youtube.com:444/results?search_query=blocks' }],
  [{ ...search, url: 'https://www.youtube.com/watch?search_query=blocks' }],
  [{ ...search, url: 'https://www.youtube.com/results/?search_query=blocks' }],
  [{ ...search, url: 'https://www.youtube.com/results?q=blocks' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=++' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=blocks%0Aprivate' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=blocks&search_query=other' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=blocks&tracking=other' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=blocks#fragment' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=blocks#' }],
  [{ ...search, url: 'https://www.youtube.com/results?search_query=paper%20collage' },
    { ...search, url: 'https://www.youtube.com/results?search_query=paper+collage' }],
])('unsafe or malformed how-to links %j are rejected without saving', async (tutorialLinks) => {
  const response = await create({ tutorialLinks });
  expect(response.status).toBe(400);
  expect(response.body.error.fields).toHaveProperty('tutorialLinks');
  expect(await db.listActivities()).toEqual([]);
});

test('an invalid link edit leaves the previously saved activity unchanged', async () => {
  const created = await create({ tutorialLinks: [video] });
  expect(created.status).toBe(201);
  const response = await request(app).put('/api/activity/' + created.body.data.id).send({ tutorialLinks: [{ ...video, url: 'file:///private' }], version: 1 });
  expect(response.status).toBe(400);
  expect(await db.getActivityById(created.body.data.id)).toMatchObject({ version: 1, tutorialLinks: [video] });
});
