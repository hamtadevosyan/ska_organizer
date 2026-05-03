const express = require("express");
const router = express.Router();
const mealIngredientsController = require("../controllers/mealIngredientsController");

router.get("/:mealId/ingredients", mealIngredientsController.listMealIngredients);
router.post("/:mealId/ingredients", mealIngredientsController.addMealIngredient);
router.put("/ingredients/:id", mealIngredientsController.updateMealIngredient);
router.delete("/ingredients/:id", mealIngredientsController.deleteMealIngredient);

module.exports = router;
