const express = require('express');
const service = require('../services/localActivityAi');
const auth = require('../auth/service');
const media = require('../services/activityMedia');
const sendContent = require('./documentContent');
const router = express.Router();

async function currentPermission(req) {
  req.account = await auth.sessionAccount(req.sessionToken);
  auth.operationalPermission(req.account, true);
}

function handle(operation) {
  return async (req, res, next) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      await currentPermission(req);
      const data = await operation(req, controller.signal);
      // Inference can take time. Do not return protected data after revocation,
      // role changes or checkout while the runtime was working.
      await currentPermission(req);
      if (!res.destroyed) res.json({ data });
    } catch (error) {
      controller.abort();
      if (res.destroyed) return;
      if (error.code?.startsWith('AI_')) {
        if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
        return res.status(error.status || 424).json({ error: { code: error.code, message: error.message } });
      }
      next(error);
    } finally { res.off('close', cancel); }
  };
}

router.get('/status', handle((req, signal) => service.status({ signal })));
router.post('/draft', handle((req, signal) => service.draft(req.body, { signal })));
router.get('/images/status', handle((req, signal) => media.status({ signal })));
router.post('/images/jobs', handle((req, signal) => media.createJob(req.sessionToken, req.body, { signal })));
router.get('/images/jobs/:id', handle(req => media.getJob(req.sessionToken, req.params.id)));
router.delete('/images/jobs/:id', handle(req => media.cancelJob(req.sessionToken, req.params.id)));
router.get('/images/:id', async (req, res, next) => {
  try { sendContent(res, await media.content(req.sessionToken, req.params.id)); }
  catch (error) { next(error); }
});
module.exports = router;
