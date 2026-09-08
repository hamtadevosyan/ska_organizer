const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const db = require('./dbAdapter');
const { problem, validateWeekStart, validateCounts, validateVersion } = require('./planValidation');
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const SLOTS = ['breakfast', 'snack', 'lunch', 'afternoonSnack'];
// A save uses exactly the calculation the user reviewed. Clients cannot invent
// recipe snapshots. A server restart/one-hour expiry simply requires a refresh.
const signingKey = randomBytes(32);
const sign = (payload) => createHmac('sha256', signingKey).update(payload).digest('base64url');

function encode(snapshot, version) {
  const payload = Buffer.from(JSON.stringify({ snapshot, version, expires: Date.now() + 3600000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function decode(token) {
  if (typeof token !== 'string') throw problem('Recalculate this draft before saving.', 409);
  const [payload, signature, extra] = token.split('.');
  const expected = Buffer.from(sign(payload || ''));
  const received = Buffer.from(signature || '');
  if (extra || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw problem('The calculation has expired. Recalculate this draft before saving.', 409);
  }
  const result = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (result.expires < Date.now()) throw problem('The calculation has expired. Recalculate this draft before saving.', 409);
  return result;
}

exports.get = async (weekStart) => db.getWeeklyPlan(validateWeekStart(weekStart));

exports.preview = (weekStart, input) => db.withCatalogLock(async () => {
  validateWeekStart(weekStart);
  const { week, childrenCount, staffCount, version, inHouse = {}, refreshRecipes = false } = input;
  if (typeof refreshRecipes !== 'boolean') throw problem('refreshRecipes must be true or false.');
  validateCounts(childrenCount, staffCount);
  validateVersion(version);
  if (!inHouse || typeof inHouse !== 'object' || Array.isArray(inHouse) ||
      !Object.values(inHouse).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    throw problem('In-house quantities must be finite, non-negative numbers.');
  }
  if (!Array.isArray(week) || !week.length || week.length > DAYS.length) throw problem('Supply one to five menu days.');
  const previous = await exports.get(weekStart);
  if ((previous?.version || 0) !== version) throw problem('This week was saved elsewhere. Reopen the saved week before continuing.', 409);
  const daysSeen = new Set();
  const recipes = {};
  const canonicalWeek = [];
  const catalogRecipes = new Map();
  const totals = new Map();
  const warnings = [];
  for (const day of week) {
    if (!day || !DAYS.includes(day.day) || daysSeen.has(day.day) || !day.menu ||
        typeof day.menu !== 'object' || Array.isArray(day.menu) || !Object.keys(day.menu).length) {
      throw problem('Menu days must be unique weekdays with meal selections.');
    }
    daysSeen.add(day.day);
    const menu = {};
    recipes[day.day] = {};
    for (const [slot, selection] of Object.entries(day.menu)) {
      if (!SLOTS.includes(slot) || typeof selection?.id !== 'string') throw problem('Invalid meal selection.');
      const historic = previous?.recipes?.[day.day]?.[slot];
      let recipe = !refreshRecipes && historic?.meal.id === selection.id ? historic : catalogRecipes.get(selection.id);
      if (!recipe) {
        const meal = await db.getMealById(selection.id);
        if (!meal || meal.type !== slot) throw problem('A selected meal is unavailable or has the wrong meal type.');
        const ingredients = [];
        const problems = meal.archived ? ['This meal is archived. Restore it or choose another meal.'] : [];
        for (const link of await db.listMealIngredients(meal.id)) {
          const ingredient = await db.getIngredientById(link.ingredientId);
          const quantityPerPerson = Number(link.quantity);
          if (!ingredient || !Number.isFinite(quantityPerPerson) || quantityPerPerson <= 0) {
            problems.push('Correct or remove an ingredient with a missing or invalid quantity.');
            continue;
          }
          if (ingredient.archived) problems.push(`${ingredient.name} is archived. Restore it or replace it in the recipe.`);
          ingredients.push({ ingredient: { id: ingredient.id, name: ingredient.name, unit: ingredient.unit }, quantityPerPerson });
        }
        recipe = { meal: { id: meal.id, name: meal.name, type: meal.type }, ingredients, problems };
        catalogRecipes.set(selection.id, recipe);
      }
      if (recipe.meal.type !== slot) throw problem('A selected meal has the wrong meal type.');
      menu[slot] = recipe.meal;
      recipes[day.day][slot] = recipe;
      const problems = [...(recipe.problems || [])];
      if (!recipe.ingredients.length) problems.push('Add recipe ingredients and quantities.');
      else if (recipe.ingredients.some((item) => !Number.isFinite(item.quantityPerPerson) || item.quantityPerPerson <= 0)) {
        problems.push('Use current recipes and correct invalid ingredient quantities.');
      }
      for (const message of problems) warnings.push({ day: day.day, slot, mealId: recipe.meal.id, mealName: recipe.meal.name, message });
      for (const { ingredient, quantityPerPerson } of recipe.ingredients) {
        if (!Number.isFinite(quantityPerPerson) || quantityPerPerson <= 0) continue;
        const item = totals.get(ingredient.id) || { ingredient, quantity: 0 };
        if (item.ingredient.unit !== ingredient.unit) throw problem(`Conflicting units for ${ingredient.name}; choose a consistent recipe.`);
        item.quantity += quantityPerPerson * (childrenCount + staffCount);
        if (!Number.isFinite(item.quantity)) throw problem('The required quantity is too large.');
        totals.set(ingredient.id, item);
      }
    }
    canonicalWeek.push({ day: day.day, menu });
  }
  canonicalWeek.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
  const items = [...totals.values()].map((item) => {
    const quantity = Math.round(item.quantity * 1e6) / 1e6;
    if (!Number.isFinite(quantity)) throw problem('The required quantity is too large.');
    const inStorage = inHouse[item.ingredient.id] ?? 0;
    return { ...item, quantity, inStorage, toBuy: Math.max(0, Math.round((quantity - inStorage) * 1e6) / 1e6) };
  });
  const snapshot = { weekStart, week: canonicalWeek, childrenCount, staffCount, recipes,
    inHouse: Object.fromEntries(items.map((i) => [i.ingredient.id, i.inStorage])), items };
  return { ...snapshot, version, warnings, ...(warnings.length ? {} : { previewToken: encode(snapshot, version) }) };
});

exports.save = async (weekStart, { previewToken }) => {
  validateWeekStart(weekStart);
  const { snapshot, version } = decode(previewToken);
  if (snapshot.weekStart !== weekStart) throw problem('The calculation belongs to another week.');
  return db.saveWeeklyPlan(snapshot, version);
};

exports.shopping = async (weekStart) => {
  const plan = await exports.get(weekStart);
  if (!plan) throw problem('No saved menu for this week.', 404);
  return { weekStart, version: plan.version, generatedAt: plan.savedAt, items: plan.items,
    meta: { childrenCount: plan.childrenCount, staffCount: plan.staffCount, totalPeople: plan.childrenCount + plan.staffCount } };
};

exports.importLegacy = async (weekStart) => {
  const legacy = await db.getConfirmedMenu();
  if (!legacy) throw problem('There is no earlier undated menu to import.', 404);
  const shelf = await db.getShelf();
  return exports.preview(weekStart, { version: 0, week: legacy.week, childrenCount: 20, staffCount: 5,
    inHouse: Object.fromEntries(shelf.map((i) => [i.ingredientId, i.quantity])) });
};
