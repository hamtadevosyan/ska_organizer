// Keep test HTTP origins independent of the development VM configuration.
process.env.APP_ORIGINS = 'http://localhost:5173';
const { randomUUID } = require('node:crypto');
const db = require('../services/dbAdapter');
const { createConnection, validateDatabaseUrl } = require('../database/connection');
const { migrate } = require('../database/migrate');
let connection;
let schema;

async function setupStep(label, operation) {
  // Identify a slow fixture step without printing SQL, URLs or credentials.
  const warning = setTimeout(() => console.warn(`Test setup is still ${label} after 20 seconds.`), 20000);
  warning.unref();
  try { await operation(); }
  finally { clearTimeout(warning); }
}

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
    const tables = ['PurchaseReceipts', 'InventoryMovements', 'InventoryItems', 'InventoryGroups', 'MealIngredients', 'Meals', 'Ingredients', 'ConfirmedMenus', 'ShelfChecks', 'WeeklyPlans', 'Children', 'AttendanceCorrections', 'Attendances', 'Activities', 'ScheduleEntries', 'ScheduleWeeks', 'StaffMembers', 'Rooms', 'AuditEvents', 'Sessions', 'LoginAttempts', 'Accounts'];
    await setupStep('clearing the PostgreSQL test tables', () =>
      connection.query(`TRUNCATE ${tables.map((t) => `"${schema}"."${t}"`).join(', ')} CASCADE`));
  }
  await setupStep('creating and signing in the test administrator', () =>
    require('./helpers/authenticatedRequest').initialize(require('../index')));
// Allow slower VM fixture setup; keep the existing timeout for each test body.
}, process.env.DB_ADAPTER === 'sequelize' ? 60000 : 30000);

afterAll(async () => {
  if (!connection) return;
  await db.close();
  try { await connection.dropSchema(schema, { cascade: true }); }
  finally { await connection.close(); }
});

module.exports = { context: () => ({ connection, schema }) };
