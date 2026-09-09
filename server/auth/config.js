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
module.exports = {
  origins: new Set(origins), cookieName: 'skao_session',
  cookieOptions: { httpOnly: true, secure: production, sameSite: 'strict', path: '/api' },
  absoluteMs: 8 * 60 * 60 * 1000, idleMs: 30 * 60 * 1000,
};
