const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');

// Summary status (what your UI needs right now)
router.get('/', inventoryController.getStatus);      // GET /api/inventory
router.get('/status', inventoryController.getStatus); // GET /api/inventory/status

router.get('/items', inventoryController.getItems);   // GET /api/inventory/items

module.exports = router;

