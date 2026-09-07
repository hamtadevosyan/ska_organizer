require('../config/environment');
const { createConnection } = require('../database/connection');
const { migrate } = require('../database/migrate');
const { seedDevelopment } = require('../database/seed-development');

(async () => {
  let connection;
  try {
    const operation = process.argv[2];
    if (!['migrate', 'seed'].includes(operation)) throw new Error('Use npm run db:migrate or npm run db:seed.');
    const schema = process.env.DB_SCHEMA || 'public';
    connection = createConnection(process.env.DATABASE_URL, { schema });
    await connection.authenticate();
    if (operation === 'migrate') {
      const applied = await migrate(connection, schema);
      console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database migrations are up to date.');
    } else {
      const result = await seedDevelopment(connection, schema);
      console.log(result.seeded ? 'Development meal examples created.' : result.reason);
    }
  } catch (error) {
    const message = error.name.startsWith('Sequelize')
      ? 'Database operation failed. Check PostgreSQL availability, credentials and schema permissions.' : error.message;
    console.error(message);
    process.exitCode = 1;
  } finally {
    await connection?.close();
  }
})();
