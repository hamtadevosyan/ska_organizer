const express = require('express');
const db = require('../services/dbAdapter');
const auth = require('./service');
const config = require('./config');
const { requireSession, requireAdmin, clearCookie, readToken } = require('./middleware');
const router = express.Router();
function sendSession(res, session) {
  res.cookie(config.cookieName, session.token, { ...config.cookieOptions, maxAge: config.absoluteMs });
  res.json({ account: session.account, csrfToken: session.csrfToken });
}
router.post('/login', async (req, res) => {
  const session = await auth.login(req.body || {}, req.ip, readToken(req));
  sendSession(res, session);
});
router.use(requireSession);
router.get('/session', (req, res) => res.json({ account: auth.publicAccount(req.account), csrfToken: auth.csrfToken(req.sessionToken) }));
router.post('/logout', async (req, res) => {
  await auth.logout(req.sessionToken);
  clearCookie(res);
  res.status(204).send();
});
router.post('/password', async (req, res) => {
  sendSession(res, await auth.changePassword(req.sessionToken, req.body?.currentPassword, req.body?.password, req.ip));
});
const admin = express.Router();
admin.use(requireSession, requireAdmin);
admin.get('/accounts', async (req, res) => res.json({ data: (await db.listAccounts()).map(auth.publicAccount) }));
admin.post('/accounts', async (req, res) => res.status(201).json({ data: await auth.createAccount(req.sessionToken, req.body || {}) }));
admin.put('/accounts/:id', async (req, res) => res.json({ data: await auth.updateAccount(req.sessionToken, req.params.id, req.body || {}) }));
admin.post('/accounts/:id/password', async (req, res) => {
  await auth.resetPassword(req.sessionToken, req.params.id, req.body?.password);
  res.status(204).send();
});
admin.get('/audit', async (req, res) => {
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw auth.problem('Invalid audit page.');
  res.json({ data: await db.listAudit({ limit, offset }) });
});
module.exports = { router, admin };
