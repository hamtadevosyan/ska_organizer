const request = require('supertest');
const db = require('../../services/dbAdapter');
const { hashPassword } = require('../../auth/passwords');
const { randomUUID } = require('node:crypto');
const origin = 'http://localhost:5173';
const password = 'Synthetic test passphrase 20!';
let credentials;
let passwordHash;
async function initialize(app) {
  passwordHash ||= hashPassword(password);
  const account = await db.createAccount({ id: randomUUID(), username: 'test-admin', displayName: 'Test Administrator',
    passwordHash: await passwordHash, role: 'admin', disabled: false, mustChangePassword: false });
  const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ username: account.username, password });
  if (response.status !== 200) throw new Error('Test administrator could not sign in.');
  credentials = { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken, account };
}
function authenticatedRequest(app) {
  return Object.fromEntries(['get', 'post', 'put', 'delete', 'patch', 'head'].map((method) => [method, (url) => {
    if (!credentials) throw new Error('Test authentication has not been initialized.');
    return request(app)[method](url).set('Origin', origin).set('Cookie', credentials.cookie)
      .set('X-CSRF-Token', credentials.csrf).set('Content-Type', 'application/json');
  }]));
}
module.exports = Object.assign(authenticatedRequest, { initialize, credentials: () => credentials, origin, password });
