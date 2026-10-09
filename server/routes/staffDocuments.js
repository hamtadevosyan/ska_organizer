const express = require('express');
const service = require('../services/staffDocumentsService');
const { requireSession, requireAdmin } = require('../auth/middleware');
const { reserve, parse, upload } = require('./documentUpload');
const contentResponse = require('./documentContent');
const ocr = require('../services/staffDocumentOcr');

const router = express.Router({ mergeParams: true });
router.use(requireAdmin);
const json = (fn) => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (error) { next(error); }
};
router.get('/', json((req) => service.list(req.sessionToken, req.params.staffId, req.query)));
router.get('/checklist', json((req) => service.checklist(req.sessionToken, req.params.staffId, req.query)));
router.get('/:documentId', json((req) => service.get(req.sessionToken, req.params.staffId, req.params.documentId, req.query)));
router.put('/:documentId', json((req) => service.update(req.sessionToken, req.params.staffId, req.params.documentId, req.body)));
router.put('/:documentId/review', json((req) => service.review(req.sessionToken, req.params.staffId, req.params.documentId, req.body)));
router.get('/:documentId/revisions/:revisionId/content', async (req, res, next) => {
  try { contentResponse(res, await service.content(req.sessionToken, req.params.staffId, req.params.documentId, req.params.revisionId, req.query)); }
  catch (error) { next(error); }
});
const compliance = express.Router();
compliance.get('/', json((req) => service.compliance(req.sessionToken, req.query)));
compliance.get('/settings', json((req) => service.getSettings(req.sessionToken, req.query)));
compliance.put('/settings', requireAdmin, json((req) => service.updateSettings(req.sessionToken, req.body)));
exports.mountUploads = (app) => {
  const protection = [requireSession, requireAdmin, reserve, parse];
  app.post('/api/staff/:staffId/documents/expiration-check', requireSession, requireAdmin, ocr.reserve, parse,
    async (req, res, next) => {
      req.staffDocumentOcrProcessing = true;
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', cancel);
      try {
        const result = await ocr.checkExpiration(req.sessionToken, req.params.staffId, req.body,
          { signal: controller.signal, query: req.query });
        if (!res.destroyed) res.json(result);
      } catch (error) {
        if (res.destroyed) return;
        if (error.code?.startsWith('STAFF_DOCUMENT_OCR_')) {
          if (error.status === 429) res.set('Retry-After', '5');
          return res.status(error.status).json({ error: { message: error.message, code: error.code } });
        }
        next(error);
      } finally {
        res.off('close', cancel); req.staffDocumentOcrProcessing = false; req.releaseStaffDocumentOcrSlot?.();
      }
    });
  app.post('/api/staff/:staffId/documents', ...protection, upload((req) => service.create(req.sessionToken, req.params.staffId, req.body)));
  app.post('/api/staff/:staffId/documents/:documentId/revisions', ...protection,
    upload((req) => service.revise(req.sessionToken, req.params.staffId, req.params.documentId, req.body)));
};
exports.router = router;
exports.compliance = compliance;
