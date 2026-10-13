// server/services/menuService.js
const db = require("./dbAdapter");
const { validate, quantity } = require('./catalogValidation');
const { problem } = require('./planValidation');

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const REQUIRED_TYPES = [
  "breakfast",
  "snack",
  "lunch",
  "afternoonSnack"
];
const TYPE_LABELS = { breakfast: 'Breakfast', snack: 'Morning snack', lunch: 'Lunch', afternoonSnack: 'Afternoon snack' };

// Generation selects usable current recipes. It does not reserve stock, save a
// plan or replace the later dated shopping preview and explicit Save week step.
async function recipeProblems(meal, ingredients) {
  const reasons = [];
  try { validate({ name: meal.name, type: meal.type }, 'meal'); }
  catch { reasons.push('Correct the meal name and type in Meal Setup.'); }
  const links = await db.listMealIngredients(meal.id);
  if (!links.length) reasons.push('Add recipe ingredients and quantities per person.');
  for (const link of links) {
    const ingredient = ingredients.get(link.ingredientId);
    if (!ingredient) reasons.push('Replace or remove a missing recipe ingredient.');
    else {
      if (ingredient.archived) reasons.push(`${ingredient.name} is archived. Restore it or replace it in the recipe.`);
      try { validate({ name: ingredient.name, unit: ingredient.unit }, 'ingredient'); }
      catch { reasons.push(`Correct the name or unsupported unit for ${ingredient.name || 'a recipe ingredient'}.`); }
    }
    try { quantity(link.quantity); }
    catch { reasons.push(`Correct the quantity per person for ${ingredient?.name || 'a recipe ingredient'}. Use a positive quantity with at most six decimal places.`); }
  }
  return [...new Set(reasons)];
}

function missingType(type, meals) {
  const label = TYPE_LABELS[type];
  const saved = meals.filter((meal) => meal.type === type);
  const message = !saved.length
    ? `Add an active ${label} meal and its recipe ingredients in Meal Setup.`
    : saved.every((meal) => meal.archived)
      ? `All ${label} meals are archived. Restore one or add an active meal with a complete recipe in Meal Setup.`
      : `No active ${label} meal has a complete recipe. Correct the listed meals in Meal Setup.`;
  return { type, label, message };
}

const pickMeal = (meals, index) => {
  return meals[index % meals.length];
};

exports.generateWeeklyMenu = () => db.withCatalogLock(async () => {
  const meals = await db.listMeals({ includeArchived: true });
  const ingredients = new Map((await db.listIngredients({ includeArchived: true })).map((ingredient) => [ingredient.id, ingredient]));
  const mealsByType = Object.fromEntries(REQUIRED_TYPES.map((type) => [type, []]));
  const excludedMeals = [];
  for (const meal of meals) {
    if (!REQUIRED_TYPES.includes(meal.type)) continue;
    const reasons = meal.archived ? ['This meal is archived. Restore it or choose another meal.'] : await recipeProblems(meal, ingredients);
    if (reasons.length) excludedMeals.push({ mealId: meal.id, mealName: meal.name, type: meal.type, reasons });
    else mealsByType[meal.type].push({ id: meal.id, name: meal.name, type: meal.type });
  }
  const missingTypes = REQUIRED_TYPES.filter((type) => !mealsByType[type].length).map((type) => missingType(type, meals));
  if (missingTypes.length) {
    const error = problem(`Complete Meal Setup before generating a menu. Add or repair an active recipe for: ${missingTypes.map((item) => item.label).join(', ')}.`, 422);
    error.code = 'MENU_SETUP_REQUIRED';
    error.fields = Object.fromEntries(missingTypes.map((item) => [item.type, item.message]));
    error.details = { missingTypes, excludedMeals: excludedMeals.filter((meal) => missingTypes.some((item) => item.type === meal.type)) };
    throw error;
  }

  const week = DAYS.map((day, index) => ({
    day,
    menu: {
      breakfast: pickMeal(mealsByType.breakfast, index),
      snack: pickMeal(mealsByType.snack, index),
      lunch: pickMeal(mealsByType.lunch, index),
      afternoonSnack: pickMeal(mealsByType.afternoonSnack, index)
    }
  }));

  // Archived recipes are intentionally ignored without nagging about old
  // catalog entries. Active incomplete recipes need a visible repair hint.
  const setupWarnings = excludedMeals.filter((meal) => meals.some((saved) => saved.id === meal.mealId && !saved.archived));
  return { week, ...(setupWarnings.length ? { setupWarnings } : {}) };
});

exports.confirmWeeklyMenu = async ({ week }) => {
  if (!Array.isArray(week)) {
    throw new Error("week must be an array");
  }

  return db.saveConfirmedMenu({ week });
};

exports.getCurrentMenu = async () => {
  return db.getConfirmedMenu();
};
