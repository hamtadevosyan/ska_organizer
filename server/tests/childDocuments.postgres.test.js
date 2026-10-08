const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { PNG } = require('pngjs');
const { context } = require('./databaseSetup');
const db = require('../services/dbAdapter');
const request = require('./helpers/authenticatedRequest');
const app = require('../index');

const hash = (content) => createHash('sha256').update(content).digest('hex');
function image(red) {
  const png = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([red, 40, 70, 255], offset);
  }
  return PNG.sync.write(png);
}
const file = (content, name) => ({ name, contentType: 'image/png', dataBase64: content.toString('base64') });
const data = (response) => response.body.data ?? response.body;

async function seed() {
  const child = data(await request(app).post('/api/children').send({ firstName: 'Synthetic', lastName: 'Document persistence', dateOfBirth: '2022-06-15' }));
  expect(child.id).toBeDefined();
  const original = image(40); const revised = image(180);
  const created = await request(app).post('/api/children/' + child.id + '/documents').send({
    requestId: randomUUID(), title: 'Synthetic consent', category: 'consent', documentDate: '2026-10-01',
    notes: 'Fictional paperwork used only by the automated test.', file: file(original, 'synthetic-original.png'),
  });
  expect(created.status).toBe(201);
  const document = data(created).document;
  const updated = await request(app).post('/api/children/' + child.id + '/documents/' + document.id + '/revisions').send({
    requestId: randomUUID(), version: document.version, changeNote: 'Synthetic revised page', file: file(revised, 'synthetic-revised.png'),
  });
  expect(updated.status).toBe(201);
  expect((await request(app).put('/api/children/' + child.id + '/enrollment').send({ active: false })).status).toBe(200);
  return { child, document: data(updated).document, original, revised };
}

async function snapshot(childId, documentId) {
  const response = await request(app).get('/api/children/' + childId + '/documents/' + documentId);
  expect(response.status).toBe(200);
  const detail = data(response);
  const content = [];
  for (const revision of detail.revisions) {
    const stored = await db.getChildDocumentContent(documentId, revision.id);
    const bytes = Buffer.from(stored.content);
    expect(stored.sha256).toBe(hash(bytes));
    expect(stored.byteLength).toBe(bytes.length);
    content.push({ id: revision.id, revision: revision.revision, bytes: bytes.toString('base64'), sha256: stored.sha256,
      actorId: stored.actorId, uploadedBy: stored.uploadedBy, changeNote: stored.changeNote });
  }
  const child = await db.getChildById(childId);
  return { detail, content, childId: child.id, enrollmentActive: child.active };
}

test('document bytes, current and old versions, provenance and ended enrollment survive reconnecting', async () => {
  const saved = await seed();
  const before = await snapshot(saved.child.id, saved.document.id);
  expect(before.content).toHaveLength(2);
  expect(before.enrollmentActive).toBe(false);
  expect(before.content.find(({ revision }) => revision === 1).bytes).toBe(saved.original.toString('base64'));
  expect(before.content.find(({ revision }) => revision === 2).bytes).toBe(saved.revised.toString('base64'));
  expect(before.content.every(({ uploadedBy, actorId }) => uploadedBy === 'test-admin' && actorId === request.credentials().account.id)).toBe(true);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema: context().schema });
  expect(await snapshot(saved.child.id, saved.document.id)).toEqual(before);
});

test('PostgreSQL rejects foreign current-file heads, malformed file lengths and removing the linked child', async () => {
  const saved = await seed();
  const other = data(await request(app).post('/api/children/' + saved.child.id + '/documents').send({
    requestId: randomUUID(), title: 'Other synthetic page', category: 'other', file: file(image(220), 'synthetic-other.png'),
  }));
  const { connection, schema } = context();
  await expect(connection.query(`UPDATE "${schema}"."ChildDocuments" SET "currentRevisionId" = $1 WHERE "id" = $2`,
    { bind: [other.document.currentRevisionId, saved.document.id] })).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  await expect(connection.query(`UPDATE "${schema}"."ChildDocumentRevisions" SET "byteLength" = 1 WHERE "id" = $1`,
    { bind: [saved.document.currentRevisionId] })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
  await expect(db.deleteChild(saved.child.id)).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });
  expect((await snapshot(saved.child.id, saved.document.id)).detail.document.currentRevisionId).toBe(saved.document.currentRevisionId);
});

function pgEnvironment(databaseUrl, database) {
  const url = new URL(databaseUrl);
  return { ...process.env, PGHOST: process.env.SKAO_TEST_PG_CONTAINER ? '127.0.0.1' : url.hostname,
    PGPORT: process.env.SKAO_TEST_PG_CONTAINER ? '5432' : url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: database, PGCONNECT_TIMEOUT: '10' };
}
async function archiveOperation(command, args, archive, direction, database) {
  const container = process.env.SKAO_TEST_PG_CONTAINER;
  const binary = container ? 'docker' : process.env.SKAO_TEST_PG_BIN ? path.join(process.env.SKAO_TEST_PG_BIN, command) : command;
  // Pass credentials through the process environment, never a URL or command argument.
  const argv = container ? ['exec', '-i', ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGCONNECT_TIMEOUT']
    .flatMap((name) => ['--env', name]), container, command, ...args] : args;
  const child = spawn(binary, argv, { env: pgEnvironment(process.env.DATABASE_URL, database), stdio: [direction === 'read' ? 'pipe' : 'ignore', direction === 'write' ? 'pipe' : 'ignore', 'pipe'] });
  child.stderr.resume();
  const closed = new Promise((resolve) => child.once('close', resolve));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
  const completion = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Document restore test could not start ' + command + '. Install matching PostgreSQL client tools or set SKAO_TEST_PG_CONTAINER.')));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Document restore test ' + command + ' failed. Check matching PostgreSQL client tools and isolated test database access.')));
  });
  try {
    const transfer = direction === 'write' ? pipeline(child.stdout, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
      : pipeline(createReadStream(archive), child.stdin);
    await Promise.all([completion, transfer]);
  } catch (error) {
    if (error.message?.startsWith('Document restore test ')) throw error;
    throw new Error('Document restore test ' + command + ' failed. Check matching PostgreSQL client tools and isolated test database access.', { cause: error });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    // A pipe error can precede the client's transaction rollback. Wait for its
    // exit before any cleanup changes the schemas it was restoring into.
    await closed;
  }
}

async function restoreScope() {
  const { connection, schema } = context();
  const originalUrl = process.env.DATABASE_URL;
  const source = new URL(originalUrl);
  const database = decodeURIComponent(source.pathname.slice(1));
  if (process.env.NODE_ENV !== 'test' || !database.endsWith('_test') || !/^skao_test_[a-f0-9]{32}$/.test(schema || '')) {
    throw new Error('Document archive checks require an isolated skao_test schema inside a separate _test database.');
  }
  const [[actual]] = await connection.query('SELECT current_database() AS name');
  if (actual.name !== database || !actual.name.endsWith('_test')) {
    throw new Error('Document archive checks are not connected to the configured _test database.');
  }
  const [[namespace]] = await connection.query('SELECT oid::text AS oid FROM pg_namespace WHERE nspname = $1', { bind: [schema] });
  if (!namespace?.oid) throw new Error('The original document test schema is unavailable.');
  return { connection, schema, originalUrl, database, sourceSchemaOid: namespace.oid };
}

async function sourceSchemaName(scope, transaction) {
  const [[namespace]] = await scope.connection.query('SELECT nspname FROM pg_namespace WHERE oid = $1::oid',
    { bind: [scope.sourceSchemaOid], ...(transaction ? { transaction } : {}) });
  if (!namespace) throw new Error('The original document test schema cannot be located.');
  return namespace.nspname;
}

async function restoreArchive(saved, scope, { corruptArchive = false, loseRenameReply = false, heldSchema = 'skao_docs_hold_' + randomUUID().replaceAll('-', '') } = {}) {
  if (!/^skao_docs_hold_[a-f0-9]{32}$/.test(heldSchema)) throw new Error('Invalid document test holding schema.');
  const { connection, schema, originalUrl, database } = scope;
  const before = await snapshot(saved.child.id, saved.document.id);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skao-documents-restore-'));
  const archive = path.join(directory, 'synthetic-documents.dump');
  let originalHeld = false;
  let sourceLocationUnknown = false;
  let adapterClosed = false;
  let operationError;
  const cleanupErrors = [];
  async function reconcileSource() {
    const name = await sourceSchemaName(scope);
    if (name !== schema && name !== heldSchema) throw new Error('The original document test schema changed to an unexpected name.');
    originalHeld = name === heldSchema;
    sourceLocationUnknown = false;
  }
  try {
    await archiveOperation('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--schema=' + schema], archive, 'write', database);
    await db.close();
    adapterClosed = true;
    // Move only this suite's random synthetic schema aside. Restoring its
    // original name then exercises the real archive without CREATE DATABASE.
    try {
      await connection.query(`ALTER SCHEMA "${schema}" RENAME TO "${heldSchema}"`);
      if (loseRenameReply) throw new Error('Synthetic schema rename reply failure.');
      originalHeld = true;
    } catch (error) {
      // A network failure can lose the response after ALTER has committed.
      // Reconcile the source's OID, so a collision with an unrelated holding
      // schema is never treated as permission to remove the original schema.
      try { await reconcileSource(); }
      catch (reconciliationError) { sourceLocationUnknown = true; cleanupErrors.push(reconciliationError); }
      throw error;
    }
    if (corruptArchive) await fs.writeFile(archive, 'Synthetic deliberately invalid PostgreSQL archive.\n');
    await archiveOperation('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname=' + database], archive, 'read', database);
    await db.setup(originalUrl, { schema });
    expect(await snapshot(saved.child.id, saved.document.id)).toEqual(before);
    expect((await request(app).get('/api/children/' + saved.child.id + '/profile')).body.child.active).toBe(false);
  } catch (error) {
    operationError = error;
  } finally {
    if (adapterClosed) {
      try { await db.close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (originalHeld && !sourceLocationUnknown) {
      try {
        // If restoring the original name fails, rollback also restores the
        // clone. The untouched source stays in its held schema for diagnosis.
        await connection.transaction(async (transaction) => {
          if (await sourceSchemaName(scope, transaction) !== heldSchema) throw new Error('The held original document test schema changed before repair.');
          await connection.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, { transaction });
          await connection.query(`ALTER SCHEMA "${heldSchema}" RENAME TO "${schema}"`, { transaction });
        });
        originalHeld = false;
      } catch (error) {
        cleanupErrors.push(error);
        // A lost cleanup COMMIT response has the same uncertainty as ALTER.
        try { await reconcileSource(); }
        catch (reconciliationError) { sourceLocationUnknown = true; cleanupErrors.push(reconciliationError); }
      }
    }
    if (adapterClosed && !originalHeld && !sourceLocationUnknown) {
      try { await db.setup(originalUrl, { schema }); } catch (error) { cleanupErrors.push(error); }
    }
    if (!originalHeld && !sourceLocationUnknown) {
      try { await fs.rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    }
  }
  if (cleanupErrors.length) {
    const retained = sourceLocationUnknown ? ` Original test schema location could not be verified (OID ${scope.sourceSchemaOid}; original name ${schema}; holding name ${heldSchema}); archive retained at ${archive}.`
      : originalHeld ? ` Original test schema retained as ${heldSchema}; archive retained at ${archive}.` : ' Original test schema was restored.';
    throw new AggregateError([operationError, ...cleanupErrors].filter(Boolean), 'Document restore cleanup failed.' + retained);
  }
  if (operationError) throw operationError;
  // Check the source again after removing the restored clone and putting the
  // original schema back, rather than checking only the restored archive.
  expect(await snapshot(saved.child.id, saved.document.id)).toEqual(before);
  return { before, heldSchema };
}

test('an actual PostgreSQL archive restores every file byte and revision inside its isolated test schema', async () => {
  const scope = await restoreScope();
  const saved = await seed();
  const { heldSchema } = await restoreArchive(saved, scope);
  const [held] = await scope.connection.query('SELECT nspname FROM pg_namespace WHERE nspname = $1', { bind: [heldSchema] });
  expect(held).toEqual([]);
}, 120000);

test('a real archive rejection restores the original schema with its exact file bytes and provenance', async () => {
  const scope = await restoreScope();
  const saved = await seed();
  const before = await snapshot(saved.child.id, saved.document.id);
  const heldSchema = 'skao_docs_hold_' + randomUUID().replaceAll('-', '');
  await expect(restoreArchive(saved, scope, { corruptArchive: true, heldSchema })).rejects.toThrow('pg_restore failed');
  expect(await snapshot(saved.child.id, saved.document.id)).toEqual(before);
  const [held] = await scope.connection.query('SELECT nspname FROM pg_namespace WHERE nspname = $1', { bind: [heldSchema] });
  expect(held).toEqual([]);
}, 120000);

test('a committed schema rename with a lost reply is reconciled by identity and safely repaired', async () => {
  const scope = await restoreScope();
  const saved = await seed();
  const before = await snapshot(saved.child.id, saved.document.id);
  const heldSchema = 'skao_docs_hold_' + randomUUID().replaceAll('-', '');
  await expect(restoreArchive(saved, scope, { loseRenameReply: true, heldSchema })).rejects.toThrow('Synthetic schema rename reply failure');
  expect(await snapshot(saved.child.id, saved.document.id)).toEqual(before);
  expect(await sourceSchemaName(scope)).toBe(scope.schema);
  const [held] = await scope.connection.query('SELECT nspname FROM pg_namespace WHERE nspname = $1', { bind: [heldSchema] });
  expect(held).toEqual([]);
}, 120000);

test('a holding-schema name collision preserves the original and the unrelated holding schema', async () => {
  const scope = await restoreScope();
  const saved = await seed();
  const before = await snapshot(saved.child.id, saved.document.id);
  const heldSchema = 'skao_docs_hold_' + randomUUID().replaceAll('-', '');
  await scope.connection.createSchema(heldSchema);
  try {
    await scope.connection.query(`CREATE TABLE "${heldSchema}".marker (value text NOT NULL)`);
    await scope.connection.query(`INSERT INTO "${heldSchema}".marker (value) VALUES ('Unrelated synthetic schema')`);
    await expect(restoreArchive(saved, scope, { heldSchema })).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });
    expect(await snapshot(saved.child.id, saved.document.id)).toEqual(before);
    expect(await sourceSchemaName(scope)).toBe(scope.schema);
    const [marker] = await scope.connection.query(`SELECT value FROM "${heldSchema}".marker`);
    expect(marker).toEqual([{ value: 'Unrelated synthetic schema' }]);
  } finally { await scope.connection.dropSchema(heldSchema, { cascade: true }); }
}, 120000);
