const express = require('express');
const service = require('../services/organizerAssistant');
const router = express.Router();
function handle(operation) {
  return async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const data = await operation(req, controller.signal);
      if (!res.destroyed) res.json({ data });
    } catch (error) {
      if (res.destroyed) return;
      if (error.code?.startsWith('AI_')) {
        if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
        return res.status(error.status || 424).json({ error: { code: error.code, message: error.message } });
      }
      next(error);
    } finally { res.off('close', cancel); }
  };
}
router.get('/options', handle((req, signal) => service.options(req.sessionToken, signal)));
router.post('/summary', handle((req, signal) => service.answer(req.sessionToken, req.body, { signal })));
module.exports = router;
