const db = require('../../services/dbAdapter');

// Generator fixtures need real recipes, just like meals selected by users.
async function addRecipeIngredient(meal, name = meal.name, unit = 'count', quantity = 1) {
  const ingredient = await db.createIngredient({ name, unit });
  const link = await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity });
  return { ingredient, link };
}
module.exports = { addRecipeIngredient };
