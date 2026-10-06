const db = require('./dbAdapter');
const { validate, quantity, fieldError } = require('./catalogValidation');
const { problem } = require('./planValidation');

exports.listMeals = (opts = {}) => db.listMeals(opts);
exports.createMeal = (payload) => db.withCatalogLock(() => db.createMeal({ description: '', ...validate(payload, 'meal') }));
exports.updateMeal = (id, payload) => db.withCatalogLock(async () => {
  if (!await db.getMealById(id)) throw problem('Meal not found.', 404);
  return db.updateMeal(id, validate(payload, 'meal', true));
});

const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const normalizeName = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
function fieldsAt(prefix, operation) {
  try { return operation(); }
  catch (error) {
    if (error.fields) error.fields = Object.fromEntries(Object.entries(error.fields).map(([key, message]) => [`${prefix}.${key}`, message]));
    throw error;
  }
}
function recipeRow(row, index, catalog, linkedIngredients = []) {
  const prefix = `ingredients.${index}`;
  if (!object(row) || Object.keys(row).some((key) => !['ingredientId', 'name', 'unit', 'quantity'].includes(key))) {
    throw fieldError(`${prefix}.name`, 'Supply an ingredient name and unit, or choose an existing ingredient.');
  }
  const amount = fieldsAt(prefix, () => quantity(row.quantity));
  if (Object.hasOwn(row, 'ingredientId')) {
    const ingredient = typeof row.ingredientId === 'string' && catalog.find((item) => item.id === row.ingredientId);
    if (!ingredient || ingredient.archived) throw fieldError(`${prefix}.ingredientId`, 'Choose an active ingredient.', 409);
    if (Object.hasOwn(row, 'name') && (typeof row.name !== 'string' || normalizeName(row.name) !== normalizeName(ingredient.name))) {
      throw fieldError(`${prefix}.name`, 'Use the selected ingredient’s name, or choose another ingredient.', 409);
    }
    if (Object.hasOwn(row, 'unit') && row.unit !== ingredient.unit) {
      throw fieldError(`${prefix}.unit`, `Use ${ingredient.unit} for this ingredient. Quantities are not converted automatically.`, 409);
    }
    return { ingredient, quantity: amount };
  }
  const details = fieldsAt(prefix, () => validate({ name: row.name, unit: row.unit }, 'ingredient'));
  details.name = details.name.replace(/\s+/g, ' ');
  // On a retry, prefer this meal’s already linked food. Another catalog entry
  // with the same name added later must not turn an unchanged retry into a new
  // ingredient or an ambiguous match.
  const linked = linkedIngredients.filter((item) => item && !item.archived && item.unit === details.unit && normalizeName(item.name) === normalizeName(details.name));
  if (linked.length === 1) return { ingredient: linked[0], quantity: amount };
  if (linked.length > 1) throw fieldError(`${prefix}.ingredientId`, 'Several recipe ingredients share this name and unit. Choose an existing ingredient.', 409);
  const matching = catalog.filter((item) => normalizeName(item.name) === normalizeName(details.name));
  const active = matching.filter((item) => !item.archived);
  const exact = active.filter((item) => item.unit === details.unit);
  if (exact.length > 1) throw fieldError(`${prefix}.ingredientId`, 'Several ingredients share this name and unit. Choose an existing ingredient.', 409);
  if (exact.length === 1) return { ingredient: exact[0], quantity: amount };
  if (active.length) throw fieldError(`${prefix}.unit`, 'This ingredient already uses another unit. Choose an existing ingredient and its unit, or change the name.', 409);
  if (matching.length) throw fieldError(`${prefix}.name`, 'This ingredient is archived. Restore it in Meal Setup or choose another ingredient.', 409);
  return { details, quantity: amount };
}

// Creating a meal, its ingredients and every recipe row shares one catalog
// transaction. The request UUID is the meal ID, so a lost response can be retried
// without another catalog entry. A later catalog edit makes that retry conflict.
exports.createMealWithRecipe = (payload) => db.withCatalogLock(async () => {
  if (!object(payload) || typeof payload.requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)) {
    throw fieldError('requestId', 'A valid request UUID is required.');
  }
  const id = payload.requestId.toLowerCase();
  if (Object.keys(payload).some((key) => !['requestId', 'meal', 'ingredients'].includes(key))) {
    throw fieldError('requestId', 'Supply only the request UUID, meal and recipe ingredients.');
  }
  if (!object(payload.meal)) throw fieldError('meal.name', 'Supply the meal name and type.');
  if (Object.keys(payload.meal).some((key) => !['name', 'type', 'description'].includes(key))) {
    throw fieldError('meal.name', 'Supply only the meal name, type and description.');
  }
  const values = { description: '', ...fieldsAt('meal', () => validate(payload.meal, 'meal')) };
  if (!Array.isArray(payload.ingredients) || !payload.ingredients.length || payload.ingredients.length > 50) {
    throw fieldError('ingredients', 'Add between 1 and 50 recipe ingredients.');
  }
  const catalog = await db.listIngredients({ includeArchived: true });
  const existing = await db.getMealById(id);
  const existingRecipe = existing ? await db.listMealIngredients(id) : [];
  const linkedIngredients = existingRecipe.map((link) => catalog.find((item) => item.id === link.ingredientId));
  const rows = payload.ingredients.map((row, index) => recipeRow(row, index, catalog, linkedIngredients));
  const ids = new Set();
  const names = new Set();
  rows.forEach((row, index) => {
    const ingredient = row.ingredient || row.details;
    const key = JSON.stringify([normalizeName(ingredient.name), ingredient.unit]);
    if (row.ingredient && ids.has(ingredient.id)) throw fieldError(`ingredients.${index}.ingredientId`, 'This ingredient is already in the recipe.', 409);
    if (names.has(key)) throw fieldError(`ingredients.${index}.name`, 'This ingredient name and unit are already in the recipe.', 409);
    if (row.ingredient) ids.add(ingredient.id);
    names.add(key);
  });

  if (existing) {
    const recipe = existingRecipe;
    const matches = !existing.archived && ['name', 'type', 'description'].every((key) => (existing[key] || '') === values[key]) &&
      recipe.length === rows.length && rows.every((row) => row.ingredient && recipe.some((link) =>
        link.ingredientId === row.ingredient.id && link.quantity === row.quantity));
    if (!matches) throw fieldError('requestId', 'This meal was already saved with different details. Review your saved meals before creating another copy.', 409);
    return { created: false, data: { meal: existing, ingredients: recipe.map((link) => catalog.find((item) => item.id === link.ingredientId)), recipe } };
  }

  const ingredients = [];
  for (const row of rows) ingredients.push(row.ingredient || await db.createIngredient({ ...row.details, shelfLifeDays: null }));
  const meal = await db.createMeal({ id, ...values });
  const recipe = [];
  for (const [index, ingredient] of ingredients.entries()) recipe.push(await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity: rows[index].quantity }));
  return { created: true, data: { meal, ingredients, recipe } };
});
