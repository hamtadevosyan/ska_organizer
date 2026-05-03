// server/services/menuService.js
const db = require("./dbAdapter");

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

const REQUIRED_TYPES = [
  "breakfast",
  "snack",
  "lunch",
  "afternoonSnack"
];

const groupMealsByType = (meals) => {
  return {
    breakfast: meals.filter((meal) => meal.type === "breakfast"),
    snack: meals.filter((meal) => meal.type === "snack"),
    lunch: meals.filter((meal) => meal.type === "lunch"),
    afternoonSnack: meals.filter((meal) => meal.type === "afternoonSnack")
  };
};

const validateMealGroups = (mealsByType) => {
  for (const type of REQUIRED_TYPES) {
    if (!mealsByType[type] || mealsByType[type].length === 0) {
      throw new Error(`No meals available for type: ${type}`);
    }
  }
};

const pickMeal = (meals, index) => {
  return meals[index % meals.length];
};

exports.generateWeeklyMenu = async () => {
  const meals = await db.listMeals();

  if (!meals || meals.length === 0) {
    throw new Error("No meals available. Please add meals first.");
  }

  const mealsByType = groupMealsByType(meals);
  validateMealGroups(mealsByType);

  const week = DAYS.map((day, index) => ({
    day,
    menu: {
      breakfast: pickMeal(mealsByType.breakfast, index),
      snack: pickMeal(mealsByType.snack, index),
      lunch: pickMeal(mealsByType.lunch, index),
      afternoonSnack: pickMeal(mealsByType.afternoonSnack, index)
    }
  }));

  return { week };
};

exports.confirmWeeklyMenu = async ({ week }) => {
  if (!Array.isArray(week)) {
    throw new Error("week must be an array");
  }

  return db.saveConfirmedMenu({ week });
};

exports.getCurrentMenu = async () => {
  return db.getConfirmedMenu();
};
