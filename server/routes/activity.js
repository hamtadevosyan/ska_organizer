const { audited } = require('../auth/middleware');
// server/routes/activity.js
const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { validateActivity } = require('../middleware/validate');

// NEW WEEKLY PLAN ROUTES
router.get("/generate", activityController.generateActivityPlan);
router.get("/week", activityController.getWeeklyActivityPlan);
router.post("/week", audited('activity.save_week', activityController.saveWeeklyActivityPlan));

router.get('/', activityController.listActivities);
router.get('/:id', activityController.getActivityById);
router.post('/', validateActivity, audited('activity.create', activityController.createActivity));
router.put('/:id', validateActivity, audited('activity.update', activityController.updateActivity));
router.delete('/:id', audited('activity.delete', activityController.deleteActivity));

module.exports = router;

