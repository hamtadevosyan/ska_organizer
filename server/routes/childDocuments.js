const express = require('express');
const service = require('../services/childDocumentsService');
const { requireSession, requireDocumentAccess } = require('../auth/middleware');
const { reserve, parse, upload } = require('./documentUpload');
const contentResponse = require('./documentContent');

const router = express.Router({ mergeParams: true });
router.use(requireDocumentAccess(false));
const json = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (error) { next(error); }
};
router.get('/', json((req) => service.list(req.sessionToken, req.params.childId, req.query)));
router.get('/checklist', json((req) => service.checklist(req.sessionToken, req.params.childId, req.query)));
router.get('/:documentId', json((req) => service.get(req.sessionToken, req.params.childId, req.params.documentId, req.query)));
router.put('/:documentId', requireDocumentAccess(true), json((req) => service.update(req.sessionToken, req.params.childId, req.params.documentId, req.body)));
router.put('/:documentId/review', requireDocumentAccess(true), json((req) => service.review(req.sessionToken, req.params.childId, req.params.documentId, req.body)));
router.get('/:documentId/revisions/:revisionId/content', async (req, res, next) => {
  try {
    const file = await service.content(req.sessionToken, req.params.childId, req.params.documentId, req.params.revisionId, req.query);
    contentResponse(res, file);
  } catch (error) { next(error); }
});

exports.mountUploads = (app) => {
  const protection = [requireSession, requireDocumentAccess(true), reserve, parse];
  app.post('/api/children/:childId/documents', ...protection,
    upload((req) => service.create(req.sessionToken, req.params.childId, req.body)));
  app.post('/api/children/:childId/documents/:documentId/revisions', ...protection,
    upload((req) => service.revise(req.sessionToken, req.params.childId, req.params.documentId, req.body)));
};
exports.router = router;
