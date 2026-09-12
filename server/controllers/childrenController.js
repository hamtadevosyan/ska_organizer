const children = require('../services/childrenService');

function failure(error, res, next) {
  if (error.code === 'CHILD_DUPLICATE_WARNING') {
    return res.status(409).json({ error: { message: error.message, code: error.code, duplicates: error.duplicates } });
  }
  return next(error);
}
const childResponse = (res, child) => child ? res.json(child) : res.status(404).json({ error: { message: 'Child not found.' } });
exports.listChildren = async (req, res, next) => {
  try {
    res.json(await children.listChildren({ q: req.query.q, roomId: req.query.roomId, active: req.query.active,
      page: req.query.page === undefined ? 1 : Number(req.query.page),
      pageSize: req.query.pageSize === undefined ? 50 : Number(req.query.pageSize) }));
  } catch (error) { next(error); }
};
exports.getChildById = async (req, res, next) => {
  try { childResponse(res, await children.getById(req.params.id)); }
  catch (error) { next(error); }
};
exports.getProfile = async (req, res, next) => {
  try { childResponse(res, await children.getProfile(req.params.id)); }
  catch (error) { next(error); }
};
exports.createChild = async (req, res, next) => {
  try { res.status(201).json(await children.createChild(req.body)); }
  catch (error) { failure(error, res, next); }
};
exports.updateChild = async (req, res, next) => {
  try { childResponse(res, await children.updateChild(req.params.id, req.body)); }
  catch (error) { failure(error, res, next); }
};
exports.setEnrollment = async (req, res, next) => {
  try { childResponse(res, await children.setEnrollment(req.params.id, req.body)); }
  catch (error) { failure(error, res, next); }
};
exports.assignRoom = async (req, res, next) => {
  try { res.json(await children.assignRoom(req.params.id, req.body)); }
  catch (error) { failure(error, res, next); }
};
