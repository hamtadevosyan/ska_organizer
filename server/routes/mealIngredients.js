const express = require("express");
const router = express.Router();
const mealIngredientsController = require("../controllers/mealIngredientsController");

router.get("/:mealId/ingredients", mealIngredientsController.listMealIngredients);
router.post("/:mealId/ingredients", mealIngredientsController.addMealIngredient);

module.exports = router;
