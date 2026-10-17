const router = require('express').Router();
const controller = require('../controllers/inventoryGroupController');
const { audited } = require('../auth/middleware');
router.get('/groups/:id/removal-context', controller.context);
router.post('/groups/:id/removal-preview', controller.preview);
router.post('/groups/:id/removal', audited('inventory.group.remove', controller.commit, { skipReplayed: true }));
router.get('/group-operations/by-request/:requestId', controller.byRequest);
router.get('/group-operations/:id', controller.get);
module.exports = router;
