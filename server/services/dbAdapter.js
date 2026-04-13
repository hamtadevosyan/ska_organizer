// server/services/dbAdapter.js
// Runtime adapter switch: 'mock' (default) or 'sequelize'
const adapterName = process.env.DB_ADAPTER || 'mock';

if (adapterName === 'sequelize') {
  module.exports = require('./dbAdapter.sequelize');
} else {
  module.exports = require('./dbAdapter.mock');
}

