jest.setTimeout(30000);
const { randomBytes, randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');
const fixture = require('./helpers/authenticatedRequest');

const administratorToken = () => fixture.credentials().cookie.split('=')[1];
const values = (account, changes = {}) => ({ displayName: account.displayName, role: account.role, disabled: false, ...changes });
async function room(active = true) {
  return db.createRoom({ id: randomUUID(), name: 'Synthetic class', active, ageMinMonths: 12, ageMaxMonths: 60, capacity: 20 });
}
async function account(role = 'viewer', roomId = null) {
  const admin = await db.getAccount(fixture.credentials().account.id);
  return db.createAccount({ id: randomUUID(), username: 'synthetic-' + randomUUID(), displayName: 'Synthetic employee',
    passwordHash: admin.passwordHash, role, roomId, disabled: false, mustChangePassword: false });
}
async function session(person, remembered = false) {
  const token = randomBytes(32).toString('hex'); const now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: person.id, createdAt: now, lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3600000), remembered });
  return token;
}

test('administrator assigns an active class explicitly and new unassigned accounts have no inferred scope', async () => {
  const assigned = await room();
  const created = await auth.createAccount(administratorToken(), { username: 'synthetic-class-viewer', displayName: assigned.name,
    role: 'viewer', roomId: assigned.id, password: 'Synthetic temporary passphrase 20!' });
  expect(created).toMatchObject({ role: 'viewer', roomId: assigned.id });
  expect(created).not.toHaveProperty('passwordHash');
  const unassigned = await auth.createAccount(administratorToken(), { username: 'synthetic-unassigned', displayName: assigned.name,
    role: 'viewer', password: 'Synthetic temporary passphrase 20!' });
  expect(unassigned.roomId).toBeNull();
  expect(auth.publicAccount(await account('editor'))).toHaveProperty('roomId', null);
  expect(auth.publicAccount({ role: 'viewer' })).toHaveProperty('roomId', null);
});

test('invalid identifiers, inactive classes and non-viewer assignments fail without changing access', async () => {
  const person = await account(); const inactive = await room(false); const active = await room();
  for (const roomId of ['', ' ', ' spaced ', 123, {}, [], 'x'.repeat(256)]) {
    await expect(auth.updateAccount(administratorToken(), person.id, values(person, { roomId })))
      .rejects.toMatchObject({ status: 400, code: 'CLASS_ASSIGNMENT_INVALID' });
  }
  for (const roomId of ['missing-class', inactive.id]) {
    await expect(auth.updateAccount(administratorToken(), person.id, values(person, { roomId })))
      .rejects.toMatchObject({ status: 409, code: 'CLASS_ASSIGNMENT_INVALID' });
  }
  await expect(auth.updateAccount(administratorToken(), person.id, values(person, { role: 'editor', roomId: active.id })))
    .rejects.toMatchObject({ status: 400, code: 'CLASS_ASSIGNMENT_INVALID' });
  expect(await db.getAccount(person.id)).toEqual(person);
});

test('omitting a viewer assignment preserves it; explicit null and changing role clear it', async () => {
  const assigned = await room(); const person = await account('viewer', assigned.id);
  const renamed = await auth.updateAccount(administratorToken(), person.id, values(person, { displayName: 'Renamed employee' }));
  expect(renamed.roomId).toBe(assigned.id);
  expect((await auth.updateAccount(administratorToken(), person.id, values(renamed, { roomId: null }))).roomId).toBeNull();
  await auth.updateAccount(administratorToken(), person.id, values(renamed, { roomId: assigned.id }));
  const promoted = await auth.updateAccount(administratorToken(), person.id, values(renamed, { role: 'editor' }));
  expect(promoted).toMatchObject({ role: 'editor', roomId: null });
  expect((await db.getAccount(person.id)).roomId).toBeNull();
});

test('scope changes revoke ordinary and remembered sessions while a name-only edit retains them', async () => {
  const first = await room(); const second = await room(); const person = await account('viewer', first.id);
  const tokens = [await session(person), await session(person, true)];
  await auth.updateAccount(administratorToken(), person.id, values(person, { displayName: 'New name only' }));
  for (const token of tokens) expect((await auth.sessionAccount(token)).roomId).toBe(first.id);
  await auth.updateAccount(administratorToken(), person.id, values(person, { roomId: second.id }));
  for (const token of tokens) await expect(auth.sessionAccount(token)).rejects.toMatchObject({ status: 401 });
  const replacement = await session(await db.getAccount(person.id));
  expect((await auth.sessionAccount(replacement)).roomId).toBe(second.id);
});

test('an audit failure rolls assignment, account changes and session revocation back together', async () => {
  const first = await room(); const second = await room(); const person = await account('viewer', first.id);
  const token = await session(person, true);
  const audit = jest.spyOn(db, 'appendAudit').mockRejectedValueOnce(new Error('Synthetic audit failure'));
  try {
    await expect(auth.updateAccount(administratorToken(), person.id, values(person, { roomId: second.id }))).rejects.toThrow('Synthetic audit failure');
  } finally { audit.mockRestore(); }
  expect(await db.getAccount(person.id)).toEqual(person);
  expect((await auth.sessionAccount(token)).roomId).toBe(first.id);
});

test('teachers and class viewers cannot assign or widen account scope', async () => {
  const assigned = await room(); const target = await account();
  for (const role of ['editor', 'viewer']) {
    const token = await session(await account(role));
    await expect(auth.updateAccount(token, target.id, values(target, { roomId: assigned.id }))).rejects.toMatchObject({ status: 403 });
    await expect(auth.createAccount(token, { username: 'attempt-' + role, displayName: 'Unauthorized account', role: 'viewer',
      roomId: assigned.id, password: 'Synthetic temporary passphrase 20!' })).rejects.toMatchObject({ status: 403 });
  }
  expect((await db.getAccount(target.id)).roomId).toBeNull();
});

test('the administrator is revalidated after waiting for auth and room locks', async () => {
  const assigned = await room(); const person = await account();
  const order = []; const original = db.withRoomLock;
  const waiting = jest.spyOn(db, 'withRoomLock').mockImplementation((callback) => original(async () => {
    order.push('room');
    await db.updateAccount(fixture.credentials().account.id, { disabled: true });
    return callback();
  }));
  try {
    await expect(auth.updateAccount(administratorToken(), person.id, values(person, { roomId: assigned.id })))
      .rejects.toMatchObject({ status: 401 });
  } finally { waiting.mockRestore(); }
  expect(order).toEqual(['room']);
  expect((await db.getAccount(person.id)).roomId).toBeNull();
});
