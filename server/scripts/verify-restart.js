require('../config/environment');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createConnection, validateDatabaseUrl } = require('../database/connection');
const { migrate } = require('../database/migrate');
const { runPersistenceProcess } = require('../tests/helpers/persistenceProcess');

const stateFile = path.join(__dirname, '../.restart-test-state.json');
const phase = process.argv[2];

(async () => {
  let connection;
  let createdSchema;
  try {
    const url = validateDatabaseUrl(process.env.TEST_DATABASE_URL);
    if (!decodeURIComponent(url.pathname).endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL must name a separate database ending in _test.');
    }
    // No credentials are written to the checkpoint.
    const database = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    connection = createConnection(process.env.TEST_DATABASE_URL);
    if (phase === 'prepare') {
      const file = await fs.open(stateFile, 'wx', 0o600);
      try {
        const schema = `skao_restart_${randomUUID().replaceAll('-', '')}`;
        await connection.createSchema(schema);
        createdSchema = schema;
        await migrate(connection, createdSchema);
        const snapshot = await runPersistenceProcess('write', process.env.TEST_DATABASE_URL, createdSchema);
        await file.writeFile(JSON.stringify({ version: 1, database, schema: createdSchema, snapshot }, null, 2));
        createdSchema = undefined; // Preserve it until the verify phase.
      } catch (error) {
        await fs.unlink(stateFile);
        throw error;
      } finally { await file.close(); }
      console.log('Test records saved. All Node connections are closing. Restart PostgreSQL, then run npm run test:restart:verify.');
    } else if (phase === 'verify') {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state.version !== 1 || state.database !== database || !/^skao_restart_[a-f0-9]{32}$/.test(state.schema)) {
        throw new Error('Restart checkpoint does not match this test database.');
      }
      const snapshot = await runPersistenceProcess('read', process.env.TEST_DATABASE_URL, state.schema);
      if (!isDeepStrictEqual(snapshot, state.snapshot)) {
        throw new Error('Records changed across restart. Test records and checkpoint are preserved for inspection.');
      }
      await connection.dropSchema(state.schema, { cascade: true });
      await fs.unlink(stateFile);
      console.log('PASS: meal IDs, ingredients, recipes, saved menu, shelf quantities and shopping results survived restart. Test records removed.');
    } else {
      throw new Error('Use npm run test:restart:prepare or npm run test:restart:verify.');
    }
  } catch (error) {
    const message = error.code === 'EEXIST'
      ? 'A restart check is already prepared. Restart PostgreSQL and run npm run test:restart:verify.'
      : error.code === 'ENOENT' ? 'Run npm run test:restart:prepare first.'
      : error.name.startsWith('Sequelize') ? 'Restart test could not access PostgreSQL. Check TEST_DATABASE_URL and database availability.'
      : error.message;
    console.error(message);
    process.exitCode = 1;
  } finally {
    try { if (createdSchema) await connection.dropSchema(createdSchema, { cascade: true }); }
    finally { await connection?.close(); }
  }
})();
