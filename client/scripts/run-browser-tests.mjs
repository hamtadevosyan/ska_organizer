import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Each invocation starts a new, ordinary isolated fixture. Authentication-heavy
// files must not share one process-wide login budget with the entire suite.
const isolatedFiles = new Set([
  'staff-account-links.spec.ts', 'teacher-care.spec.ts', 'classroom-access.spec.ts', 'authentication.spec.ts', 'auth-fixture-session.spec.ts',
  'remembered-login.spec.ts', 'child-documents.spec.ts', 'staff-compliance.spec.ts',
  'batch-receiving.spec.ts', 'purchasing-list.spec.ts', 'inventory-group-removal.spec.ts',
  'payroll.spec.ts', 'clock-station.spec.ts', 'employee-work-access.spec.ts',
]);
const passthrough = new Set(['--list', '--help', '-h', '--version', '-V', '--shard', '--last-failed', '--ui', '--ui-host', '--ui-port', '--debug']);

function invoke(command, args, { cwd, env, capture = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    let stdout = ''; let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr?.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function selections(report) {
  if (!report || !report.config || typeof report.config.rootDir !== 'string' || !path.isAbsolute(report.config.rootDir) || !Array.isArray(report.suites)) {
    throw new Error('Browser discovery did not return a valid Playwright JSON report. No tests were run.');
  }
  if (Array.isArray(report.errors) && report.errors.length) throw new Error('Browser discovery reported errors. No tests were run.');
  const root = report.config.rootDir;
  const tests = []; const seen = new Set();
  const token = value => {
    if (typeof value !== 'string' || value.trim() !== value || !value || /[\r\n›]/u.test(value)) {
      throw new Error('A selected test cannot be represented exactly in a Playwright test list. No tests were run.');
    }
    return value;
  };
  function visit(suite, parents = [], fileSuite = true) {
    if (!suite || typeof suite.title !== 'string' || (suite.specs !== undefined && !Array.isArray(suite.specs)) || (suite.suites !== undefined && !Array.isArray(suite.suites))) {
      throw new Error('Browser discovery contains a malformed suite. No tests were run.');
    }
    const titles = fileSuite ? parents : [...parents, token(suite.title)];
    for (const spec of suite.specs ?? []) {
      if (!spec || typeof spec.file !== 'string' || !Array.isArray(spec.tests) || !spec.tests.length) {
        throw new Error('Browser discovery contains a malformed test. No tests were run.');
      }
      const file = path.isAbsolute(spec.file) ? path.relative(root, spec.file) : spec.file;
      const normalized = token(file.replaceAll('\\', '/'));
      if (normalized.startsWith('../') || path.isAbsolute(normalized) || /[:\[\]]/u.test(normalized)) throw new Error('A discovered test file is unsafe or cannot be selected exactly. No tests were run.');
      const title = [...titles, token(spec.title)];
      for (const test of spec.tests) {
        if (!test || typeof test.projectName !== 'string' || /[\r\n›\[\]]/u.test(test.projectName) || test.projectName.trim() !== test.projectName) {
          throw new Error('Browser discovery contains a malformed project. No tests were run.');
        }
        const line = `[${test.projectName}] › ${normalized} › ${title.join(' › ')}`;
        // Duplicate descriptors cannot be isolated without broadening selection.
        if (seen.has(line)) throw new Error('Browser discovery contains duplicate test identities. No tests were run.');
        seen.add(line); tests.push({ file: normalized, line });
      }
    }
    for (const nested of suite.suites ?? []) visit(nested, titles, false);
  }
  for (const suite of report.suites) visit(suite);
  if (!tests.length) throw new Error('Browser discovery selected no tests. No tests were run.');
  return tests;
}

export async function runBrowserTests(args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const command = options.command ?? process.execPath;
  const cli = options.cli ?? createRequire(import.meta.url).resolve('@playwright/test/cli');
  const run = options.invoke ?? invoke;
  const output = options.output ?? (value => process.stdout.write(value));
  const direct = args.some(arg => passthrough.has(arg.split('=')[0]));
  if (direct) return (await run(command, [cli, 'test', ...args], { cwd, env })).code;
  // A caller's JSON output-file setting must not divert discovery away from
  // stdout. Actual test invocations retain the caller's complete environment.
  const discoveryEnv = { ...env };
  delete discoveryEnv.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete discoveryEnv.PLAYWRIGHT_JSON_OUTPUT_NAME;
  delete discoveryEnv.PLAYWRIGHT_JSON_OUTPUT_DIR;
  const discovered = await run(command, [cli, 'test', ...args, '--list', '--reporter=json'], { cwd, env: discoveryEnv, capture: true });
  if (discovered.code !== 0) {
    if (discovered.stdout) output(discovered.stdout);
    if (discovered.stderr) output(discovered.stderr);
    return discovered.code;
  }
  let report;
  try { report = JSON.parse(discovered.stdout); }
  catch { throw new Error('Browser discovery did not return valid JSON. No tests were run.'); }
  const selected = selections(report);
  const groups = new Map();
  for (const test of selected) {
    const basename = path.posix.basename(test.file);
    const key = isolatedFiles.has(basename) ? test.file : 'remaining browser tests';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(test.line);
  }
  const directory = await mkdtemp(path.join(options.temporaryDirectory ?? tmpdir(), 'skao-browser-'));
  try {
    let index = 0;
    for (const [name, lines] of groups) {
      index++;
      const list = path.join(directory, `group-${index}.txt`);
      await writeFile(list, lines.join('\n') + '\n', 'utf8');
      output(`\nBrowser group ${index}/${groups.size}: ${name} (${lines.length} tests)\n`);
      const result = await run(command, [cli, 'test', ...args, '--test-list', list], { cwd, env });
      if (result.code !== 0) return result.code;
    }
    return 0;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runBrowserTests(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
