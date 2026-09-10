const { audited } = require('../auth/middleware');
// server/routes/menu.js

const express = require("express");
const router = express.Router();
const menuController = require("../controllers/menuController");
const plans = require('../controllers/weeklyPlanController');
router.get('/plans/:weekStart', plans.get);
router.post('/plans/:weekStart/preview', plans.preview);
router.post('/plans/:weekStart/import-preview', plans.importLegacy);
router.put('/plans/:weekStart', audited('weekly_plan.save', plans.save));
router.get('/plans/:weekStart/shopping', plans.shopping);

// Suggest menu
router.get("/generate", menuController.generateWeeklyMenu);

// Confirm menu (Friday)
router.post("/confirm", audited('menu.confirm', menuController.confirmWeeklyMenu));

// Get confirmed menu
router.get("/current", menuController.getCurrentMenu);

module.exports = router;
