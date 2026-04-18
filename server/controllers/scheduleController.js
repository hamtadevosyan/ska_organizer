const scheduleService = require('../services/scheduleService');

exports.getWeek = async (req, res, next) => {
  try {
    const { roomId, start } = req.query;
    const items = await scheduleService.listWeek(roomId, start);
    res.json(items);
  } catch (err) {
    next(err);
  }
};

exports.saveWeek = async (req, res, next) => {
  try {
    const { roomId, weekStart, entries } = req.body;
    await scheduleService.saveWeek(roomId, weekStart, entries);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

exports.suggestWeek = async (req, res, next) => {
  try {
    const { roomId, start } = req.query;
    const result = await scheduleService.suggestWeek(roomId, start);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

