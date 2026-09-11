// Keep test HTTP origins independent of the development VM configuration.
process.env.APP_ORIGINS = 'http://localhost:5173';
const { randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const { createConnection, validateDatabaseUrl } = require('../database/connection');
const { migrate } = require('../database/migrate');
let connection;
let schema;

beforeAll(async () => {
  if (process.env.DB_ADAPTER !== 'sequelize') return;
  const url = validateDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.NODE_ENV !== 'test' || !decodeURIComponent(url.pathname).endsWith('_test')) {
    throw new Error('PostgreSQL tests require NODE_ENV=test and a database ending in _test.');
  }
  schema = `skao_test_${randomUUID().replaceAll('-', '')}`;
  connection = createConnection(process.env.DATABASE_URL, { schema });
  await connection.createSchema(schema);
  await migrate(connection, schema);
  await db.setup(process.env.DATABASE_URL, { schema });
});

beforeEach(async () => {
  if (!connection) db.reset();
  else {
  const tables = ['MealIngredients', 'Meals', 'Ingredients', 'ConfirmedMenus', 'ShelfChecks', 'WeeklyPlans', 'Children', 'Attendances', 'Activities', 'ScheduleEntries', 'Rooms', 'AuditEvents', 'Sessions', 'LoginAttempts', 'Accounts'];
  await connection.query(`TRUNCATE ${tables.map((t) => `"${schema}"."${t}"`).join(', ')} CASCADE`);
  }
  await require('./helpers/authenticatedRequest').initialize(require('../index'));
});

afterAll(async () => {
  if (!connection) return;
  await db.close();
  try { await connection.dropSchema(schema, { cascade: true }); }
  finally { await connection.close(); }
});

module.exports = { context: () => ({ connection, schema }) };
