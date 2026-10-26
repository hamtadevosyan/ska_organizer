const express = require('express');
const { requireSession, requireAdmin, requireOperationalAccess } = require('../auth/middleware');
const service = require('../services/ccrcStatementsService');
const { reserve, parse, upload } = require('./documentUpload');
const router = express.Router();
router.use(requireSession, requireAdmin, requireOperationalAccess);
const json = fn => async (req, res) => res.json({ data: await fn(req) });
router.get('/', json(req => service.list(req.sessionToken)));
router.get('/:id', json(req => service.get(req.sessionToken, req.params.id)));
router.put('/:id/review', json(req => service.review(req.sessionToken, req.params.id, req.body || {})));
for (const action of ['post', 'cancel', 'reopen']) router.post('/:id/' + action, json(req => service[action](req.sessionToken, req.params.id, req.body || {})));
router.get('/:id/content', async (req, res) => {
  const file = await service.content(req.sessionToken, req.params.id);
  res.set({ 'Content-Type': file.contentType, 'Content-Disposition': 'attachment; filename="ccrc-statement' + (file.contentType === 'application/pdf' ? '.pdf' : file.contentType === 'image/png' ? '.png' : '.jpg') + '"',
    'Content-Length': String(file.content.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Frame-Options': 'DENY' });
  res.send(file.content);
});
exports.mount = app => {
  // Authorize before parsing large bodies or reserving the bounded extraction
  // slot. A disconnected request cancels OCR and never registers payments.
  app.post('/api/billing/statements', requireSession, requireAdmin, requireOperationalAccess, reserve, parse, upload(async req => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    req.res.once('close', abort);
    try { return { data: await service.upload(req.sessionToken, req.body || {}, { signal: controller.signal }) }; }
    finally { req.off('aborted', abort); req.res.off('close', abort); }
  }));
  app.use('/api/billing/statements', requireSession, requireAdmin, requireOperationalAccess, express.json({ limit: '4mb' }), router);
};
