const staff = require('../services/staffService');
exports.list = async (req, res, next) => {
  try { res.json(await staff.list(req.query)); } catch (error) { next(error); }
};
exports.get = async (req, res, next) => {
  try { res.json({ data: await staff.get(req.params.id) }); } catch (error) { next(error); }
};
exports.create = async (req, res, next) => {
  try { res.status(201).json({ data: await staff.create(req.body) }); } catch (error) { next(error); }
};
exports.update = async (req, res, next) => {
  try { res.json({ data: await staff.update(req.params.id, req.body) }); } catch (error) { next(error); }
};
