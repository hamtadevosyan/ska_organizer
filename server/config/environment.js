const path = require('node:path');

// Tests receive explicit settings, never a developer's database configuration.
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
