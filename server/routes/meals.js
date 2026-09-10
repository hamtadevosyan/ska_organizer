const { audited } = require('../auth/middleware');
const express = require("express");
const router = express.Router();
const mealsController = require("../controllers/mealsController");

router.get("/", mealsController.listMeals);
router.post("/", audited('meal.create', mealsController.createMeal));

router.put("/:id", audited('meal.update', mealsController.updateMeal));
router.delete("/:id", audited('meal.archive', mealsController.archiveMeal));

module.exports = router;
