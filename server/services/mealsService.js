const db = require('./dbAdapter');
const { validate } = require('./catalogValidation');
const { problem } = require('./planValidation');

exports.listMeals = (opts = {}) => db.listMeals(opts);
exports.createMeal = (payload) => db.withCatalogLock(() => db.createMeal({ description: '', ...validate(payload, 'meal') }));
exports.updateMeal = (id, payload) => db.withCatalogLock(async () => {
  if (!await db.getMealById(id)) throw problem('Meal not found.', 404);
  return db.updateMeal(id, validate(payload, 'meal', true));
});
