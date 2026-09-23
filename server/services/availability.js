const db = require('./dbAdapter');

exports.ready = async (_req, res) => {
  try {
    await db.health();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
};
exports.databaseUnavailable = (error) => [
  'SequelizeConnectionError', 'SequelizeConnectionRefusedError', 'SequelizeHostNotFoundError',
  'SequelizeHostNotReachableError', 'SequelizeConnectionTimedOutError', 'SequelizeConnectionAcquireTimeoutError',
  'SequelizeInvalidConnectionError',
].includes(error?.name) || (error?.name === 'SequelizeDatabaseError' &&
  /^(08[A-Z0-9]{3}|57P0[123])$/.test(error.parent?.code || error.original?.code || ''));
