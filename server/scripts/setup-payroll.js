require('../config/environment');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { randomBytes } = require('node:crypto');
const db = require('../services/dbAdapter');
(async () => {
  if (process.env.NODE_ENV === 'test' || !db.setup) throw new Error('Run this setup against the migrated local PostgreSQL application database, as its normal service user.');
  await db.setup(process.env.DATABASE_URL, { schema: process.env.DB_SCHEMA || 'public' });
  if (process.env.PAYROLL_KEY_FILE) { require('../services/payrollVault').check(); const first = await db.firstPayrollRecord(); if (first) require('../services/payrollVault').open(first); console.log('Existing payroll encryption key verified. No key was changed.'); return; }
  if (await db.countPayrollRecords()) throw new Error('Encrypted payroll records already exist. Restore and configure the original key; a replacement key must not be created.');
  const directory = path.join(os.homedir(), '.config', 'skao'); fs.mkdirSync(directory,{ recursive: true, mode: 0o700 });
  if (fs.statSync(directory).mode & 0o077) throw new Error('The payroll key directory must be private to its owner (mode 700).');
  const target = path.join(directory,'payroll.key');
  if (fs.existsSync(target)) throw new Error('An existing key file was found. Verify it and configure PAYROLL_KEY_FILE in server/.env; it was not overwritten.');
  const envFile = path.join(__dirname,'../.env'); const original = fs.readFileSync(envFile,'utf8');
  if (/^\s*PAYROLL_KEY_FILE\s*=/m.test(original)) throw new Error('An existing PAYROLL_KEY_FILE setting needs review. No key was created.');
  fs.writeFileSync(target,randomBytes(32).toString('hex')+'\n',{ flag:'wx',mode:0o600 });
  fs.appendFileSync(envFile,'\nPAYROLL_KEY_FILE='+JSON.stringify(target)+'\n');
  console.log('Created a private payroll key and configured server/.env. Back up the key offline separately from the database; restore both together. No wages or payroll records were created.');
})().catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => db.close());
