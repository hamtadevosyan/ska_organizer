const express = require('express');
const service = require('../services/childDocumentsService');
const { requireSession, requireDocumentAccess } = require('../auth/middleware');

const router = express.Router({ mergeParams: true });
router.use(requireDocumentAccess(false));
const json = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (error) { next(error); }
};
router.get('/', json((req) => service.list(req.sessionToken, req.params.childId, req.query)));
router.get('/:documentId', json((req) => service.get(req.sessionToken, req.params.childId, req.params.documentId, req.query)));
router.put('/:documentId', requireDocumentAccess(true), json((req) => service.update(req.sessionToken, req.params.childId, req.params.documentId, req.body)));
router.get('/:documentId/revisions/:revisionId/content', async (req, res, next) => {
  try {
    const file = await service.content(req.sessionToken, req.params.childId, req.params.documentId, req.params.revisionId, req.query);
    const asciiName = file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encodedName = encodeURIComponent(file.filename).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.set({ 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache', 'Expires': '0',
      'Content-Type': file.contentType, 'Content-Length': String(file.byteLength),
      'Content-Disposition': (file.download ? 'attachment' : 'inline') + '; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodedName,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'",
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.status(200).end(file.content);
  } catch (error) { next(error); }
});

// Reserve before parsing: at most two document upload bodies are held by each
// process, and unauthenticated/unpermitted accounts never reach this parser.
let uploads = 0;
function reserve(req, res, next) {
  if (uploads >= 2) return res.status(429).set('Retry-After', '5').json({ error: {
    message: 'Two documents are being uploaded. Try again in a moment.', code: 'DOCUMENT_BUSY' } });
  uploads++;
  let released = false;
  const release = () => {
    // A disconnected, already-parsed request may still be waiting for a database
    // transaction. Keep its slot until that operation settles; otherwise repeated
    // disconnects could queue unlimited large bodies behind the auth lock.
    if (released || req.documentUploadProcessing) return;
    released = true; uploads--; res.off('finish', release); res.off('close', release);
  };
  req.releaseDocumentSlot = release;
  res.once('finish', release); res.once('close', release); next();
}
const upload = (fn) => async (req, res, next) => {
  req.documentUploadProcessing = true;
  try { const body = await fn(req); if (!res.destroyed) res.status(201).json(body); }
  catch (error) { if (!res.destroyed) next(error); }
  finally { req.documentUploadProcessing = false; req.releaseDocumentSlot?.(); }
};
const uploadParser = express.json({ limit: '7mb' });
exports.mountUploads = (app) => {
  const protection = [requireSession, requireDocumentAccess(true), reserve, (req, res, next) => uploadParser(req, res, (error) => {
    if (error?.type === 'entity.too.large') return next(Object.assign(new Error('Choose a file no larger than 5 MB.'), { status: 413, code: 'DOCUMENT_INVALID' }));
    next(error);
  })];
  app.post('/api/children/:childId/documents', ...protection,
    upload((req) => service.create(req.sessionToken, req.params.childId, req.body)));
  app.post('/api/children/:childId/documents/:documentId/revisions', ...protection,
    upload((req) => service.revise(req.sessionToken, req.params.childId, req.params.documentId, req.body)));
};
exports.router = router;
