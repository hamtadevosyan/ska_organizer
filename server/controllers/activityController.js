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
    res.json(items);
  } catch (err) {
    next(err);
  }
};

exports.getActivityById = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'activity id is required' } });
    const activity = await activityService.getById(id);
    if (!activity) return res.status(404).json({ error: { message: 'Activity not found' } });
    res.json(activity);
  } catch (err) {
    next(err);
  }
};

exports.createActivity = async (req, res, next) => {
  try {
    console.log("Payload received:", req.body);
    const payload = req.body;
    const created = await activityService.createActivity(payload);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

exports.updateActivity = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'activity id is required' } });
    const changes = req.body;
    const updated = await activityService.updateActivity(id, changes);
    if (!updated) return res.status(404).json({ error: { message: 'Activity not found' } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

exports.deleteActivity = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'activity id is required' } });
    const ok = await activityService.deleteActivity(id);
    if (!ok) return res.status(404).json({ error: { message: 'Activity not found' } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

// -------------------------
// NEW WEEKLY PLAN ENDPOINTS
// -------------------------

exports.generateActivityPlan = (req, res) => {
  const plan = activityService.generateWeeklyPlan();
  res.json({ plan });
};

exports.getWeeklyActivityPlan = (req, res) => {
  const week = activityService.getSavedWeeklyPlan();
  if (!week) {
    return res.status(404).json({ message: "No weekly plan saved yet" });
  }
  res.json({ week });
};

exports.saveWeeklyActivityPlan = (req, res) => {
  const { week } = req.body;

  if (!Array.isArray(week)) {
    return res.status(400).json({ message: "Invalid payload: expected { week: [] }" });
  }

  const saved = activityService.saveWeeklyPlan(week);
  res.json({ week: saved });
};

