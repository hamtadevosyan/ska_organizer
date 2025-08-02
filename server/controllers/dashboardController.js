const dashboardService = require('../services/dashboardService');

exports.getDashboardMetrics = (req, res) => {
  const metrics = dashboardService.getMetrics();
  res.json(metrics);
};

