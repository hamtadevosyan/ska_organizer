const router = require('express').Router();
const staff = require('../controllers/staffController');
const { audited } = require('../auth/middleware');
router.get('/', staff.list);
router.get('/:id', staff.get);
router.post('/', audited('staff.create', staff.create, { adminOnly: true }));
router.put('/:id', audited('staff.update', staff.update, { adminOnly: true }));
// Deactivate with PUT; no delete endpoint, credentials or permission mutation.
module.exports = router;
