// server/controllers/activityController.js
const activityService = require('../services/activityService');

// -------------------------
// EXISTING CRUD ENDPOINTS
// -------------------------

exports.listActivities = async (req, res, next) => {
  try {
    const opts = {
      q: req.query.q,
      roomId: req.query.roomId,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 50
    };

    const items = await activityService.listActivities(opts);
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
};

exports.getActivityById = async (req, res, next) => {
  try {
    const id = req.params.id;

    if (!id) {
      return res.status(400).json({
        error: { message: 'activity id is required' }
      });
    }

    const activity = await activityService.getById(id);

    if (!activity) {
      return res.status(404).json({
        error: { message: 'Activity not found' }
      });
    }

    res.json({ data: activity });
  } catch (err) {
    next(err);
  }
};

exports.createActivity = async (req, res, next) => {
  try {
    const payload = req.body;
    const created = await activityService.createActivity(payload);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
};

exports.updateActivity = async (req, res, next) => {
  try {
    const id = req.params.id;

    if (!id) {
      return res.status(400).json({
        error: { message: 'activity id is required' }
      });
    }

    const changes = req.body;
    const updated = await activityService.updateActivity(id, changes);

    if (!updated) {
      return res.status(404).json({
        error: { message: 'Activity not found' }
      });
    }

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
};

exports.deleteActivity = async (req, res, next) => {
  try {
    const id = req.params.id;

    if (!id) {
      return res.status(400).json({
        error: { message: 'activity id is required' }
      });
    }

    const deleted = await activityService.deleteActivity(id);

    if (!deleted) {
      return res.status(404).json({
        error: { message: 'Activity not found' }
      });
    }

    res.json({
      data: {
        deleted: true,
        id
      }
    });
  } catch (err) {
    next(err);
  }
};

// -------------------------
// WEEKLY PLAN ENDPOINTS
// -------------------------

exports.generateActivityPlan = async (req, res, next) => {
  try {
    const roomId = req.query.roomId || null;
    const weekStart = req.query.weekStart;

    if (!roomId || !weekStart) {
      return res.status(400).json({
        error: { message: 'roomId and weekStart are required' }
      });
    }

    const plan = await activityService.generateWeeklyPlan(roomId, weekStart);
    res.json({ data: plan });
  } catch (err) {
    next(err);
  }
};

exports.getWeeklyActivityPlan = async (req, res, next) => {
  try {
    const roomId = req.query.roomId || null;
    const weekStart = req.query.weekStart;

    if (!roomId || !weekStart) {
      return res.status(400).json({
        error: { message: 'roomId and weekStart are required' }
      });
    }

    const week = await activityService.getSavedWeeklyPlan(roomId, weekStart);

    if (!week || week.length === 0) {
      return res.status(404).json({
        error: { message: 'No weekly plan saved yet' }
      });
    }

    res.json({ data: week });
  } catch (err) {
    next(err);
  }
};

exports.saveWeeklyActivityPlan = async (req, res, next) => {
  try {
    const { roomId, weekStart, week } = req.body;

    if (!roomId || !weekStart || !Array.isArray(week)) {
      return res.status(400).json({
        error: { message: 'Invalid payload: expected { roomId, weekStart, week: [] }' }
      });
    }

    const saved = await activityService.saveWeeklyPlan(roomId, weekStart, week);
    res.json({ data: saved });
  } catch (err) {
    next(err);
  }
};
