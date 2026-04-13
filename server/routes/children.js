// server/routes/children.js (example)
const express = require('express');
const router = express.Router();
const childrenController = require('../controllers/childrenController');
const { validateChild } = require('../middleware/validate'); // if you have validation

router.get('/', childrenController.listChildren);
router.get('/:id', childrenController.getChildById);
router.post('/', validateChild, childrenController.createChild);
router.put('/:id', validateChild, childrenController.updateChild);
router.delete('/:id', childrenController.deleteChild);

module.exports = router;
