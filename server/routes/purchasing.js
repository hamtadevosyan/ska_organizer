const express = require('express');
const { audited } = require('../auth/middleware');
const controller = require('../controllers/purchasingController');
const router = express.Router();
router.get('/options', controller.options);
router.get('/:weekStart', controller.get);
router.post('/:weekStart/preview', controller.preview);
router.put('/:weekStart', audited('purchasing_list.save', controller.save));
module.exports = router;
