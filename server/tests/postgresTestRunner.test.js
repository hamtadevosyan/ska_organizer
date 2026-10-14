jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
const { spawnSync } = require('node:child_process');
const runner = require.resolve('../scripts/test-postgres');
const originalEnv = { ...process.env };
const originalExitCode = process.exitCode;
const originalArgv = process.argv;
let errorLog;

beforeEach(() => {
  spawnSync.mockReset().mockReturnValue({ status: 0 });
  process.env.TEST_DATABASE_URL = 'postgres://example:synthetic@localhost/skao_test';
  process.env.DATABASE_URL = 'postgres://example:synthetic@localhost/skao_live';
  process.env.PGOPTIONS = '-c application_name=custom-test -c lock_timeout=0';
  process.exitCode = undefined;
  process.argv = ['node', runner, '--runTestsByPath', 'tests/shelf.test.js'];
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.exitCode = originalExitCode;
  process.argv = originalArgv;
  errorLog.mockRestore();
});

function run() {
  delete require.cache[runner];
  jest.isolateModules(() => require(runner));
}

test('bounded waits reach only the separate test child and preserve other startup options', () => {
  const parentOptions = process.env.PGOPTIONS;
  const parentDatabase = process.env.DATABASE_URL;
  run();
  expect(spawnSync).toHaveBeenCalledTimes(1);
  const [executable, args, config] = spawnSync.mock.calls[0];
  expect(executable).toBe(process.execPath);
  expect(args).toContain('--runInBand');
  expect(args.slice(-2)).toEqual(['--runTestsByPath', 'tests/shelf.test.js']);
  expect(config.env).toMatchObject({ NODE_ENV: 'test', DB_ADAPTER: 'sequelize', DATABASE_URL: process.env.TEST_DATABASE_URL });
  expect(config.env.PGOPTIONS).toBe(parentOptions + ' -c lock_timeout=10000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000');
  expect(process.env.PGOPTIONS).toBe(parentOptions);
  expect(process.env.DATABASE_URL).toBe(parentDatabase);
  expect(process.exitCode).toBe(0);
});

test('test waits are bounded without a preexisting PGOPTIONS value', () => {
  delete process.env.PGOPTIONS;
  run();
  expect(spawnSync.mock.calls[0][2].env.PGOPTIONS).toBe('-c lock_timeout=10000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=20000');
  expect(process.env.PGOPTIONS).toBeUndefined();
});

test.each(['options', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'])('a URL cannot silently override %s and disable test wait limits', key => {
  process.env.TEST_DATABASE_URL += '?' + key + '=0';
  run();
  expect(spawnSync).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('TEST_DATABASE_URL'));
  expect(errorLog.mock.calls.flat().join(' ')).not.toContain('synthetic');
});

test('an application database is rejected without starting Jest', () => {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
  run();
  expect(spawnSync).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

test('a PostgreSQL test failure keeps its exit status', () => {
  spawnSync.mockReturnValue({ status: 1 });
  run();
  expect(process.exitCode).toBe(1);
});
