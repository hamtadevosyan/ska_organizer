const { audited } = require('../auth/middleware');
const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/scheduleController');

router.get('/week', scheduleController.getWeek);
router.post('/week', audited('schedule.save_week', scheduleController.saveWeek));
router.get('/suggestions', scheduleController.suggestWeek);

module.exports = router;

//const express = require('express');
//const router = express.Router();
//const scheduleController = require('../controllers/scheduleController');
//
//router.get('/today', scheduleController.getTodaySchedule);
//
//module.exports = router;

