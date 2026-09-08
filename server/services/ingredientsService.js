const db = require('./dbAdapter');
const { validate, fieldError } = require('./catalogValidation');
const { problem } = require('./planValidation');

exports.listIngredients = (opts = {}) => db.listIngredients(opts);
exports.createIngredient = (payload) => db.withCatalogLock(() => db.createIngredient({ shelfLifeDays: null, ...validate(payload, 'ingredient') }));
exports.updateIngredient = (id, payload) => db.withCatalogLock(async () => {
  const previous = await db.getIngredientById(id);
  if (!previous) throw problem('Ingredient not found.', 404);
  const changes = validate(payload, 'ingredient', true);
  if (changes.unit && changes.unit !== previous.unit && await db.ingredientHasQuantities(id)) {
    throw fieldError('unit', 'This ingredient has recipe or stock quantities. Create a separate ingredient with the correct unit instead.', 409);
  }
  return db.updateIngredient(id, changes);
});
