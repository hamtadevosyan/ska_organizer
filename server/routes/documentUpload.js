const express = require('express');

// Child files and facility blanks share two process-wide slots. Reserve before
// parsing either body, then retain the slot through its database transaction.
let uploads = 0;
function reserve(req, res, next) {
  if (uploads >= 2) return res.status(429).set('Retry-After', '5').json({ error: {
    message: 'Two documents are being uploaded. Try again in a moment.', code: 'DOCUMENT_BUSY' } });
  uploads++;
  let released = false;
  const release = () => {
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
const parser = express.json({ limit: '7mb' });
const parse = (req, res, next) => parser(req, res, (error) => {
  if (error?.type === 'entity.too.large') return next(Object.assign(new Error('Choose a file no larger than 5 MB.'),
    { status: 413, code: 'DOCUMENT_INVALID' }));
  next(error);
});
module.exports = { reserve, upload, parse };
