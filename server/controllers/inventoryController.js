const inventoryService = require('../services/inventoryService');

exports.getStatus = (req, res) => {
  res.json(inventoryService.getStatus());
};

exports.getItems = (req, res) => {
  res.json(inventoryService.getInventoryItems());
};

