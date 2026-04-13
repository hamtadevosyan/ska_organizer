// server/controllers/childrenController.js
const childrenService = require('../services/childrenService');

exports.listChildren = async (req, res, next) => {
  try {
    const opts = {
      q: req.query.q,
      roomId: req.query.roomId,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.querySize) : 50
    };
    const items = await childrenService.listChildren(opts);
    res.json(items);
  } catch (err) {
    next(err);
  }
};

exports.getChildById = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'child id is required' } });
    const child = await childrenService.getById(id);
    if (!child) return res.status(404).json({ error: { message: 'Child not found' } });
    res.json(child);
  } catch (err) {
    next(err);
  }
};

exports.createChild = async (req, res, next) => {
  try {
    const payload = req.body;
    const created = await childrenService.createChild(payload);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

exports.updateChild = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'child id is required' } });
    const changes = req.body;
    const updated = await childrenService.updateChild(id, changes);
    if (!updated) return res.status(404).json({ error: { message: 'Child not found' } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

exports.deleteChild = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: { message: 'child id is required' } });
    const ok = await childrenService.deleteChild(id);
    if (!ok) return res.status(404).json({ error: { message: 'Child not found' } });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

