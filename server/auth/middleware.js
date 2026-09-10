const { timingSafeEqual } = require('node:crypto');
const db = require('../services/dbAdapter');
const auth = require('./service');
const config = require('./config');
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const clearCookie = (res) => res.clearCookie(config.cookieName, config.cookieOptions);
function readToken(req) {
  const values = (req.headers.cookie || '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${config.cookieName}=`));
  return values.length === 1 ? values[0].slice(config.cookieName.length + 1) : undefined;
}
function originGuard(req, res, next) {
  const origin = req.get('Origin');
  if ((origin && !config.origins.has(origin)) || (!safeMethods.has(req.method) && !origin)) {
    return next(auth.problem('This request did not come from an allowed application address.', 403, 'UNTRUSTED_ORIGIN'));
  }
  if (!safeMethods.has(req.method) && (req.get('Content-Type') || req.path === '/auth/login') && !/^application\/json(?:\s*;|$)/i.test(req.get('Content-Type') || '')) return next(auth.problem('Send a JSON request.', 415));
  next();
}
async function requireSession(req, res, next) {
  try {
    req.sessionToken = readToken(req);
    req.account = await auth.sessionAccount(req.sessionToken);
    if (!safeMethods.has(req.method)) {
      const supplied = req.get('X-CSRF-Token') || '';
      const expected = auth.csrfToken(req.sessionToken);
      if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw auth.problem('Your security token is missing or out of date. Reload the page and try again.', 403, 'CSRF_INVALID');
      }
    }
    next();
  } catch (error) { if (error.status === 401) clearCookie(res); next(error); }
}
function isOperationalWrite(req) {
  if (safeMethods.has(req.method)) return false;
  // These endpoints calculate drafts only; none persist changes.
  const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
  return !(req.method === 'POST' && (path === '/api/shopping/generate' ||
    /^\/api\/menu\/plans\/[^/]+\/(preview|import-preview)$/.test(path)));
}
async function requireOperationalAccess(req, res, next) {
  try {
    auth.operationalPermission(req.account, isOperationalWrite(req));
    await auth.sessionAccount(req.sessionToken, { touch: true });
    next();
  } catch (error) { next(error); }
}
async function requireAdmin(req, res, next) {
  try { req.account = await auth.administrator(req.sessionToken); next(); }
  catch (error) { next(error); }
}
// Existing controllers use status/json/send. Buffer the response until both the
// mutation and audit insert commit; never acknowledge a change before its audit.
function audited(action, controller) {
  return async (req, res, next) => {
    const response = {
      statusCode: 200, kind: 'json', body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.kind = 'json'; this.body = body; return this; },
      send(body) { this.kind = 'send'; this.body = body; return this; },
    };
    try {
      await db.withAuthLock(async () => {
        req.account = await auth.sessionAccount(req.sessionToken);
        auth.operationalPermission(req.account, true);
        await controller(req, response, (error) => { throw error || new Error('Controller did not complete.'); });
        if (response.statusCode >= 400) throw Object.assign(new Error('Controller rejected request.'), { bufferedResponse: true });
        const id = response.body?.data?.id || response.body?.id || req.params.id || req.params.weekStart || req.params.mealId || null;
        await auth.audit(req.account, action, id);
      });
    } catch (error) {
      if (!error.bufferedResponse) return next(error);
    }
    res.status(response.statusCode)[response.kind](response.body);
  };
}
module.exports = { originGuard, requireSession, requireOperationalAccess, requireAdmin, audited, readToken, clearCookie };
