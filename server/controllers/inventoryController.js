const inventoryService = require('../services/inventoryService');

exports.listGroups = async (req, res, next) => {
  try { res.json(await inventoryService.listGroups()); } catch (error) { next(error); }
};
exports.createGroup = async (req, res, next) => {
  try { res.status(201).json({ data: await inventoryService.createGroup(req.body, req.account) }); } catch (error) { next(error); }
};

exports.getStatus = async (req, res, next) => {
  try { res.json(await inventoryService.getStatus()); } catch (error) { next(error); }
};

exports.getItems = async (req, res, next) => {
  try { res.json(await inventoryService.getInventoryItems(req.query)); } catch (error) { next(error); }
};
exports.get = async (req, res, next) => {
  try { res.json({ data: await inventoryService.get(req.params.id) }); } catch (error) { next(error); }
};
exports.create = async (req, res, next) => {
  try { res.status(201).json({ data: await inventoryService.create(req.body, req.account) }); } catch (error) { next(error); }
};
exports.update = async (req, res, next) => {
  try { res.json({ data: await inventoryService.update(req.params.id, req.body, req.account) }); } catch (error) { next(error); }
};
exports.adjust = async (req, res, next) => {
  try { res.json({ data: await inventoryService.adjust(req.params.id, req.body, req.account) }); } catch (error) { next(error); }
};
exports.history = async (req, res, next) => {
  try { res.json(await inventoryService.history(req.params.id, req.query)); } catch (error) { next(error); }
};
