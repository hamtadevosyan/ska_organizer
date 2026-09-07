// server/services/dbAdapter.js
require('../config/environment');
// Memory storage must be explicitly requested outside tests.
const adapterName = process.env.DB_ADAPTER || (process.env.NODE_ENV === 'test' ? 'mock' : 'sequelize');

if (adapterName === 'sequelize') {
  module.exports = require('./dbAdapter.sequelize');
} else if (adapterName === 'mock' && process.env.NODE_ENV !== 'production') {
  module.exports = require('./dbAdapter.mock');
} else {
  throw new Error('DB_ADAPTER must be sequelize, or mock for development/tests only.');
}
