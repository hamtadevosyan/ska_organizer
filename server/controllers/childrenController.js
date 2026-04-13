// server/controllers/childrenController.js
const childrenService = require('../services/childrenService');

exports.list = async (req, res) => {
  try {
    const filters = {
      q: req.query.q,
      roomId: req.query.roomId,
      page: parseInt(req.query.page || '1', 10),
      pageSize: parseInt(req.query.pageSize || '50', 10)
    };
    const result = await childrenService.listChildren(filters);
    res.json(result);
  } catch (err) {
    console.error('children.list error', err);
    res.status(500).json({ error: 'Failed to list children' });
  }
};

exports.get = async (req, res) => {
  try {
    const child = await childrenService.getById(req.params.id);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    res.json(child);
  } catch (err) {
    console.error('children.get error', err);
    res.status(500).json({ error: 'Failed to fetch child' });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = req.body;
    // minimal controller-level validation
    if (!payload.firstName || !payload.lastName || !payload.dateOfBirth) {
      return res.status(400).json({ error: 'firstName, lastName and dateOfBirth are required' });
    }
    const created = await childrenService.createChild(payload);
    res.status(201).json(created);
  } catch (err) {
    console.error('children.create error', err);
    res.status(500).json({ error: 'Failed to create child' });
  }
};

exports.update = async (req, res) => {
  try {
    const updated = await childrenService.updateChild(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Child not found' });
    res.json(updated);
  } catch (err) {
    console.error('children.update error', err);
    res.status(500).json({ error: 'Failed to update child' });
  }
};

exports.remove = async (req, res) => {
  try {
    const removed = await childrenService.deleteChild(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Child not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('children.remove error', err);
    res.status(500).json({ error: 'Failed to delete child' });
  }
};

// Optional: endpoint to fetch child's enrollments and recent reports
exports.getProfile = async (req, res) => {
  try {
    const profile = await childrenService.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Child not found' });
    res.json(profile);
  } catch (err) {
    console.error('children.getProfile error', err);
    res.status(500).json({ error: 'Failed to fetch child profile' });
  }
};

