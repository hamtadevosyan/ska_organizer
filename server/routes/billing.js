const express = require('express');
const { requireSession, requireAdmin } = require('../auth/middleware');
const service = require('../services/billingService');
const router = express.Router();
router.use(requireSession, requireAdmin);
router.get('/', async (req, res) => res.json({ data: await service.summary(req.sessionToken) }));
router.get('/alerts', async (req, res) => res.json({ data: await service.alerts(req.sessionToken) }));
router.get('/children/:childId', async (req, res) => res.json({ data: await service.get(req.sessionToken, req.params.childId) }));
for (const [path, method] of [['profile', 'profile'], ['generate', 'generate'], ['charges', 'charge'], ['payments', 'payment'], ['credits', 'credit']]) {
  router.post('/children/:childId/' + path, async (req, res) => res.json({ data: await service[method](req.sessionToken, req.params.childId, req.body || {}) }));
}
router.post('/children/:childId/payments/:paymentId/reverse', async (req, res) => res.json({ data: await service.reverse(req.sessionToken, req.params.childId, req.params.paymentId, req.body || {}) }));
router.post('/children/:childId/charges/:chargeId/adjustments', async (req, res) => res.json({ data: await service.adjust(req.sessionToken, req.params.childId, req.params.chargeId, req.body || {}) }));
router.post('/children/:childId/charges/:chargeId/ccrc-mode', async (req, res) => res.json({ data: await service.ccrcMode(req.sessionToken, req.params.childId, req.params.chargeId, req.body || {}) }));
router.post('/children/:childId/charges/:chargeId/ccrc-review', async (req, res) => res.json({ data: await service.ccrcReview(req.sessionToken, req.params.childId, req.params.chargeId, req.body || {}) }));
module.exports = router;
