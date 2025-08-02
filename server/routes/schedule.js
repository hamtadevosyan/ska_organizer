const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/scheduleController');

router.get('/today', scheduleController.getTodaySchedule);

module.exports = router;

