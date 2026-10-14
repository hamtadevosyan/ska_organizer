const service = require('../services/purchasingService');
const handle = (operation) => async (req, res, next) => {
  try { res.json({ data: await operation(req.params.weekStart, req.body || {}) }); }
  catch (error) { next(error); }
};
exports.options = handle(service.options);
exports.get = handle(service.get);
exports.preview = handle(service.preview);
exports.save = handle(service.save);
