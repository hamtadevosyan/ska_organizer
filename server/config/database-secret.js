const fs = require('node:fs');

// Compose mounts the password as a file. Keep it out of image layers, Compose
// output and command arguments; URL-encode it exactly once for Sequelize.
module.exports = function configureDatabaseSecret(env = process.env, read = fs.readFileSync) {
  if (!env.DATABASE_PASSWORD_FILE) return;
  if (env.DATABASE_URL) throw new Error('Configure DATABASE_URL or DATABASE_PASSWORD_FILE, not both.');
  const { DATABASE_HOST: host, DATABASE_NAME: name, DATABASE_USER: user } = env;
  const port = env.DATABASE_PORT || '5432';
  if (!/^[a-zA-Z0-9.-]+$/.test(host || '') || !/^[a-z][a-z0-9_]{0,62}$/.test(name || '') ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(user || '') || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('DATABASE_HOST, DATABASE_NAME, DATABASE_USER and DATABASE_PORT must identify the pilot database.');
  }
  let password;
  try { password = read(env.DATABASE_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, ''); }
  catch { throw new Error('Could not read DATABASE_PASSWORD_FILE. Check the mounted secret.'); }
  if (!password || /[\r\n\0]/.test(password)) throw new Error('DATABASE_PASSWORD_FILE must contain one non-empty password.');
  env.DATABASE_URL = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
};
