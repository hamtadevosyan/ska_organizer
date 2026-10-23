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
const sessionMiddleware = allowOffClock => async (req, res, next) => {
  try {
    if (await require('../services/clockStationService').hasActiveStation(require('../routes/clockStations').readCredential(req))) throw auth.problem('This device is a clock station. Sign out of station mode before using a personal account.', 403, 'STATION_MODE');
    req.sessionToken = readToken(req);
    req.account = await auth.sessionAccount(req.sessionToken, { allowOffClock });
    if (!safeMethods.has(req.method)) {
      const supplied = req.get('X-CSRF-Token') || '';
      const expected = auth.csrfToken(req.sessionToken);
      if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        throw auth.problem('Your security token is missing or out of date. Reload the page and try again.', 403, 'CSRF_INVALID');
      }
    }
    next();
  } catch (error) { if (error.status === 401) clearCookie(res); next(error); }
};
const requireSession = sessionMiddleware(false);
// Used only on the three safe account-session routes, never resource routes.
const requireAuthSession = sessionMiddleware(true);
function isOperationalWrite(req) {
  if (safeMethods.has(req.method)) return false;
  // These endpoints calculate drafts only; none persist changes.
  const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
  return !(req.method === 'POST' && (path === '/api/shopping/generate' || path === '/api/schedule/plan/preview' ||
    /^\/api\/menu\/plans\/[^/]+\/(preview|import-preview)$/.test(path) ||
    /^\/api\/purchasing\/[^/]+\/preview$/.test(path)));
}
async function requireOperationalAccess(req, res, next) {
  try {
    // Authorization must use the current account, including a concurrently
    // changed role. Class viewers use only the dedicated bounded projections.
    req.account = await auth.sessionAccount(req.sessionToken, { touch: true });
    if (['viewer', 'teacher'].includes(req.account.role)) throw auth.problem('Use your assigned class to view information.', 403, 'CLASSROOM_ONLY');
    auth.operationalPermission(req.account, isOperationalWrite(req));
    next();
  } catch (error) { next(error); }
}
async function requireAdmin(req, res, next) {
  try { req.account = await auth.administrator(req.sessionToken); next(); }
  catch (error) { next(error); }
}
function requireDocumentAccess(write = false) {
  return async (req, res, next) => {
    try {
      // Never grant document access using an account captured before a concurrent
      // administrator changed its permissions or revoked the current session.
      req.account = await auth.sessionAccount(req.sessionToken);
      auth.documentPermission(req.account, write);
      next();
    } catch (error) { if (error.status === 401) clearCookie(res); next(error); }
  };
}
// Existing controllers use status/json/send. Buffer the response until both the
// mutation and audit insert commit; never acknowledge a change before its audit.
function audited(action, controller, { adminOnly = false, skipReplayed = false } = {}) {
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
        if (adminOnly && req.account.role !== 'admin') throw auth.problem('Administrator access is required.', 403, 'FORBIDDEN');
        await controller(req, response, (error) => { throw error || new Error('Controller did not complete.'); });
        if (response.statusCode >= 400) throw Object.assign(new Error('Controller rejected request.'), { bufferedResponse: true });
        const id = response.body?.data?.id || response.body?.data?.batch?.id || response.body?.id || req.params.id || req.params.weekStart || req.params.mealId || null;
        if (!skipReplayed || response.body?.data?.replayed !== true) await auth.audit(req.account, action, id);
      });
    } catch (error) {
      if (!error.bufferedResponse) return next(error);
    }
    res.status(response.statusCode)[response.kind](response.body);
  };
}
module.exports = { originGuard, requireSession, requireAuthSession, requireOperationalAccess, requireDocumentAccess, requireAdmin, audited, readToken, clearCookie };
