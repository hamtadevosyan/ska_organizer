const defineModels = require('./models');
const { assertMigrated } = require('./migrate');

async function seedDevelopment(sequelize, schema = 'public') {
  if (process.env.NODE_ENV === 'production') throw new Error('Development seeds are disabled in production.');
  await assertMigrated(sequelize, schema);
  const { Meal, Ingredient, MealIngredient, ConfirmedMenu, ShelfCheck, WeeklyPlan } = defineModels(sequelize);
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), 17002)', { replacements: { schema }, transaction });
    for (const model of [Meal, Ingredient, MealIngredient, ConfirmedMenu, ShelfCheck, WeeklyPlan]) {
      if (await model.count({ transaction })) return { seeded: false, reason: 'Meal storage is not empty; existing data was preserved.' };
    }
    await Meal.bulkCreate([
      { id: 'demo-meal-1', name: 'Oatmeal', type: 'breakfast' },
      { id: 'demo-meal-2', name: 'Banana', type: 'snack' },
      { id: 'demo-meal-3', name: 'Chicken Rice', type: 'lunch' },
      { id: 'demo-meal-4', name: 'Yogurt', type: 'afternoonSnack' },
      { id: 'demo-meal-5', name: 'Scrambled Eggs', type: 'breakfast' },
    ], { transaction });
    await Ingredient.bulkCreate([
      { id: 'demo-oats', name: 'Oats', unit: 'g', shelfLifeDays: 180 },
      { id: 'demo-milk', name: 'Milk', unit: 'ml', shelfLifeDays: 7 },
      { id: 'demo-banana', name: 'Banana', unit: 'count' },
      { id: 'demo-chicken', name: 'Chicken', unit: 'g' },
      { id: 'demo-rice', name: 'Rice', unit: 'g' },
      { id: 'demo-yogurt', name: 'Yogurt', unit: 'g' },
      { id: 'demo-eggs', name: 'Eggs', unit: 'count' },
    ], { transaction });
    // Illustrative test quantities; review recipes before operational use.
    await MealIngredient.bulkCreate([
      { mealId: 'demo-meal-1', ingredientId: 'demo-oats', quantity: 30 },
      { mealId: 'demo-meal-1', ingredientId: 'demo-milk', quantity: 100 },
      { mealId: 'demo-meal-2', ingredientId: 'demo-banana', quantity: 1 },
      { mealId: 'demo-meal-3', ingredientId: 'demo-chicken', quantity: 60 },
      { mealId: 'demo-meal-3', ingredientId: 'demo-rice', quantity: 40 },
      { mealId: 'demo-meal-4', ingredientId: 'demo-yogurt', quantity: 100 },
      { mealId: 'demo-meal-5', ingredientId: 'demo-eggs', quantity: 1 },
    ], { transaction });
    return { seeded: true };
  });
}

module.exports = { seedDevelopment };
