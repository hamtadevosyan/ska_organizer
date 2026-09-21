const dashboardService = require('../services/dashboardService');

exports.getDashboardMetrics = async (req, res, next) => {
  try { res.json(await dashboardService.getMetrics(req.query)); }
  catch (error) { next(error); }
};
