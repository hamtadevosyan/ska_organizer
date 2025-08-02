const attendanceService = require('../services/attendanceService');

exports.getAttendance = (req, res) => {
  const data = attendanceService.getAttendance();
  res.json(data);
};

