// server/services/menuService.js

const db = require("./dbAdapter");

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

exports.generateWeeklyMenu = async () => {
  // Fetch meals by type from DB
  const breakfasts = await db.listMealsByType("breakfast");
  const snacks = await db.listMealsByType("snack");
  const lunches = await db.listMealsByType("lunch");
  const afternoonSnacks = await db.listMealsByType("afternoonSnack");

  if (
    breakfasts.length === 0 ||
    snacks.length === 0 ||
    lunches.length === 0 ||
    afternoonSnacks.length === 0
  ) {
    throw new Error("Not enough meals in database to generate menu");
  }

  // Simple rule-based rotation
  return DAYS.map((day, index) => ({
    day,
    menu: {
      breakfast: breakfasts[index % breakfasts.length],
      snack: snacks[index % snacks.length],
      lunch: lunches[index % lunches.length],
      afternoonSnack: afternoonSnacks[index % afternoonSnacks.length]
    }
  }));
};

exports.confirmWeeklyMenu = async (week) => {
  return db.saveConfirmedMenu(week);
};

exports.getCurrentMenu = async () => {
  return db.getConfirmedMenu();
};
