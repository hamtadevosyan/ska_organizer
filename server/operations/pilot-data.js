// Invoked only by the private operations container; never mounted as an HTTP API.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const format = require('./backup-format');
const root = process.env.BACKUP_ROOT || '/backups';
const database = process.env.PGDATABASE || 'ska_organizer';
const release = process.env.PILOT_RELEASE;
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const backupName = () => 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
const recoveryName = () => 'skao_recovery_' + randomBytes(12).toString('hex');

async function password(admin = false) {
  const value = (await fs.readFile('/run/secrets/' + (admin ? 'db_admin_password' : 'app_password'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('The pilot database secret is unavailable or invalid.');
  return value;
}
async function connection(name = database, admin = false) {
  const client = new Client({ host: process.env.PGHOST || 'db', port: Number(process.env.PGPORT || 5432),
    user: admin ? 'postgres' : 'ska_app', database: name, password: await password(admin),
    connectionTimeoutMillis: 10000, application_name: 'skao-pilot-operations' });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}
async function pg(command, args, name = database) {
  // Never interpolate a password/path into a shell command or print SQL errors.
  const env = { ...process.env, PGUSER: 'ska_app', PGDATABASE: name, PGPASSWORD: await password(), PGCONNECT_TIMEOUT: '10' };
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 30 * 60 * 1000);
    child.once('error', () => { clearTimeout(timer); reject(new Error(command + ' could not be started.')); });
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(command + ' failed. Source data and existing databases were preserved.')); });
  });
}
async function fingerprint(client) {
  const rows = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename COLLATE \"C\"")).rows;
  const names = rows.map((row) => row.tablename);
  if (format.required.some((name) => !names.includes(name))) throw new Error('Migrate the organizer database before creating a pilot backup.');
  const tables = [];
  for (const name of names) {
    const columns = (await client.query(`SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [name])).rows;
    // Ordered canonical JSON also catches changed values when row counts match.
    await client.query(`DECLARE pilot_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS value FROM public.${quote(name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    const digest = format.rowDigest();
    for (;;) {
      const batch = (await client.query('FETCH 1000 FROM pilot_rows')).rows;
      if (!batch.length) break;
      for (const row of batch) digest.add(row.value);
    }
    await client.query('CLOSE pilot_rows');
    tables.push({ name, columns, ...digest.finish() });
  }
  return tables;
}
async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
async function readBackup(name) {
  if (!format.safeName(name)) throw new Error('Choose a backup name printed by the backup command.');
  const directory = path.join(root, name);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a regular backup directory.');
  const manifestFile = path.join(directory, 'manifest.json');
  const manifestStat = await fs.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('Choose a regular manifest file.');
  const manifest = format.validateManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')));
  if (manifest.name !== name) throw new Error('Backup folder and manifest names differ.');
  const dump = path.join(directory, 'database.dump');
  const fileStat = await fs.lstat(dump);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || await sha256(dump) !== manifest.sha256) throw new Error('Backup checksum failed. Nothing was restored.');
  return { directory, manifest, dump };
}
async function backup() {
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw new Error('A full release commit is required for recoverable backups.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const name = backupName(); const directory = path.join(root, name + '.partial');
  await fs.mkdir(directory, { mode: 0o700 });
  const client = await connection();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    if (Math.floor(version / 10000) !== 17) throw new Error('This pilot backup tool requires PostgreSQL 17.');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const dump = path.join(directory, 'database.dump');
    // pg_dump and fingerprints see the same snapshot while normal work continues.
    await pg('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot, '--file=' + dump]);
    await pg('pg_restore', ['--list', dump]);
    const tables = await fingerprint(client);
    await client.query('COMMIT');
    const manifest = { format: 1, name, release, createdAt: new Date().toISOString(), postgresMajor: 17,
      sourceDatabase: database, sha256: await sha256(dump), tables, coverage: format.coverageResult(tables) };
    await fs.chmod(dump, 0o600);
    await writeJson(path.join(directory, 'manifest.json'), manifest);
    await fs.rename(directory, path.join(root, name));
    return { operation: 'backup', backup: name, release, tables: tables.map(({ name, count }) => ({ name, count })), coverage: manifest.coverage };
  } finally { await client.end(); }
}
async function restore(name, keep = false) {
  const { manifest, dump } = await readBackup(name);
  const target = recoveryName();
  const admin = await connection('postgres', true);
  let clone;
  try {
    // CREATE DATABASE fails if it exists. There is never a DROP/CREATE of live data.
    await admin.query(`CREATE DATABASE ${quote(target)} OWNER ska_app TEMPLATE template0`);
    await pg('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname=' + target, dump], target);
    clone = await connection(target);
    await clone.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await fingerprint(clone);
    format.compareTables(manifest.tables, tables);
    await clone.query('COMMIT');
    if (keep) {
      // A recovered site requires fresh sign-ins, even if a backup held old sessions.
      await clone.query('DELETE FROM public."Sessions"');
      await clone.query('DELETE FROM public."LoginAttempts"');
    }
    await clone.end(); clone = undefined;
    if (!keep) await admin.query(`DROP DATABASE ${quote(target)}`);
    const result = { operation: keep ? 'restore' : 'verify', backup: name, database: keep ? target : null,
      verifiedDatabase: target, retained: keep, release: manifest.release, verifiedAt: new Date().toISOString(),
      tables: tables.map(({ name, count }) => ({ name, count })), coverage: format.coverageResult(tables),
      sessionsClearedAfterComparison: keep };
    await writeJson(path.join(root, name, (keep ? 'restore-' : 'verify-') + Date.now() + '-' + randomBytes(3).toString('hex') + '.json'), result);
    return result;
  } catch {
    throw new Error('Restore verification failed. The current database is unchanged. Inspect isolated database ' + target + ' before removing it.');
  } finally { await clone?.end(); await admin.end(); }
}
async function importLegacy(filename) {
  if (!/^legacy-[a-zA-Z0-9_-]+\.dump$/.test(filename || '')) throw new Error('Copy your trusted old dump into the backup folder as legacy-NAME.dump.');
  const dump = path.join(root, filename); const file = await fs.lstat(dump);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Choose a regular dump file.');
  await pg('pg_restore', ['--list', dump]);
  const target = recoveryName(); const admin = await connection('postgres', true);
  try {
    await admin.query(`CREATE DATABASE ${quote(target)} OWNER ska_app TEMPLATE template0`);
    await pg('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname=' + target, dump], target);
    // Older backups lack our fingerprints and may predate newer tables. They
    // require migration and user reconciliation; never call this verified recovery.
    return { operation: 'import', database: target, verified: false, sha256: await sha256(dump),
      message: 'Imported into a separate database. Migrate and manually reconcile the trusted source before using it.' };
  } finally { await admin.end(); }
}
async function main() {
  const [action, name, extra] = process.argv.slice(2);
  if (extra || !['help', 'backup', 'verify', 'restore', 'inspect', 'import'].includes(action)) throw new Error('Use backup, verify NAME, restore NAME, inspect NAME or import legacy-NAME.dump.');
  let result;
  if (action === 'help') result = { actions: ['backup', 'verify NAME', 'restore NAME', 'inspect NAME', 'import legacy-NAME.dump'] };
  else if (action === 'backup') { if (name) throw new Error('Backup does not accept a name.'); result = await backup(); }
  else if (action === 'verify' || action === 'restore') result = await restore(name, action === 'restore');
  else if (action === 'import') result = await importLegacy(name);
  else { const { manifest } = await readBackup(name); result = { backup: name, release: manifest.release, coverage: manifest.coverage }; }
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch((error) => {
  // pg connection/SQL failures can contain account data or infrastructure secrets.
  const safe = /^(Use |Choose |Copy |A full release|Backup |Unsupported |Invalid table|Restored table|Restore verification|Migrate |This pilot|The pilot|pg_dump |pg_restore |Configure )/.test(error.message || '');
  console.error(safe ? error.message : 'Pilot data operation failed. Check database availability, secret files and backup permissions.');
  process.exitCode = 1;
});
module.exports = { fingerprint };
