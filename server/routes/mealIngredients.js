const { audited } = require('../auth/middleware');
const express = require("express");
const router = express.Router();
const mealIngredientsController = require("../controllers/mealIngredientsController");

router.get("/:mealId/ingredients", mealIngredientsController.listMealIngredients);
router.post("/:mealId/ingredients", audited('recipe.add_ingredient', mealIngredientsController.addMealIngredient));
router.put("/ingredients/:id", audited('recipe.update_ingredient', mealIngredientsController.updateMealIngredient));
router.delete("/ingredients/:id", audited('recipe.remove_ingredient', mealIngredientsController.deleteMealIngredient));

module.exports = router;
