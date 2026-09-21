const { audited } = require('../auth/middleware');
const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/scheduleController');
const plans = require('../services/activityPlanService');
router.get('/plan', async (req, res, next) => {
  try { res.json({ data: await plans.get(req.query.roomId, req.query.weekStart) }); } catch (error) { next(error); }
});
router.post('/plan/preview', async (req, res, next) => {
  try { res.json({ data: await plans.preview(req.body) }); } catch (error) { next(error); }
});
router.post('/plan', audited('schedule.save_week', async (req, res, next) => {
  try { res.json({ data: await plans.save(req.body) }); } catch (error) { next(error); }
}));

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
