// server/routes/menu.js

const express = require("express");
const router = express.Router();
const menuController = require("../controllers/menuController");
const generator = require("../controllers/menuController");

// Suggest menu
router.get("/generate", generator.generateWeeklyMenu);

// Confirm menu (Friday)
router.post("/confirm", menuController.confirmWeeklyMenu);

// Get confirmed menu
router.get("/current", menuController.getCurrentMenu);

module.exports = router;

