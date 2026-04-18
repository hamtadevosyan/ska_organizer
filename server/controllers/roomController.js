const attendanceService = require('../services/attendanceService');

exports.getPresentChildren = async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const date = req.query.date;

    if (!date) {
      return res.status(400).json({ error: { message: 'date is required (YYYY-MM-DD)' } });
    }

    const children = await attendanceService.getPresentChildrenForRoom(roomId, date);
    res.json(children);
  } catch (err) {
    next(err);
  }
};

