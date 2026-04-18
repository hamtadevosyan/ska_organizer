// server/routes/activity.js
const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { validateActivity } = require('../middleware/validate');

// NEW WEEKLY PLAN ROUTES
router.get("/generate", activityController.generateActivityPlan);
router.get("/week", activityController.getWeeklyActivityPlan);
router.post("/week", activityController.saveWeeklyActivityPlan);

router.get('/', activityController.listActivities);
router.get('/:id', activityController.getActivityById);
router.post('/', validateActivity, activityController.createActivity);
router.put('/:id', validateActivity, activityController.updateActivity);
router.delete('/:id', activityController.deleteActivity);

module.exports = router;

