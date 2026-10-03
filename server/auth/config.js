require('../config/environment');
const production = process.env.NODE_ENV === 'production';
const configured = process.env.APP_ORIGINS;
if (production && !configured) throw new Error('APP_ORIGINS must list the HTTPS frontend origins in production.');
const origins = (configured || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((value) => value.trim());
for (const origin of origins) {
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('APP_ORIGINS must contain comma-separated origins, without paths.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || (production && parsed.protocol !== 'https:')) {
    throw new Error('APP_ORIGINS must contain exact HTTP origins (HTTPS in production), without paths.');
  }
}
// Remembered sessions are optional and bounded, including on misconfiguration.
const dayMs = 24 * 60 * 60 * 1000;
function days(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 90) {
    throw new Error(`${name} must be a whole number from 1 to 90 days.`);
  }
  return Number(value) * dayMs;
}
const rememberAbsoluteMs = days('REMEMBER_SESSION_ABSOLUTE_DAYS', 30);
const rememberIdleMs = days('REMEMBER_SESSION_IDLE_DAYS', 7);
if (rememberIdleMs > rememberAbsoluteMs) throw new Error('Remembered session idle expiry cannot exceed absolute expiry.');
module.exports = {
  origins: new Set(origins), cookieName: 'skao_session',
  cookieOptions: { httpOnly: true, secure: production, sameSite: 'strict', path: '/api' },
  absoluteMs: 8 * 60 * 60 * 1000, idleMs: 30 * 60 * 1000,
  rememberAbsoluteMs, rememberIdleMs,
};
