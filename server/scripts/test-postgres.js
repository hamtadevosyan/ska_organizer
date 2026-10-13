require('../config/environment');
const { spawnSync } = require('node:child_process');
const { validateDatabaseUrl } = require('../database/connection');

try {
  const url = validateDatabaseUrl(process.env.TEST_DATABASE_URL);
  if (!decodeURIComponent(url.pathname).endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a separate database ending in _test.');
  }
  // These limits apply only to connections opened by this test subprocess.
  // Cancel blocked SQL on the server; a Jest timeout alone leaves SQL running
  // and can block the following test's TRUNCATE and schema cleanup.
  const overrideKeys = ['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'];
  if (overrideKeys.some(key => url.searchParams.has(key))) {
    throw new Error('Remove options and timeout overrides from TEST_DATABASE_URL. Put other PostgreSQL startup options in PGOPTIONS; the test runner supplies bounded wait limits.');
  }
  const testOptions = [process.env.PGOPTIONS,
    '-c lock_timeout=10000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000']
    .filter(Boolean).join(' ');
  const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.postgres.config.cjs', '--runInBand', '--detectOpenHandles', ...process.argv.slice(2)], {
    cwd: require('node:path').join(__dirname, '..'), stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DATABASE_URL: process.env.TEST_DATABASE_URL, PGOPTIONS: testOptions },
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
