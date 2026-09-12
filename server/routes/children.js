const express = require('express');
const { audited } = require('../auth/middleware');
const controller = require('../controllers/childrenController');
const router = express.Router();

router.get('/', controller.listChildren);
router.get('/:id/profile', controller.getProfile);
router.get('/:id', controller.getChildById);
router.post('/', audited('child.create', controller.createChild));
router.put('/:id/room', audited('child.assign_room', controller.assignRoom));
router.put('/:id/enrollment', audited('child.enrollment', controller.setEnrollment));
router.put('/:id', audited('child.update', controller.updateChild));
router.delete('/:id', (_req, res) => res.status(405).json({ error: { message: 'End enrollment instead of deleting child records.' } }));

module.exports = router;
