const db = require('./dbAdapter');
const { quantity, fieldError } = require('./catalogValidation');
const { problem } = require('./planValidation');

async function activeMeal(id) {
  const meal = await db.getMealById(id);
  if (!meal) throw problem('Meal not found.', 404);
  if (meal.archived) throw problem('Restore this meal before changing its recipe.', 409);
  return meal;
}
exports.listMealIngredients = async (mealId) => {
  if (!await db.getMealById(mealId)) throw problem('Meal not found.', 404);
  return db.listMealIngredients(mealId);
};
exports.addMealIngredient = (mealId, payload) => db.withCatalogLock(async () => {
  await activeMeal(mealId);
  const amount = quantity(payload?.quantity);
  const ingredient = typeof payload?.ingredientId === 'string' && await db.getIngredientById(payload.ingredientId);
  if (!ingredient || ingredient.archived) throw fieldError('ingredientId', 'Choose an active ingredient.');
  if ((await db.listMealIngredients(mealId)).some((link) => link.ingredientId === ingredient.id)) {
    throw fieldError('ingredientId', 'This ingredient is already in the recipe. Edit its existing quantity.', 409);
  }
  return db.addMealIngredient({ mealId, ingredientId: ingredient.id, quantity: amount });
});
exports.updateMealIngredient = (id, changes) => db.withCatalogLock(async () => {
  const link = await db.getMealIngredientById(id);
  if (!link) throw problem('Meal ingredient not found.', 404);
  await activeMeal(link.mealId);
  return db.updateMealIngredient(id, { quantity: quantity(changes?.quantity) });
});
exports.deleteMealIngredient = (id) => db.withCatalogLock(async () => {
  const link = await db.getMealIngredientById(id);
  if (!link) throw problem('Meal ingredient not found.', 404);
  await activeMeal(link.mealId);
  return db.deleteMealIngredient(id);
});
