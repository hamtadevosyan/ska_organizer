// Isolated browser-test process. Never loads the development .env or database.
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'mock';
process.env.APP_ORIGINS = 'http://127.0.0.1:5179';
const db = require('../../services/dbAdapter');
const { hashPassword } = require('../../auth/passwords');
(async () => {
  await db.createAccount({ id: 'browser-admin', username: 'browser-admin', displayName: 'Browser Administrator',
    passwordHash: await hashPassword('Synthetic browser passphrase 20!'), role: 'admin', disabled: false, mustChangePassword: false });
  require('../../index').listen(3009, '127.0.0.1', () => console.log('Browser fixture server ready'));
})().catch(() => { console.error('Browser fixture failed.'); process.exitCode = 1; });
