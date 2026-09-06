// server/services/shoppingService.js

const db = require("./dbAdapter");

exports.generateShoppingList = async ({
  childrenCount = 20,
  staffCount = 5,
  week: draftWeek
} = {}) => {
  let week = draftWeek;

  // Use the supplied draft menu before it is saved.
  // Older callers can omit it and use the confirmed menu.
  if (week === undefined) {
    const confirmed = await db.getConfirmedMenu();

    if (!confirmed || !confirmed.week) {
      throw new Error("No confirmed menu found");
    }

    week = Array.isArray(confirmed.week)
      ? confirmed.week
      : confirmed.week.week;
  }

  if (!Array.isArray(week)) {
    throw new Error("Menu week must be an array");
  }

  const parsedChildrenCount = Number(childrenCount);
  const parsedStaffCount = Number(staffCount);
  const totalPeople = parsedChildrenCount + parsedStaffCount;

  if (
    !Number.isFinite(parsedChildrenCount) ||
    !Number.isFinite(parsedStaffCount) ||
    parsedChildrenCount < 0 ||
    parsedStaffCount < 0 ||
    totalPeople <= 0
  ) {
    throw new Error(
      "childrenCount and staffCount must be non-negative with a total greater than 0"
    );
  }

  const totals = {};

  for (const day of week) {
    if (!day || !day.menu || typeof day.menu !== "object") {
      throw new Error("Each menu day must contain a menu object");
    }

    const meals = Object.values(day.menu);

    for (const meal of meals) {
      if (!meal || !meal.id) {
        continue;
      }

      const mealIngredients = await db.listMealIngredients(meal.id);

      for (const mealIngredient of mealIngredients) {
        const ingredient = await db.getIngredientById(
          mealIngredient.ingredientId
        );

        if (!ingredient) {
          continue;
        }

        const quantityPerPerson =
          Number(mealIngredient.quantity) || 0;

        const neededQuantity =
          quantityPerPerson * totalPeople;

        if (!totals[ingredient.id]) {
          totals[ingredient.id] = {
            ingredient,
            quantity: 0,
            quantityPerPerson,
            totalPeople
          };
        }

        totals[ingredient.id].quantity += neededQuantity;
      }
    }
  }

  return {
    items: Object.values(totals),
    meta: {
      childrenCount: parsedChildrenCount,
      staffCount: parsedStaffCount,
      totalPeople,
      calculation: "quantityPerPerson * totalPeople"
    }
  };
};
