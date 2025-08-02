const activityService = require('../services/activityService');

exports.generateActivities = (req, res) => {
  const activities = activityService.generateActivities();
  res.json({ activities });
};

