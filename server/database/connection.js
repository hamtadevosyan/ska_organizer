const { Sequelize } = require('sequelize');

function validateDatabaseUrl(connectionString) {
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL must be a PostgreSQL URL. Configure server/.env.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error('DATABASE_URL must name a PostgreSQL host and database; in-memory databases are not supported.');
  }
  return url;
}

function createConnection(connectionString, { schema = 'public' } = {}) {
  validateDatabaseUrl(connectionString);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema name.');
  return new Sequelize(connectionString, {
    dialect: 'postgres', logging: false, define: { schema },
    pool: { max: 5, min: 0, acquire: 10000, idle: 1000 },
    dialectOptions: { connectionTimeoutMillis: 5000 },
  });
}

module.exports = { createConnection, validateDatabaseUrl };
