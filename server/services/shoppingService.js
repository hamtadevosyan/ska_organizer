// server/services/shoppingService.js
const db = require("./dbAdapter");

exports.generateShoppingList = async ({ childrenCount = 20, staffCount = 5 } = {}) => {
  const confirmed = await db.getConfirmedMenu();

  if (!confirmed || !confirmed.week) {
    throw new Error("No confirmed menu found");
  }

  const week = Array.isArray(confirmed.week)
    ? confirmed.week
    : confirmed.week.week;

  if (!Array.isArray(week)) {
    throw new Error("Confirmed menu week must be an array");
  }

  const totalPeople = Number(childrenCount) + Number(staffCount);

  if (totalPeople <= 0) {
    throw new Error("childrenCount and staffCount must be greater than 0");
  }

  const totals = {};

  for (const day of week) {
    const meals = Object.values(day.menu);

    for (const meal of meals) {
      const mealIngredients = await db.listMealIngredients(meal.id);

      for (const mealIngredient of mealIngredients) {
        const ingredient = await db.getIngredientById(mealIngredient.ingredientId);
        if (!ingredient) continue;

        // quantity means amount needed per person for this meal
        const quantityPerPerson = Number(mealIngredient.quantity) || 0;
        const neededQuantity = quantityPerPerson * totalPeople;

        if (!totals[ingredient.id]) {
          totals[ingredient.id] = {
            ingredient,
            quantity: 0,
            quantityPerPerson,
            totalPeople,
          };
        }

        totals[ingredient.id].quantity += neededQuantity;
      }
    }
  }

  return {
    items: Object.values(totals),
    meta: {
      childrenCount: Number(childrenCount),
      staffCount: Number(staffCount),
      totalPeople,
      calculation: "quantityPerPerson * totalPeople",
    },
  };
};
