const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');

router.get('/status', inventoryController.getStatus);

module.exports = router;

