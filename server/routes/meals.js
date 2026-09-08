const express = require("express");
const router = express.Router();
const mealsController = require("../controllers/mealsController");

router.get("/", mealsController.listMeals);
router.post("/", mealsController.createMeal);

router.put("/:id", mealsController.updateMeal);
router.delete("/:id", mealsController.archiveMeal);

module.exports = router;
