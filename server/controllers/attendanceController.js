// server/controllers/attendanceController.js
const attendanceService = require('../services/attendanceService');
exports.config = (req, res) => res.json(attendanceService.config());
exports.daily = async (req, res, next) => {
  try { res.json(await attendanceService.dailyRoster({ roomId: req.query.roomId, date: req.query.date })); }
  catch (error) { next(error); }
};
exports.headcount = async (req, res, next) => {
  try { res.json(await attendanceService.todayHeadcount()); } catch (error) { next(error); }
};
exports.corrections = async (req, res, next) => {
  try { res.json(await attendanceService.corrections(req.params.id)); } catch (error) { next(error); }
};
exports.correct = async (req, res, next) => {
  try { res.json(await attendanceService.correct(req.params.id, req.body, req.account)); } catch (error) { next(error); }
};

exports.getAttendance = async (req, res, next) => {
  try {
    const filters = {
      date: req.query.date,
      roomId: req.query.roomId,
      childId: req.query.childId
    };
    const records = await attendanceService.listAttendance(filters);
    res.json(records);
  } catch (err) {
    next(err);
  }
};

exports.getAttendanceById = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'attendance id is required' } });
    const record = await attendanceService.getById(id);
    if (!record) return res.status(404).json({ error: 'Attendance record not found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
};

exports.checkin = async (req, res, next) => {
  try {
    const { childId, roomId, date, requestId } = req.body;
    const recordedBy = req.account.id;
    if (!childId || !roomId) {
      return res.status(400).json({ error: 'childId and roomId are required' });
    }
    const record = await attendanceService.checkIn({ childId, roomId, recordedBy, date, requestId });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
};

exports.checkout = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'attendance id is required' });
    const updated = await attendanceService.checkOut(id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Attendance record not found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};
