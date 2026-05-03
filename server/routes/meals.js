const express = require("express");
const router = express.Router();
const mealsController = require("../controllers/mealsController");

router.get("/", mealsController.listMeals);
router.post("/", mealsController.createMeal);

module.exports = router;
