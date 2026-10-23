import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBrowserTests } from './run-browser-tests.mjs';

function report(files = ['authentication.spec.ts', 'rooms.spec.ts']) {
  return { config: { rootDir: '/project/tests/browser' }, errors: [], suites: files.map(file => ({
    title: file, file, specs: [{ title: `test in ${file}`, file, tests: [{ projectName: '' }] }],
  })) };
}
function harness(value = report(), settings = {}) {
  const calls = []; const lists = []; const paths = []; const output = [];
  return {
    calls, lists, paths, output,
    options: {
      cli: '/fake/playwright.js', cwd: '/project/client', env: { SENTINEL: 'preserved' },
      output: value => output.push(value),
      invoke: async (command, args, options) => {
        calls.push({ command, args, options });
        if (options.capture) return { code: settings.discoveryCode ?? 0, stdout: settings.raw ?? JSON.stringify(value), stderr: settings.stderr ?? '' };
        const position = args.lastIndexOf('--test-list');
        if (position !== -1) {
          const file = args[position + 1]; paths.push(file);
          lists.push((await readFile(file, 'utf8')).trim().split('\n'));
        }
        if (settings.throwRun) throw new Error('Synthetic child failure');
        return { code: settings.exitCodes?.[lists.length - 1] ?? 0 };
      },
    },
  };
}

test('isolates each authentication-heavy file and groups remaining tests once', async () => {
  const files = ['staff-account-links.spec.ts', 'teacher-care.spec.ts', 'classroom-access.spec.ts', 'authentication.spec.ts', 'auth-fixture-session.spec.ts', 'remembered-login.spec.ts', 'child-documents.spec.ts', 'staff-compliance.spec.ts', 'batch-receiving.spec.ts', 'purchasing-list.spec.ts', 'inventory-group-removal.spec.ts', 'payroll.spec.ts', 'clock-station.spec.ts', 'rooms.spec.ts', 'activities.spec.ts'];
  const h = harness(report(files));
  assert.equal(await runBrowserTests([], h.options), 0);
  assert.equal(h.lists.length, 14);
  assert.deepEqual(h.lists.map(lines => lines.length), [...Array(13).fill(1), 2]);
  assert.equal(new Set(h.lists.flat()).size, files.length);
});

test('discovery is read-only and actual invocations do not receive --list', async () => {
  const h = harness(); await runBrowserTests([], h.options);
  assert.deepEqual(h.calls[0].args.slice(-2), ['--list', '--reporter=json']);
  assert.equal(h.calls[0].options.capture, true);
  assert.ok(h.calls.slice(1).every(call => !call.args.includes('--list') && call.options.capture !== true));
});

test('preserves explicit file, grep, project and config arguments in every invocation', async () => {
  const h = harness(); const args = ['rooms.spec.ts', '--grep', 'first|second', '--project', 'phone', '--config', 'custom.ts'];
  await runBrowserTests(args, h.options);
  for (const call of h.calls) assert.deepEqual(call.args.slice(2, 2 + args.length), args);
});

test('an existing test list remains exact after discovery and group selection', async () => {
  const h = harness(report(['rooms.spec.ts']));
  await runBrowserTests(['--test-list', '/user/selected.txt'], h.options);
  assert.deepEqual(h.calls[0].args.slice(2, 4), ['--test-list', '/user/selected.txt']);
  assert.deepEqual(h.lists.flat(), ['[] › rooms.spec.ts › test in rooms.spec.ts']);
  assert.equal(h.calls[1].args.filter(arg => arg === '--test-list').length, 2);
});

test('keeps file, nested describe and project identities exact', async () => {
  const value = report(['nested/rooms.spec.ts']);
  value.suites[0].suites = [{ title: 'group > greater', suites: [{ title: 'inner', specs: [{ title: 'a selected test', file: 'nested/rooms.spec.ts', tests: [{ projectName: 'phone' }, { projectName: 'desktop' }] }] }] }];
  value.suites[0].specs = [];
  const h = harness(value); await runBrowserTests([], h.options);
  assert.deepEqual(h.lists.flat(), ['[phone] › nested/rooms.spec.ts › group > greater › inner › a selected test', '[desktop] › nested/rooms.spec.ts › group > greater › inner › a selected test']);
});

test('resolves absolute test locations relative to the report root', async () => {
  const value = report(['rooms.spec.ts']); value.suites[0].specs[0].file = '/project/tests/browser/rooms.spec.ts';
  const h = harness(value); await runBrowserTests([], h.options);
  assert.equal(h.lists[0][0], '[] › rooms.spec.ts › test in rooms.spec.ts');
});

test('preserves the execution environment and only clears discovery JSON redirects', async () => {
  const h = harness(); h.options.env.PLAYWRIGHT_JSON_OUTPUT_FILE = '/tmp/report.json'; h.options.env.PLAYWRIGHT_JSON_OUTPUT_NAME = 'report.json'; h.options.env.PLAYWRIGHT_JSON_OUTPUT_DIR = '/tmp';
  await runBrowserTests([], h.options);
  assert.deepEqual(h.calls[0].options.env, { SENTINEL: 'preserved' });
  for (const call of h.calls.slice(1)) assert.equal(call.options.env, h.options.env);
});

test('propagates discovery failure and runs no group', async () => {
  const h = harness(report(), { discoveryCode: 7, raw: 'failed stdout', stderr: 'failed stderr' });
  assert.equal(await runBrowserTests([], h.options), 7); assert.equal(h.calls.length, 1);
  assert.equal(h.output.join(''), 'failed stdoutfailed stderr');
});

test('fails fast on a group failure and preserves its exit code', async () => {
  const h = harness(report(), { exitCodes: [17, 0] });
  assert.equal(await runBrowserTests([], h.options), 17); assert.equal(h.calls.length, 2);
});

test('removes temporary lists after successful runs', async () => {
  const h = harness(); await runBrowserTests([], h.options);
  for (const file of h.paths) await assert.rejects(access(file), { code: 'ENOENT' });
});

test('removes temporary lists after a failed group', async () => {
  const h = harness(report(), { exitCodes: [3] }); await runBrowserTests([], h.options);
  for (const file of h.paths) await assert.rejects(access(file), { code: 'ENOENT' });
});

test('removes temporary lists after child process errors', async () => {
  const h = harness(report(), { throwRun: true }); await assert.rejects(runBrowserTests([], h.options), /Synthetic/);
  for (const file of h.paths) await assert.rejects(access(file), { code: 'ENOENT' });
});

test('rejects invalid discovery JSON without broadening to all tests', async () => {
  const h = harness(null, { raw: 'warning\n{}' });
  await assert.rejects(runBrowserTests([], h.options), /valid JSON/); assert.equal(h.calls.length, 1);
});

test('rejects empty selections without launching a test server', async () => {
  const h = harness(report([])); await assert.rejects(runBrowserTests([], h.options), /selected no tests/); assert.equal(h.calls.length, 1);
});

test('rejects malformed report roots', async () => {
  for (const value of [{}, { config: { rootDir: 'relative' }, suites: [] }, { config: { rootDir: '/project' }, suites: {} }]) {
    const h = harness(value); await assert.rejects(runBrowserTests([], h.options), /valid Playwright JSON/); assert.equal(h.calls.length, 1);
  }
});

test('rejects discovery errors even if some tests were listed', async () => {
  const value = report(); value.errors = [{ message: 'A fixture failed to load' }];
  const h = harness(value); await assert.rejects(runBrowserTests([], h.options), /reported errors/); assert.equal(h.calls.length, 1);
});

test('rejects malformed suites and project identities', async () => {
  for (const alter of [value => { value.suites[0].specs = {}; }, value => { value.suites[0].specs[0].tests = []; }, value => { delete value.suites[0].specs[0].tests[0].projectName; }]) {
    const value = report(); alter(value); const h = harness(value);
    await assert.rejects(runBrowserTests([], h.options), /malformed/); assert.equal(h.calls.length, 1);
  }
});

test('rejects multiline or delimiter-containing titles rather than accidentally selecting more tests', async () => {
  for (const title of ['line\nbreak', 'title › suffix', ' leading space']) {
    const value = report(); value.suites[0].specs[0].title = title;
    const h = harness(value); await assert.rejects(runBrowserTests([], h.options), /represented exactly/); assert.equal(h.calls.length, 1);
  }
});

test('rejects unsafe file paths and project delimiters', async () => {
  for (const alter of [value => { value.suites[0].specs[0].file = '../outside.spec.ts'; }, value => { value.suites[0].specs[0].tests[0].projectName = '[phone]'; }]) {
    const value = report(); alter(value); const h = harness(value);
    await assert.rejects(runBrowserTests([], h.options), /unsafe|malformed/); assert.equal(h.calls.length, 1);
  }
});

test('rejects duplicate identities', async () => {
  const value = report(['rooms.spec.ts']); value.suites[0].specs.push(structuredClone(value.suites[0].specs[0]));
  const h = harness(value); await assert.rejects(runBrowserTests([], h.options), /duplicate/); assert.equal(h.calls.length, 1);
});

test('passes through listing, help, UI and stateful CLI operations once', async () => {
  for (const arg of ['--list', '--help', '-h', '--version', '-V', '--shard=1/2', '--last-failed', '--ui', '--ui-host=127.0.0.1', '--ui-port=5000', '--debug']) {
    const h = harness(null, { exitCodes: [0] }); assert.equal(await runBrowserTests([arg], h.options), 0);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].args, ['/fake/playwright.js', 'test', arg]); assert.equal(h.calls[0].options.capture, undefined);
  }
});

test('creates lists under a supplied temporary directory and cleans only its own directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runner-test-parent-'));
  try {
    await writeFile(path.join(directory, 'keep.txt'), 'keep');
    const h = harness(); await runBrowserTests([], { ...h.options, temporaryDirectory: directory });
    assert.ok(h.paths.every(file => file.startsWith(directory + path.sep)));
    assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the real subprocess adapter preserves child exit status without a shell', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runner fake cli '));
  try {
    const cli = path.join(directory, 'fake cli.mjs');
    await writeFile(cli, 'process.exitCode = 23;\n');
    assert.equal(await runBrowserTests(['--list'], { cli, cwd: directory }), 23);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
