const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const { audited } = require('../auth/middleware');

router.get('/', roomController.list);
router.get('/:id/assignment-preview', roomController.assignmentPreview);
router.get('/:roomId/present-children', roomController.getPresentChildren);
router.get('/:id', roomController.get);
router.post('/', audited('room.create', roomController.create, { adminOnly: true }));
router.put('/:id', audited('room.update', roomController.update, { adminOnly: true }));

module.exports = router;
