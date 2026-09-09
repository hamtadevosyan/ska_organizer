const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const prefix = 'scrypt$131072$8$1';

function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128 || Buffer.byteLength(password) > 512) {
    const error = new Error('Use a password between 15 and 128 characters. Spaces are allowed.');
    error.status = 400;
    throw error;
  }
}
async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, options);
  return `${prefix}$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 512 || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.slice(0, 4).join('$') !== prefix || parts.length !== 6 || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const actual = await derive(password, parts[4], 64, options);
  return timingSafeEqual(actual, Buffer.from(parts[5], 'hex'));
}
let dummyHash;
const verifyUnknown = async (password) => {
  dummyHash ||= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
};
module.exports = { hashPassword, verifyPassword, verifyUnknown, validatePassword };
