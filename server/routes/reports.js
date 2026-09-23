const router = require('express').Router();
const reports = require('../services/reportService');
const { reportCsv } = require('../services/reportCsv');

// Mounted after the same session/operational authorization used by the report page.
router.get('/config', async (req, res, next) => {
  try {
    if (Object.keys(req.query).length) throw require('../services/planValidation').problem('Report settings do not accept filters.');
    res.json(await reports.config());
  } catch (error) { next(error); }
});
for (const kind of ['attendance', 'purchases']) {
  router.get('/' + kind, async (req, res, next) => {
    try { res.json(await reports.read(kind, req.query)); } catch (error) { next(error); }
  });
  router.get('/' + kind + '.csv', async (req, res, next) => {
    try {
      const report = await reports.read(kind, req.query);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', `attachment; filename="${kind}-${report.filters.from}-to-${report.filters.to}.csv"`);
      res.send(reportCsv(report));
    } catch (error) { next(error); }
  });
}
module.exports = router;
