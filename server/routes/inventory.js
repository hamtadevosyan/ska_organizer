const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const { audited } = require('../auth/middleware');

router.get('/', inventoryController.getItems);
router.get('/items', inventoryController.getItems);
router.get('/status', inventoryController.getStatus);
router.get('/groups', inventoryController.listGroups);
router.get('/purchase-config', inventoryController.purchaseConfig);
router.get('/purchases', inventoryController.purchases);
router.post('/groups', audited('inventory.group.create', inventoryController.createGroup));
router.post('/', audited('inventory.create', inventoryController.create));
router.get('/:id/movements', inventoryController.history);
router.post('/:id/movements', audited('inventory.adjust', inventoryController.adjust));
router.post('/:id/purchases', audited('inventory.purchase.receive', inventoryController.receivePurchase));
router.get('/:id', inventoryController.get);
router.put('/:id', audited('inventory.update', inventoryController.update));

module.exports = router;
