const { audited } = require('../auth/middleware');
// server/routes/attendance.js
const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');
const { validateCheckin } = require('../middleware/validate');

// List attendance with optional filters: ?date=YYYY-MM-DD&roomId=...&childId=...
router.get('/', attendanceController.getAttendance);
router.get('/config', attendanceController.config);
router.get('/daily', attendanceController.daily);
router.get('/today-headcount', attendanceController.headcount);
router.get('/:id/corrections', attendanceController.corrections);
router.put('/:id/correction', audited('attendance.correct', attendanceController.correct));

// Get single attendance record
router.get('/:id', attendanceController.getAttendanceById);

// Check in
router.post('/checkin', validateCheckin, audited('attendance.check_in', attendanceController.checkin));

// Check out by attendance id
router.post('/:id/checkout', audited('attendance.check_out', attendanceController.checkout));

module.exports = router;
