const { randomBytes, randomUUID, createHash, createHmac } = require('node:crypto');
const db = require('../services/dbAdapter');
const { hashPassword, verifyPassword, verifyUnknown, validatePassword } = require('./passwords');
const config = require('./config');
const problem = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const csrfToken = (token) => createHmac('sha256', token).update('skao-csrf-v1').digest('hex');
const publicAccount = ({ id, username, displayName, role, disabled, mustChangePassword, createdAt, updatedAt }) =>
  ({ id, username, displayName, role, disabled, mustChangePassword, createdAt, updatedAt });
const audit = (actor, action, entityId = null) => db.appendAudit({
  id: randomUUID(), actorId: actor?.id || null, actorUsername: actor?.username || 'system',
  action, entityId, occurredAt: new Date(),
});
const normalizeUsername = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
function accountValues(input) {
  const username = normalizeUsername(input.username);
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw problem('Username must be 3–64 letters, numbers, periods, underscores or hyphens.');
  if (!displayName || displayName.length > 100) throw problem('Display name must be between 1 and 100 characters.');
  if (!['admin', 'editor', 'viewer'].includes(input.role)) throw problem('Choose administrator, editor or read-only access.');
  return { username, displayName, role: input.role };
}
async function issueSession(account) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await db.createSession({ id: digest(token), accountId: account.id, createdAt: now, lastSeenAt: now,
    expiresAt: new Date(now.getTime() + config.absoluteMs) });
  return { token, csrfToken: csrfToken(token), account: publicAccount(account) };
}
async function sessionAccount(token, { touch = false } = {}) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw problem('Sign in to continue.', 401, 'AUTH_REQUIRED');
  const session = await db.getSession(digest(token));
  const now = Date.now();
  if (!session || new Date(session.expiresAt).getTime() <= now || new Date(session.lastSeenAt).getTime() + config.idleMs <= now) {
    throw problem('Your session has expired. Sign in again.', 401, 'SESSION_EXPIRED');
  }
  const account = await db.getAccount(session.accountId);
  if (!account || account.disabled) throw problem('Your session has expired. Sign in again.', 401, 'SESSION_EXPIRED');
  if (touch && now - new Date(session.lastSeenAt).getTime() > 60000) await db.updateSession(session.id, { lastSeenAt: new Date(now) });
  return account;
}
function operationalPermission(account, write) {
  if (account.mustChangePassword) throw problem('Change your temporary password before continuing.', 403, 'PASSWORD_CHANGE_REQUIRED');
  if (write && !['admin', 'editor'].includes(account.role)) throw problem('Your account has read-only access.', 403, 'FORBIDDEN');
}
async function administrator(token) {
  const account = await sessionAccount(token);
  operationalPermission(account, false);
  if (account.role !== 'admin') throw problem('Administrator access is required.', 403, 'FORBIDDEN');
  return account;
}
// Reserve attempts before password verification. Limits survive process restarts
// and apply atomically to the account name and the direct client IP.
async function reserveAttempt(username, ip, purpose = 'login') {
  const now = new Date();
  const denied = await db.withAuthLock(async () => {
    await db.cleanAuthRecords(now);
    const keys = [{ id: digest(`${purpose}:ip:${ip}`), limit: 20 },
      { id: digest(`${purpose}:user:${username}`), limit: 5 }];
    const rows = await Promise.all(keys.map(({ id }) => db.getLoginAttempt(id)));
    const blocked = rows.find((row, i) => row && row.count >= keys[i].limit);
    if (blocked) return Math.max(1, Math.ceil((new Date(blocked.expiresAt) - now) / 1000));
    for (let i = 0; i < keys.length; i++) {
      const previous = rows[i];
      await db.saveLoginAttempt({ id: keys[i].id, count: (previous?.count || 0) + 1,
        expiresAt: previous?.expiresAt || new Date(now.getTime() + 15 * 60 * 1000) });
    }
    return 0;
  });
  if (denied) throw Object.assign(problem('Too many attempts. Please try again later.', 429, 'RATE_LIMITED'), { retryAfter: denied });
}
async function login({ username: supplied, password }, ip, oldToken) {
  const username = normalizeUsername(supplied);
  if (username.length > 64 || typeof password !== 'string' || Buffer.byteLength(password) > 512) throw problem('Username or password is incorrect.', 401, 'INVALID_CREDENTIALS');
  await reserveAttempt(username, ip);
  const candidate = await db.findAccount(username);
  const valid = candidate ? await verifyPassword(password, candidate.passwordHash) : await verifyUnknown(password);
  if (!valid || !candidate || candidate.disabled) throw problem('Username or password is incorrect.', 401, 'INVALID_CREDENTIALS');
  return db.withAuthLock(async () => {
    const account = await db.getAccount(candidate.id);
    if (!account || account.disabled || account.passwordHash !== candidate.passwordHash) throw problem('Username or password is incorrect.', 401, 'INVALID_CREDENTIALS');
    await db.deleteLoginAttempt(digest(`login:user:${username}`));
    if (oldToken && /^[a-f0-9]{64}$/.test(oldToken)) await db.deleteSession(digest(oldToken));
    const session = await issueSession(account);
    await audit(account, 'session.sign_in', account.id);
    return session;
  });
}
async function bootstrap(input) {
  const values = accountValues({ ...input, role: 'admin' });
  const passwordHash = await hashPassword(input.password);
  return db.withAuthLock(async () => {
    if ((await db.listAccounts()).length) throw problem('Accounts already exist. Use an administrator account to manage access.', 409);
    const account = await db.createAccount({ id: randomUUID(), ...values, passwordHash, disabled: false, mustChangePassword: false });
    await audit(null, 'account.bootstrap', account.id);
    return publicAccount(account);
  });
}
async function createAccount(token, input) {
  await administrator(token);
  const values = accountValues(input);
  const passwordHash = await hashPassword(input.password);
  return db.withAuthLock(async () => {
    const actor = await administrator(token);
    if (await db.findAccount(values.username)) throw problem('That username is already in use.', 409);
    const account = await db.createAccount({ id: randomUUID(), ...values, passwordHash, disabled: false, mustChangePassword: true });
    await audit(actor, 'account.create', account.id);
    return publicAccount(account);
  });
}
async function updateAccount(token, id, input) {
  return db.withAuthLock(async () => {
    const actor = await administrator(token);
    const account = await db.getAccount(id);
    if (!account) throw problem('Account not found.', 404);
    if (typeof input.disabled !== 'boolean') throw problem('Account status must be enabled or disabled.');
    const values = accountValues({ username: account.username, displayName: input.displayName, role: input.role });
    if (id === actor.id && (input.disabled || values.role !== 'admin')) throw problem('Use another administrator to change your own access.', 409);
    const removesAdmin = account.role === 'admin' && !account.disabled && (input.disabled || values.role !== 'admin');
    if (removesAdmin && (await db.listAccounts()).filter((item) => item.role === 'admin' && !item.disabled).length <= 1) {
      throw problem('At least one enabled administrator is required.', 409);
    }
    const saved = await db.updateAccount(id, { displayName: values.displayName, role: values.role, disabled: input.disabled });
    if (account.role !== saved.role || account.disabled !== saved.disabled) await db.revokeSessions(id);
    await audit(actor, 'account.update_access', id);
    return publicAccount(saved);
  });
}
async function resetPassword(token, id, password) {
  await administrator(token);
  const passwordHash = await hashPassword(password);
  return db.withAuthLock(async () => {
    const actor = await administrator(token);
    if (actor.id === id) throw problem('Use Change password for your own account.');
    if (!await db.getAccount(id)) throw problem('Account not found.', 404);
    await db.updateAccount(id, { passwordHash, mustChangePassword: true });
    await db.revokeSessions(id);
    await audit(actor, 'account.reset_password', id);
  });
}
async function changePassword(token, currentPassword, password, ip) {
  const candidate = await sessionAccount(token);
  validatePassword(password);
  await reserveAttempt(candidate.username, ip, 'password-change');
  if (!await verifyPassword(currentPassword, candidate.passwordHash)) throw problem('Current password is incorrect.', 400);
  if (currentPassword === password) throw problem('Choose a different password.');
  const passwordHash = await hashPassword(password);
  return db.withAuthLock(async () => {
    const account = await sessionAccount(token);
    if (account.passwordHash !== candidate.passwordHash) throw problem('Your session has expired. Sign in again.', 401, 'SESSION_EXPIRED');
    const saved = await db.updateAccount(account.id, { passwordHash, mustChangePassword: false });
    await db.revokeSessions(account.id);
    await audit(account, 'account.change_password', account.id);
    return issueSession(saved);
  });
}
async function logout(token) {
  return db.withAuthLock(async () => {
    const account = await sessionAccount(token);
    await db.deleteSession(digest(token));
    await audit(account, 'session.sign_out', account.id);
  });
}
module.exports = { login, bootstrap, createAccount, updateAccount, resetPassword, changePassword, logout,
  publicAccount, sessionAccount, operationalPermission, administrator, csrfToken, digest, audit, problem };
