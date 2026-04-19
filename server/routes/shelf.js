// server/routes/shelf.js

const express = require("express");
const router = express.Router();
const shelfController = require("../controllers/shelfController");

// POST /api/shelf/check
router.post("/check", shelfController.saveShelfCheck);

// GET /api/shelf/final
router.get("/final", shelfController.generateFinalShoppingList);

module.exports = router;

