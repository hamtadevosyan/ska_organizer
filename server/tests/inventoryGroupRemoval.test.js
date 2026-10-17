const { randomUUID, createHash } = require('node:crypto');
const anonymous = require('supertest');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');
const db = require('../services/dbAdapter');
const service = require('../services/inventoryGroupService');
const { amount } = require('../services/inventoryValidation');
const time = require('../services/facilityTime');
const auth = require('../auth/service');
const sessionConfig = require('../auth/config');

// Only inventory fixture time is fixed. A paused VM or wall-clock adjustment
// must not turn an inventory assertion into an unrelated session/token expiry.
// Install before the shared per-test login hook; keep HTTP, PostgreSQL and Jest
// deadlines, scheduling, monotonic clocks and Intl on their real implementations.
const realNow = Date.now.bind(Date);
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
  nextTick: process.nextTick, hrtime: process.hrtime, performance, queueMicrotask, Intl };
beforeAll(() => {
  jest.useFakeTimers({ now: realNow(), doNotFake: [
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
    'nextTick', 'hrtime', 'performance', 'queueMicrotask', 'Intl',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  ] });
});
afterAll(() => { jest.useRealTimers(); });

async function sessionDiagnostic() {
  // Never include cookies, tokens, IDs, SQL or credentials in a test failure.
  const cookie = request.credentials().cookie;
  const session = await db.getSession(auth.digest(cookie.slice(cookie.indexOf('=') + 1)));
  const account = session ? await db.getAccount(session.accountId) : null;
  const now = Date.now();
  const idleMs = session?.remembered ? sessionConfig.rememberIdleMs : sessionConfig.idleMs;
  const absoluteMs = session?.remembered ? sessionConfig.rememberAbsoluteMs : sessionConfig.absoluteMs;
  return { sessionPresent: !!session, accountPresent: !!account, accountDisabled: !!account?.disabled,
    idleExpired: !!session && new Date(session.lastSeenAt).getTime() + idleMs <= now,
    absoluteExpired: !!session && (new Date(session.expiresAt).getTime() <= now || new Date(session.createdAt).getTime() + absoluteMs <= now) };
}

const base = '/api/inventory';
let source, target, food, first, second;
async function api(method, path, body, status = 200) {
  const response = await request(app)[method](path).send(body);
  if (response.status === 401 && status !== 401) {
    let diagnostic;
    try { diagnostic = await sessionDiagnostic(); } catch { diagnostic = { unavailable: true }; }
    throw new Error('Unexpected authentication failure in inventory fixture: ' + JSON.stringify({
      code: response.body.error?.code, ...diagnostic,
    }));
  }
  expect({ status: response.status, error: response.body.error }).toEqual({ status, error: status >= 400 ? expect.anything() : undefined });
  return response.body.data;
}
async function group(name, kind = 'supplies') {
  return api('post', base + '/groups', { name, kind, requestId: randomUUID() }, 201);
}
async function item(name, groupId = source.id, changes = {}) {
  return api('post', base, { name, groupId, location: name + ' shelf', unit: 'count', ingredientId: null,
    openingQuantity: '3.125', reorderThreshold: '5', reason: 'Physical opening count', requestId: randomUUID(), ...changes }, 201);
}
const path = (groupId = source.id) => base + '/groups/' + groupId;
const context = (groupId) => api('get', path(groupId) + '/removal-context');
async function preview(action, changes = {}, groupId = source.id) {
  const current = await context(groupId);
  return api('post', path(groupId) + '/removal-preview', { action, contextVersion: current.contextVersion,
    ...(action === 'move' ? { targetGroupId: target.id, targetVersion: target.version } : {}),
    ...(action === 'archive' ? { reason: 'Retained supplies are no longer in active use' } : {}), ...changes });
}
const body = (review, changes = {}) => ({ requestId: randomUUID(), reviewToken: review.reviewToken, acknowledgeRetainedStock: review.action === 'archive', ...changes });
const commit = (values, status = 201, groupId = source.id) => api('post', path(groupId) + '/removal', values, status);
async function unchanged(before) {
  expect(await db.getInventoryById(first.id)).toEqual(before.first);
  expect(await db.getInventoryById(second.id)).toEqual(before.second);
  expect(await db.getInventoryGroupById(source.id)).toEqual(before.source);
}
const beforeState = async () => ({ first: await db.getInventoryById(first.id), second: await db.getInventoryById(second.id), source: await db.getInventoryGroupById(source.id) });

beforeEach(async () => {
  source = await group('Synthetic source'); target = await group('Synthetic destination'); food = await group('Synthetic food', 'food');
  first = await item('First retained item'); second = await item('Second retained item', source.id, { openingQuantity: '0', unit: 'pack' });
});

test('fixture Date stays stable while real asynchronous work and deadlines continue', async () => {
  const now = Date.now(), monotonicStarted = process.hrtime.bigint();
  expect({ setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    nextTick: process.nextTick, hrtime: process.hrtime, performance, queueMicrotask, Intl }).toEqual(realTimers);
  await new Promise(resolve => setTimeout(resolve, 25));
  await new Promise(resolve => setImmediate(resolve));
  expect(process.hrtime.bigint() - monotonicStarted).toBeGreaterThanOrEqual(20000000n);
  expect(Date.now()).toBe(now);
  expect(new Date().getTime()).toBe(now);
  expect((await context()).source.id).toBe(source.id);
});

test.each(['idle', 'absolute', 'revoked', 'disabled'])('a deliberately %s fixture session still fails with 401 and never signs in automatically', async (kind) => {
  const credentials = request.credentials();
  const sessionId = auth.digest(credentials.cookie.slice(credentials.cookie.indexOf('=') + 1));
  const beforeSignIns = await db.listAudit({ actions: ['session.sign_in'] });
  if (kind === 'idle') await db.updateSession(sessionId, { lastSeenAt: new Date(Date.now() - sessionConfig.idleMs - 1000) });
  if (kind === 'absolute') await db.updateSession(sessionId, { expiresAt: new Date(Date.now() - 1000) });
  if (kind === 'revoked') await db.deleteSession(sessionId);
  if (kind === 'disabled') await db.updateAccount(credentials.account.id, { disabled: true });
  const response = await request(app).get(path() + '/removal-context');
  expect(response.status).toBe(401); expect(response.body.error.code).toBe('SESSION_EXPIRED');
  let failure;
  try { await context(); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(failure.message).toContain('Unexpected authentication failure in inventory fixture:');
  expect(failure.message).toContain('SESSION_EXPIRED');
  expect(failure.message).toContain(JSON.stringify(kind === 'revoked' ? { sessionPresent: false } :
    kind === 'disabled' ? { accountDisabled: true } : kind === 'idle' ? { idleExpired: true } : { absoluteExpired: true }).slice(1, -1));
  expect(failure.message).not.toContain(credentials.cookie);
  expect(failure.message).not.toContain(credentials.csrf);
  expect(request.credentials().cookie).toBe(credentials.cookie);
  expect(await db.listAudit({ actions: ['session.sign_in'] })).toEqual(beforeSignIns);
});

test('opening, previewing and canceling a removal have no writes; context includes complete member balances and compatible destinations', async () => {
  const before = await beforeState();
  const opened = await context();
  expect(opened).toMatchObject({ source: { id: source.id, archived: false, deletedAt: null, version: 1 }, itemCount: 2, nonzeroCount: 1,
    totals: [{ unit: 'count', quantity: '3.125' }, { unit: 'pack', quantity: '0' }] });
  expect(opened.contextVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(opened.destinations.map((value) => value.id)).toContain(target.id);
  expect(opened.destinations.map((value) => value.id)).not.toContain(food.id);
  expect(opened.destinations.map((value) => value.id)).not.toContain(source.id);
  const reviewed = await preview('move');
  expect(reviewed).toMatchObject({ action: 'move', target: { id: target.id }, itemCount: 2, nonzeroCount: 1 });
  expect(reviewed.reviewToken.length).toBeLessThan(2000);
  expect(Date.parse(reviewed.expiresAt) - Date.now()).toBeGreaterThan(590000);
  await unchanged(before);
  expect(await db.countInventoryMovements(first.id)).toBe(1);
  expect(await db.getInventoryGroupOperationByRequestId(randomUUID())).toBeNull();
});

test('only an entirely empty group can be removed; its tombstone and original create retry never resurrect it', async () => {
  const requestId = randomUUID();
  const original = { name: 'Disposable empty group', kind: 'supplies', requestId };
  const empty = await api('post', base + '/groups', original, 201);
  const reviewed = await preview('delete', {}, empty.id);
  const receipt = await commit(body(reviewed), 201, empty.id);
  expect(receipt).toMatchObject({ action: 'delete', sourceBefore: { id: empty.id, deletedAt: null }, sourceAfter: { id: empty.id, deletedAt: expect.any(String), version: 2 }, itemCount: 0, members: [], replayed: false });
  const groups = await request(app).get(base + '/groups');
  expect(groups.body.items.map((value) => value.id)).not.toContain(empty.id);
  const repeated = await api('post', base + '/groups', original, 201);
  expect(repeated).toMatchObject({ id: empty.id, deletedAt: receipt.sourceAfter.deletedAt, replayed: true });
  expect((await api('post', base + '/groups', { ...original, requestId: randomUUID() }, 201)).id).not.toBe(empty.id);
  await api('get', path(empty.id) + '/removal-context', undefined, 409);
  await api('post', path() + '/removal-preview', { action: 'delete', contextVersion: (await context()).contextVersion }, 409);
});

test('atomic move preserves every raw balance and historical snapshot, then retains the removed source identity', async () => {
  const before = await beforeState();
  const originalHistory = await db.listInventoryMovements(first.id);
  const reviewed = await preview('move'); const receipt = await commit(body(reviewed));
  expect(receipt).toMatchObject({ action: 'move', sourceBefore: { id: source.id }, sourceAfter: { deletedAt: expect.any(String), version: 2 },
    target: { id: target.id }, actorId: request.credentials().account.id, actorUsername: 'test-admin', itemCount: 2 });
  for (const previous of [before.first, before.second]) {
    const saved = await db.getInventoryById(previous.id);
    expect(saved).toMatchObject({ groupId: target.id, category: target.name, version: previous.version + 1, quantity: previous.quantity,
      unit: previous.unit, location: previous.location, ingredientId: previous.ingredientId, archived: false });
    const movements = await db.listInventoryMovements(previous.id);
    expect(movements[0]).toMatchObject({ groupOperationId: receipt.id, type: 'details', itemVersion: 2 });
    expect(amount(movements[0].delta)).toBe(0n);
    expect(amount(movements[0].beforeQuantity)).toBe(amount(movements[0].afterQuantity));
    expect(movements[0].before).toMatchObject({ groupId: source.id });
    expect(movements[0].after).toMatchObject({ groupId: target.id });
  }
  expect((await db.listInventoryMovements(first.id)).slice(1)).toEqual(originalHistory);
  expect((await db.getInventoryGroupById(source.id)).deletedAt).toBeTruthy();
  expect((await db.listInventoryInGroup(source.id))).toHaveLength(0);
  expect((await api('get', base + '/group-operations/' + receipt.id))).toEqual(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'replayed')));
  const events = await db.listAudit({ actions: ['inventory.group.remove'] });
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ entityId: receipt.id, actorId: request.credentials().account.id });
});

test('archive keeps exact balances and receipts readable while active lists, counts and new writes exclude all archived records', async () => {
  const purchase = { quantity: '1', unit: first.unit, receivedOn: time.dateAt(), supplier: null, totalCost: null,
    reason: 'Goods before archival', version: 1, requestId: randomUUID() };
  await api('post', base + '/' + first.id + '/purchases', purchase, 201);
  const before = await beforeState(); const receipts = await db.listPurchaseReceipts({ itemId: first.id });
  const receipt = await commit(body(await preview('archive')));
  for (const previous of [before.first, before.second]) {
    const row = await db.getInventoryById(previous.id);
    expect(row).toMatchObject({ quantity: previous.quantity, unit: previous.unit, location: previous.location, groupId: source.id,
      ingredientId: previous.ingredientId, archived: true, version: previous.version + 1 });
    const historyResponse = await request(app).get(base + '/' + row.id + '/movements');
    expect(historyResponse.status).toBe(200);
    const history = historyResponse.body;
    expect(history.items[0]).toMatchObject({ groupOperationId: receipt.id, delta: '0', after: { archived: true, quantity: receipt.members.find((value) => value.before.id === row.id).before.quantity } });
    await api('post', base + '/' + row.id + '/movements', { type: 'addition', quantity: '1', unit: row.unit, version: row.version, reason: 'Must reject', requestId: randomUUID() }, 409);
    await api('put', base + '/' + row.id, { name: 'Must reject', version: row.version, reason: 'Must reject', requestId: randomUUID() }, 409);
    await api('post', base + '/' + row.id + '/purchases', { ...purchase, unit: row.unit, version: row.version, requestId: randomUUID() }, 409);
  }
  const active = await request(app).get(base + '/items'); const archived = await request(app).get(base + '/items?archived=true');
  expect(active.body).toMatchObject({ total: 0, items: [], summary: { total: 0 } });
  expect(archived.body.total).toBe(2); expect(archived.body.items.every((value) => value.archived)).toBe(true);
  expect((await request(app).get(base + '/groups')).body.items.map((value) => value.id)).not.toContain(source.id);
  expect((await request(app).get(base + '/groups?archived=true')).body.items).toMatchObject([{ id: source.id, archived: true, summary: { total: 2 } }]);
  expect(await db.listPurchaseReceipts({ itemId: first.id })).toEqual(receipts);
  expect((await api('get', base + '/' + first.id)).archived).toBe(true);
  await api('post', base, { name: 'Forbidden archived assignment', groupId: source.id, location: 'Shelf', unit: 'count', openingQuantity: '1',
    reason: 'Must reject', requestId: randomUUID() }, 409);
  await api('post', base, { name: 'Forbidden category assignment', category: source.name, location: 'Shelf', unit: 'count', openingQuantity: '1',
    reason: 'Must reject', requestId: randomUUID() }, 409);
  expect(await api('post', base + '/' + first.id + '/purchases', purchase, 201)).toMatchObject({ replayed: true });
});

test('archiving nonzero quantities requires both a reason and a separate explicit acknowledgement', async () => {
  const before = await beforeState(), current = await context();
  await api('post', path() + '/removal-preview', { action: 'archive', contextVersion: current.contextVersion }, 400);
  const reviewed = await preview('archive');
  await commit(body(reviewed, { acknowledgeRetainedStock: false }), 400);
  await unchanged(before);
  await db.updateInventory(first.id, { quantity: '0', version: 2 });
  const emptyStockReview = await preview('archive', { reason: '' });
  expect((await commit(body(emptyStockReview, { acknowledgeRetainedStock: false }))).action).toBe('archive');
});

test('a parent group lifecycle guard applies even if an inconsistent old item flag remains active', async () => {
  await db.updateInventoryGroup(source.id, { archived: true, archivedAt: new Date(), version: 2 });
  await api('post', base + '/' + first.id + '/movements', { type: 'addition', quantity: '1', unit: first.unit, version: 1, reason: 'Must reject', requestId: randomUUID() }, 409);
  expect((await db.getInventoryById(first.id)).archived).toBe(false);
  const rows = await request(app).get(base + '/items'); expect(rows.body.total).toBe(0);
});

test('full membership beyond the first fifty rows is reviewed, moved and recorded atomically; totals stay exact past one item limit', async () => {
  for (let index = 0; index < 60; index++) await db.createInventory({ name: 'Synthetic bulk ' + index, category: source.name,
    groupId: source.id, location: 'Shelf ' + index, unit: 'g', quantity: '999999999999.999999', reorderThreshold: '0', ingredientId: null, version: 1 });
  const current = await context();
  expect(current.itemCount).toBe(62);
  expect(current.totals.find((value) => value.unit === 'g').quantity).toBe('59999999999999.99994');
  const reviewed = await preview('move'); expect(reviewed.reviewToken.length).toBeLessThan(2000);
  const receipt = await commit(body(reviewed));
  expect(receipt.itemCount).toBe(62); expect(receipt.members).toHaveLength(62);
  expect(await db.listInventoryInGroup(source.id)).toHaveLength(0); expect(await db.listInventoryInGroup(target.id)).toHaveLength(62);
});

test.each(['added-member', 'removed-member', 'quantity-revision', 'renamed-member', 'source-version'])('panel-open %s changes require refresh before issuing a preview', async (kind) => {
  const current = await context();
  if (kind === 'added-member') await item('New after panel opened');
  if (kind === 'removed-member') await db.updateInventory(first.id, { groupId: target.id, category: target.name, version: 2 });
  if (kind === 'quantity-revision') await db.updateInventory(first.id, { quantity: '4', version: 2 });
  if (kind === 'renamed-member') await db.updateInventory(first.id, { name: 'Renamed item', version: 2 });
  if (kind === 'source-version') await db.updateInventoryGroup(source.id, { version: 2 });
  const result = await api('post', path() + '/removal-preview', { action: 'archive', reason: 'Review current members', contextVersion: current.contextVersion }, 409);
  expect(result).toBeUndefined();
  expect((await db.getInventoryGroupById(source.id)).archived).toBe(false);
});

test.each(['added-member', 'quantity-revision', 'target-version', 'target-archived', 'source-archived'])('reviewed %s changes reject commit without any partial lifecycle action', async (kind) => {
  const reviewed = await preview('move');
  if (kind === 'added-member') await item('Added after review');
  if (kind === 'quantity-revision') await db.updateInventory(first.id, { quantity: '4', version: 2 });
  if (kind === 'target-version') await db.updateInventoryGroup(target.id, { version: 2 });
  if (kind === 'target-archived') await db.updateInventoryGroup(target.id, { archived: true, archivedAt: new Date(), version: 2 });
  if (kind === 'source-archived') await db.updateInventoryGroup(source.id, { archived: true, archivedAt: new Date(), version: 2 });
  const before = await beforeState();
  await commit(body(reviewed), 409);
  await unchanged(before); expect(await db.countInventoryMovements(first.id)).toBe(1);
});

test.each(['same-source', 'wrong-kind', 'stale-target', 'missing-target'])('move to %s destination is rejected before review', async (kind) => {
  const current = await context();
  await api('post', path() + '/removal-preview', { action: 'move', contextVersion: current.contextVersion,
    targetGroupId: kind === 'same-source' ? source.id : kind === 'wrong-kind' ? food.id : kind === 'missing-target' ? 'missing' : target.id,
    targetVersion: kind === 'stale-target' ? 5 : 1 }, kind === 'missing-target' ? 404 : 409);
  expect(await db.countInventoryMovements(first.id)).toBe(1);
});

test('identical lost-response retries replay the original receipt without duplicate movements or audit even after expiry and new server key', async () => {
  const reviewed = await preview('archive'); const values = body(reviewed);
  const saved = await commit(values);
  expect(await commit({ acknowledgeRetainedStock: true, reviewToken: values.reviewToken, requestId: values.requestId })).toEqual({ ...saved, replayed: true });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
  try { expect(await service.commit(source.id, values, request.credentials().account)).toEqual({ ...saved, replayed: true }); }
  finally { clock.mockRestore(); }
  let restarted;
  jest.isolateModules(() => {
    jest.doMock('../services/dbAdapter', () => db);
    restarted = require('../services/inventoryGroupService');
  });
  jest.dontMock('../services/dbAdapter');
  expect(await restarted.commit(source.id, values, request.credentials().account)).toEqual({ ...saved, replayed: true });
  expect(await api('get', base + '/group-operations/by-request/' + values.requestId)).toEqual(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'replayed')));
  expect(await db.countInventoryMovements(first.id)).toBe(2);
  expect(await db.listAudit({ actions: ['inventory.group.remove'] })).toHaveLength(1);
});

test('changed body, source or actor cannot reuse a committed removal request or recover another account’s receipt', async () => {
  const values = body(await preview('move')); await commit(values);
  await commit({ ...values, acknowledgeRetainedStock: true }, 409);
  await commit(values, 409, target.id);
  await expect(service.commit(source.id, values, { id: 'different-actor', username: 'other' })).rejects.toMatchObject({ status: 409, code: 'GROUP_REMOVAL_REQUEST_CONFLICT' });
  await expect(service.byRequest(values.requestId, { id: 'different-actor' })).rejects.toMatchObject({ status: 409 });
  expect(await api('get', base + '/group-operations/by-request/' + randomUUID())).toBeNull();
});

test('concurrent identical commits apply once, and different requests against the same review conflict', async () => {
  const values = body(await preview('move'));
  const responses = await Promise.all([commit(values), commit(values)]);
  expect(responses.map((value) => value.replayed).sort()).toEqual([false, true]);
  expect(responses[0].id).toBe(responses[1].id);
  await commit({ ...values, requestId: randomUUID() }, 409);
  expect(await db.listAudit({ actions: ['inventory.group.remove'] })).toHaveLength(1);
});

test('an uncommitted expired or forged review cannot remove any group', async () => {
  const reviewed = await preview('archive'); const before = await beforeState();
  await commit(body({ ...reviewed, reviewToken: reviewed.reviewToken.slice(0, -1) + '!' }), 409);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
  try { await expect(service.commit(source.id, body(reviewed), request.credentials().account)).rejects.toMatchObject({ status: 409 }); }
  finally { clock.mockRestore(); }
  await unchanged(before);
});

test.each(['operation-header', 'second-item', 'second-movement', 'audit'])('%s failure rolls back group, every member, history and operation receipt', async (stage) => {
  const reviewed = await preview('archive'), values = body(reviewed), before = await beforeState();
  const method = stage === 'operation-header' ? 'createInventoryGroupOperation' : stage === 'second-item' ? 'updateInventory' : stage === 'second-movement' ? 'appendInventoryMovement' : 'appendAudit';
  const original = db[method]; let calls = 0;
  const failing = jest.spyOn(db, method).mockImplementation(async (...args) => {
    if (++calls === (stage.startsWith('second') ? 2 : 1)) throw new Error('Synthetic lifecycle transaction failure');
    return original(...args);
  });
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { await commit(values, 500); } finally { failing.mockRestore(); logging.mockRestore(); }
  await unchanged(before);
  expect(await db.countInventoryMovements(first.id)).toBe(1); expect(await db.countInventoryMovements(second.id)).toBe(1);
  expect(await db.getInventoryGroupOperationByRequestId(values.requestId)).toBeNull();
  expect(await db.listAudit({ actions: ['inventory.group.remove'] })).toHaveLength(0);
  expect((await commit(values)).replayed).toBe(false);
});

test('derived movement request collisions reject every write before the operation header is created', async () => {
  const values = body(await preview('move'));
  const derived = 'b59_' + createHash('sha256').update(JSON.stringify([values.requestId, first.id])).digest('hex');
  const fixture = (await db.listInventoryMovements(first.id))[0];
  await db.appendInventoryMovement({ ...fixture, id: randomUUID(), requestId: derived, itemVersion: 9 });
  const before = await beforeState();
  await commit(values, 409); await unchanged(before);
  expect(await db.getInventoryGroupOperationByRequestId(values.requestId)).toBeNull();
});

test.each([
  ['groups unknown', '/groups?unexpected=true'], ['groups malformed archived', '/groups?archived=yes'],
  ['items malformed archived', '/items?archived=1'], ['items repeated archived', '/items?archived=true&archived=false'],
])('%s filters are strictly rejected', async (_name, suffix) => {
  expect((await request(app).get(base + suffix)).status).toBe(400);
});

test('commit unknown fields and preview unknown fields cannot spoof archive metadata', async () => {
  const current = await context();
  await api('post', path() + '/removal-preview', { action: 'archive', contextVersion: current.contextVersion, reason: 'Archive retained records', members: [] }, 400);
  const reviewed = await preview('archive');
  await commit({ ...body(reviewed), actorId: 'spoofed' }, 400);
  expect((await db.getInventoryGroupById(source.id)).archived).toBe(false);
});

test('viewers can inspect archived items and operation receipts but cannot preview or remove any group', async () => {
  const receipt = await commit(body(await preview('archive')));
  await db.updateAccount(request.credentials().account.id, { role: 'viewer' });
  expect((await request(app).get(base + '/items?archived=true')).status).toBe(200);
  expect((await request(app).get(base + '/group-operations/' + receipt.id)).status).toBe(200);
  expect((await request(app).get(path(target.id) + '/removal-context')).status).toBe(200);
  expect((await request(app).post(path(target.id) + '/removal-preview').send({})).status).toBe(403);
  expect((await request(app).post(path(target.id) + '/removal').send({})).status).toBe(403);
  expect((await anonymous(app).get(base + '/group-operations/' + receipt.id)).status).toBe(401);
});
