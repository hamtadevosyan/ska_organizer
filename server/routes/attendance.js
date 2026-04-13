// server/routes/attendance.js
const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');

// List attendance with optional filters: ?date=YYYY-MM-DD&roomId=...&childId=...
router.get('/', attendanceController.getAttendance);

// Get single attendance record
router.get('/:id', attendanceController.getAttendanceById);

// Check in
router.post('/checkin', attendanceController.checkin);

// Check out by attendance id
router.post('/:id/checkout', attendanceController.checkout);

module.exports = router;

