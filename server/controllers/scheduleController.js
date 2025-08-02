const scheduleService = require('../services/scheduleService');

exports.getTodaySchedule = (req, res) => {
  const data = scheduleService.getTodaySchedule();
  res.json(data);
};

