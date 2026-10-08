const express = require('express');
const service = require('../services/registrationFormsService');
const { requireSession, requireDocumentAccess, requireAdmin } = require('../auth/middleware');
const { reserve, parse, upload } = require('./documentUpload');
const contentResponse = require('./documentContent');

const router = express.Router();
router.use(requireDocumentAccess(false));
const json = (fn) => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (error) { next(error); }
};
router.get('/', json((req) => service.list(req.sessionToken, req.query)));
router.get('/:formId', json((req) => service.get(req.sessionToken, req.params.formId, req.query)));
router.put('/:formId', requireAdmin, json((req) => service.update(req.sessionToken, req.params.formId, req.body)));
router.get('/:formId/revisions/:revisionId/content', async (req, res, next) => {
  try { contentResponse(res, await service.content(req.sessionToken, req.params.formId, req.params.revisionId, req.query)); }
  catch (error) { next(error); }
});
exports.mountUploads = (app) => {
  const protection = [requireSession, requireAdmin, reserve, parse];
  app.post('/api/registration-forms', ...protection, upload((req) => service.create(req.sessionToken, req.body)));
  app.post('/api/registration-forms/:formId/revisions', ...protection,
    upload((req) => service.revise(req.sessionToken, req.params.formId, req.body)));
};
exports.router = router;
