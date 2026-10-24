const request = require('supertest');
const db = require('../../services/dbAdapter');
const { hashPassword } = require('../../auth/passwords');
const auth = require('../../auth/service');
const config = require('../../auth/config');
const { randomBytes, randomUUID } = require('node:crypto');
const origin = 'http://localhost:5173';
const password = 'Synthetic test passphrase 20!';
let credentials;
let passwordHash;
async function initialize(app) {
  credentials = undefined;
  passwordHash ||= hashPassword(password);
  const account = await db.createAccount({ id: randomUUID(), username: 'test-admin', displayName: 'Test Administrator',
    passwordHash: await passwordHash, role: 'admin', disabled: false, mustChangePassword: false });
  // Resource tests need real session authorization, not another costly password
  // login before every case. Authentication suites exercise login separately.
  // This synthetic session does not fabricate sign-in audits or rate attempts.
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await db.createSession({ id: auth.digest(token), accountId: account.id, createdAt: now, lastSeenAt: now,
    expiresAt: new Date(now.getTime() + config.absoluteMs), remembered: false });
  const cookie = `${config.cookieName}=${token}`;
  const csrf = auth.csrfToken(token);
  let response;
  try {
    response = await request(app).get('/api/auth/session').timeout({ response: 15000, deadline: 20000 })
      .set('Origin', origin).set('Cookie', cookie);
  } catch (error) {
    throw new Error(error.timeout
      ? 'Test administrator session validation timed out before resource tests started.'
      : 'Test administrator session validation failed before resource tests started.');
  }
  if (response.status !== 200 || response.body?.account?.id !== account.id || response.body?.account?.role !== 'admin' || response.body?.csrfToken !== csrf) {
    throw new Error('Test administrator session validation failed before resource tests started.');
  }
  credentials = { cookie, csrf, account };
}
function authenticatedRequest(app) {
  return Object.fromEntries(['get', 'post', 'put', 'delete', 'patch', 'head'].map((method) => [method, (url) => {
    if (!credentials) throw new Error('Test authentication has not been initialized.');
    return request(app)[method](url).set('Origin', origin).set('Cookie', credentials.cookie)
      .set('X-CSRF-Token', credentials.csrf).set('Content-Type', 'application/json');
  }]));
}
module.exports = Object.assign(authenticatedRequest, { initialize, credentials: () => credentials, origin, password });
