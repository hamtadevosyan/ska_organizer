// Synthetic PostgreSQL test only. Session credential arrives over private IPC,
// never through command-line arguments, logs or generated artifacts.
process.on('message', async ({ token }) => {
  const db = require('../../services/dbAdapter');
  try {
    if (process.env.NODE_ENV !== 'test' || process.env.DB_ADAPTER !== 'sequelize' ||
        !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Not a test database.');
    await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA });
    const account = await require('../../auth/service').sessionAccount(token);
    process.send({ accountId: account.id });
  } catch (error) {
    process.send({ rejected: error.status === 401 });
    if (error.status !== 401) process.exitCode = 1;
  } finally {
    await db.close();
    process.disconnect();
  }
});
