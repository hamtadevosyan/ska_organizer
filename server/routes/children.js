// server/routes/children.js
const express = require('express');
const router = express.Router();
const childrenController = require('../controllers/childrenController');

// List children with optional filters: ?q=&roomId=&page=&pageSize=
router.get('/', childrenController.list);

// Create child
router.post('/', childrenController.create);

// Get single child
router.get('/:id', childrenController.get);

// Update child
router.patch('/:id', childrenController.update);

// Delete child
router.delete('/:id', childrenController.remove);

// Child profile (enrollments, recent attendance, reports)
router.get('/:id/profile', childrenController.getProfile);

module.exports = router;

