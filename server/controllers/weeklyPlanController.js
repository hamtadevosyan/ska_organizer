const service = require('../services/weeklyPlanService');
const handle = (action) => async (req, res, next) => {
  try { res.json({ data: await action(req.params.weekStart, req.body || {}) }); }
  catch (error) { next(error); }
};
exports.get = handle(service.get);
exports.preview = handle(service.preview);
exports.save = handle(service.save);
exports.shopping = handle(service.shopping);
exports.importLegacy = handle(service.importLegacy);
