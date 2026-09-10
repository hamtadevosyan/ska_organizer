const { audited } = require('../auth/middleware');
// server/routes/children.js (example)
const express = require('express');
const router = express.Router();
const childrenController = require('../controllers/childrenController');
const { validateChild } = require('../middleware/validate'); // if you have validation

router.get('/', childrenController.listChildren);
router.get('/:id', childrenController.getChildById);
router.put('/:id/room', audited('child.assign_room', childrenController.assignRoom));
router.post('/', validateChild, audited('child.create', childrenController.createChild));
router.put('/:id', validateChild, audited('child.update', childrenController.updateChild));
router.delete('/:id', audited('child.delete', childrenController.deleteChild));

module.exports = router;
