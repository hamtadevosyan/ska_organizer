require('../config/environment');
const { spawnSync } = require('node:child_process');
const { validateDatabaseUrl } = require('../database/connection');

try {
  const url = validateDatabaseUrl(process.env.TEST_DATABASE_URL);
  if (!decodeURIComponent(url.pathname).endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a separate database ending in _test.');
  }
  const result = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.postgres.config.cjs', '--runInBand', '--detectOpenHandles', ...process.argv.slice(2)], {
    cwd: require('node:path').join(__dirname, '..'), stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DATABASE_URL: process.env.TEST_DATABASE_URL },
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
