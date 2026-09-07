const { spawnSync } = require('node:child_process');
const path = require('node:path');

function start(settings) {
  return spawnSync(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DATABASE_URL: '', ...settings },
  });
}

test.each([
  ['missing URL', {}],
  ['in-memory URL', { DATABASE_URL: 'sqlite::memory:' }],
  ['unknown adapter', { DB_ADAPTER: 'typo' }],
  ['unreachable database', { DATABASE_URL: 'postgresql://test:do-not-print-this-password@127.0.0.1:1/skao_test' }],
])('startup fails without a mock fallback: %s', (_label, settings) => {
  const result = start(settings);
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('Server running');
  expect(result.stdout).not.toContain('Mock storage');
  expect(result.stderr).not.toContain('do-not-print-this-password');
  expect(result.stderr).toMatch(/DATABASE_URL|DB_ADAPTER|PostgreSQL/);
});
