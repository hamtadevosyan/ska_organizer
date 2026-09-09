require('../config/environment');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const db = require('../services/dbAdapter');
const auth = require('../auth/service');

(async () => {
  let terminal;
  try {
    if (!db.setup) throw new Error('Administrator setup requires persistent PostgreSQL storage.');
    await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA || 'public' });
    if ((await db.listAccounts()).length) throw new Error('Accounts already exist. Sign in as an administrator to manage access.');
    let username, displayName, password;
    if (process.argv.includes('--password-stdin')) {
      // Intended for automation: non-secret identity in env, password only on stdin.
      username = process.env.ADMIN_USERNAME;
      displayName = process.env.ADMIN_DISPLAY_NAME;
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 1024) throw new Error('Password input is too long.');
        chunks.push(chunk);
      }
      password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    } else {
      if (!process.stdin.isTTY) throw new Error('Use an interactive terminal or --password-stdin.');
      let hidden = false;
      const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
      terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
      username = await terminal.question('Administrator username: ');
      displayName = await terminal.question('Display name: ');
      process.stdout.write('Password (15–128 characters; input hidden): ');
      hidden = true;
      password = await terminal.question('');
      process.stdout.write('\nConfirm password: ');
      const confirm = await terminal.question('');
      hidden = false;
      process.stdout.write('\n');
      if (password !== confirm) throw new Error('Passwords do not match.');
    }
    await auth.bootstrap({ username, displayName, password });
    console.log('Administrator created. You can now sign in.');
  } catch (error) {
    console.error(error.name?.startsWith('Sequelize') ? 'Account setup failed. Check PostgreSQL configuration and migrations.' : error.message);
    process.exitCode = 1;
  } finally { terminal?.close(); await db.close?.(); }
})();
