const db = require("./dbAdapter");

exports.listMeals = async (opts = {}) => {
  return db.listMeals(opts);
};

exports.createMeal = async (payload) => {
  return db.createMeal({
    name: payload.name,
    type: payload.type,
    description: payload.description || ""
  });
};
