// server/controllers/childrenController.js
const childrenService = require('../services/childrenService');

exports.list = async (req, res, next) => {
  try {
    const { q, roomId, page, pageSize } = req.query;
    const result = await childrenService.listChildren({ q, roomId, page: Number(page) || 1, pageSize: Number(pageSize) || 50 });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { firstName, lastName, dateOfBirth, preferredName, photoConsent, notes } = req.body;
    if (!firstName || !lastName || !dateOfBirth) {
      return res.status(400).json({ error: 'firstName, lastName and dateOfBirth are required' });
    }
    const child = await childrenService.createChild({ firstName, lastName, dateOfBirth, preferredName, photoConsent, notes });
    res.status(201).json(child);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const child = await childrenService.getById(req.params.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    res.json(child);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const updated = await childrenService.updateChild(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Child not found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const ok = await childrenService.deleteChild(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Child not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

exports.getProfile = async (req, res, next) => {
  try {
    const profile = await childrenService.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Child not found' });
    res.json(profile);
  } catch (err) {
    next(err);
  }
};

