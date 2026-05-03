const db = require("./dbAdapter");

exports.listIngredients = async () => {
  return db.listIngredients();
};

exports.createIngredient = async (payload) => {
  return db.createIngredient({
    name: payload.name,
    unit: payload.unit,
    shelfLifeDays: payload.shelfLifeDays || null
  });
};
