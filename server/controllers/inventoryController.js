const inventoryService = require('../services/inventoryService');

exports.getStatus = (req, res) => {
  const data = inventoryService.getStatus();
  res.json(data);
};

