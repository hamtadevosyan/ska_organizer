// server/routes/shopping.js

const express = require("express");
const router = express.Router();
const shoppingController = require("../controllers/shoppingController");

// POST /api/shopping/generate
router.post("/generate", shoppingController.generateShoppingList);

module.exports = router;

