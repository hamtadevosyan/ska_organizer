// server/routes/activity.js
const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { validateActivity } = require('../middleware/validate');

router.get('/', activityController.listActivities);
router.get('/:id', activityController.getActivityById);
router.post('/', validateActivity, activityController.createActivity);
router.put('/:id', validateActivity, activityController.updateActivity);
router.delete('/:id', activityController.deleteActivity);

module.exports = router;

