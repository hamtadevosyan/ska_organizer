// server/services/shoppingService.js

const db = require("./dbAdapter");

exports.generateShoppingList = async ({ childrenCount = 20, staffCount = 5 } = {}) => {
  const confirmed = await db.getConfirmedMenu();
  if (!confirmed || !confirmed.week) {
    throw new Error("No confirmed menu found");
  }

  const week = confirmed.week;

  // Total people to feed
  const totalPeople = childrenCount + staffCount;

  // Ingredient totals
  const totals = {}; // { ingredientId: { ingredient, quantity } }

  for (const day of week) {
    const meals = Object.values(day.menu);

    for (const meal of meals) {
      const mealIngredients = await db.listMealIngredients(meal.id);

      for (const mi of mealIngredients) {
        const ingredient = await db.getIngredientById(mi.ingredientId);
        if (!ingredient) continue;

        const needed = mi.quantity * totalPeople;

        if (!totals[ingredient.id]) {
          totals[ingredient.id] = {
            ingredient,
            quantity: 0
          };
        }

        totals[ingredient.id].quantity += needed;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    peopleCount: totalPeople,
    items: Object.values(totals)
  };
};

