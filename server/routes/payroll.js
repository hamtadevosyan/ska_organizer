const express = require('express');
const { requireSession, requireAdmin } = require('../auth/middleware');
const service = require('../services/payrollService');
const self = express.Router(); self.use(requireSession);
self.get('/', async (req, res) => res.json({ data: await service.own(req.sessionToken) }));
self.post('/', async (req, res) => res.json({ data: await service.clock(req.sessionToken, req.body || {}) }));
const admin = express.Router(); admin.use(requireSession, requireAdmin);
admin.get('/staff/:staffId', async (req, res) => res.json({ data: await service.get(req.sessionToken, req.params.staffId) }));
for (const [path, method] of [['profile', 'profile'], ['rates', 'rate'], ['corrections', 'correct'], ['approvals', 'approve'], ['preview', 'preview'], ['snapshots', 'finalize'], ['documents', 'document']]) {
  admin.post('/staff/:staffId/' + path, async (req, res) => res.json({ data: await service[method](req.sessionToken, req.params.staffId, req.body || {}) }));
}
admin.get('/staff/:staffId/snapshots/:id', async (req, res) => res.json({ data: await service.snapshot(req.sessionToken, req.params.staffId, req.params.id) }));
admin.get('/staff/:staffId/documents/:id/:revision', async (req, res) => {
  const file = await service.content(req.sessionToken, req.params.staffId, req.params.id, req.params.revision);
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }).send(file.content);
});
module.exports = { self, admin };
