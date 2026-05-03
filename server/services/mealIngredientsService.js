const db = require("./dbAdapter");

exports.listMealIngredients = async (mealId) => {
  return db.listMealIngredients(mealId);
};

exports.addMealIngredient = async (mealId, payload) => {
  return db.addMealIngredient({
    mealId,
    ingredientId: payload.ingredientId,
    quantity: Number(payload.quantity) || 0
  });
};

exports.updateMealIngredient = async (id, changes) => {
  return db.updateMealIngredient(id, changes);
};

exports.deleteMealIngredient = async (id) => {
  return db.deleteMealIngredient(id);
};
