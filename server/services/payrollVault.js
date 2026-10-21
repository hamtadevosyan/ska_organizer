const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const fs = require('node:fs');
const { problem } = require('../auth/service');
function key() {
  if (!process.env.PAYROLL_KEY_FILE) throw problem('Payroll is locked. Configure PAYROLL_KEY_FILE with your private encryption key.', 409, 'PAYROLL_LOCKED');
  try {
    const stat = fs.statSync(process.env.PAYROLL_KEY_FILE);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Permissions');
    const value = fs.readFileSync(process.env.PAYROLL_KEY_FILE, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Format');
    return Buffer.from(value, 'hex');
  } catch { throw problem('Payroll encryption key is unavailable or insecure. Restore the original key and restrict its permissions to its owner.', 409, 'PAYROLL_LOCKED'); }
}
const aad = row => Buffer.from(JSON.stringify([row.id, row.staffId, row.kind, row.version]));
exports.seal = (row, value) => {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(aad(row));
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > 16 * 1024 * 1024) throw problem('Payroll record is too large. Archive older records before adding more.', 413);
  return [iv.toString('hex'), cipher.update(plain).toString('hex') + cipher.final().toString('hex'), cipher.getAuthTag().toString('hex')].join('.');
};
exports.open = row => {
  const secret = key();
  try {
    const [iv, content, tag] = row.ciphertext.split('.');
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'hex'));
    decipher.setAAD(aad(row)); decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(content, 'hex')), decipher.final()]).toString('utf8'));
  } catch { throw problem('Payroll data could not be decrypted. Restore the correct encryption key; do not create a replacement key.', 409, 'PAYROLL_LOCKED'); }
};
exports.check = key;
