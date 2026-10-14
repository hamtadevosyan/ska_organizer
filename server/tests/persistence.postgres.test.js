const db = require('../services/dbAdapter');
const { context } = require('./databaseSetup');
const { migrate } = require('../database/migrate');
const { seedDevelopment } = require('../database/seed-development');
const { runPersistenceProcess } = require('./helpers/persistenceProcess');
const runProcess = (phase) => runPersistenceProcess(phase, process.env.DATABASE_URL, context().schema);

test('a new Node process returns the same IDs, recipes, saved menu and shelf arithmetic', async () => {
  const written = await runProcess('write');
  const reopened = await runProcess('read');
  expect(reopened).toEqual(written);
  const eggs = reopened.ingredients.find((ingredient) => ingredient.name === 'Eggs');
  expect(eggs).toBeDefined();
  expect(reopened.recipe).toHaveLength(1);
  expect(reopened.recipe.find((link) => link.ingredientId === eggs.id).quantity).toBe(1);
  expect(reopened.headcounts).toEqual({ childrenCount: 20, staffCount: 5 });
  // The undated API reads the persisted fictional roster. Dated plans keep saved counts.
  // JSONB does not preserve menu object key order; identify stock by ingredient ID.
  expect(reopened.shopping).toHaveLength(4);
  expect(reopened.shopping.find((item) => item.ingredient.id === eggs.id)).toMatchObject({ required: 125, inStorage: 20, toBuy: 105 });
  for (const item of reopened.shopping.filter((item) => item.ingredient.id !== eggs.id)) {
    expect(item).toMatchObject({ required: 125, inStorage: 0, toBuy: 125 });
  }
  expect(reopened.datedShopping.items).toHaveLength(1);
  expect(reopened.datedShopping.items.find((item) => item.ingredient.id === eggs.id)).toMatchObject({ quantity: 15, inStorage: 2, toBuy: 13 });
  expect(reopened.datedPlans[1]).toMatchObject({ childrenCount: 8, staffCount: 1 });
  expect(reopened.staffDocuments.revisions).toHaveLength(3);
  expect(reopened.staffDocuments.document).toMatchObject({ expiresOn: '2028-10-01', warningDays: 30 });
  expect(reopened.staffDocuments.settings).toMatchObject({ warningDays: 30, version: 2 });
});

test('migrations and explicit seeds preserve existing records when repeated', async () => {
  const { connection, schema } = context();
  expect(await db.listMeals()).toEqual([]); // Startup/migration did not seed data.
  expect(await seedDevelopment(connection, schema)).toEqual({ seeded: true });
  await db.updateMeal('demo-meal-1', { name: 'Edited oatmeal' });
  const before = await db.listMeals();
  expect(await migrate(connection, schema)).toEqual([]);
  expect(await seedDevelopment(connection, schema)).toMatchObject({ seeded: false });
  expect(await db.listMeals()).toEqual(before);
  await db.close();
  await db.setup(process.env.DATABASE_URL, { schema });
  expect(await db.listMeals()).toEqual(before);
});

test('recipe quantities stay numeric and invalid references cannot create orphan recipes', async () => {
  const meal = await db.createMeal({ name: 'Example', type: 'breakfast' });
  const ingredient = await db.createIngredient({ name: 'Oats', unit: 'g' });
  const link = await db.addMealIngredient({ mealId: meal.id, ingredientId: ingredient.id, quantity: 1.25 });
  expect(link.quantity).toBe(1.25);
  expect((await db.listMealIngredients(meal.id))[0].quantity).toBe(1.25);
  expect(await db.getIngredientById(ingredient.id)).toMatchObject({ id: ingredient.id });
  await expect(db.addMealIngredient({ mealId: meal.id, ingredientId: 'missing', quantity: 3 })).rejects.toThrow();
  expect(await db.getIngredientById(ingredient.id)).toMatchObject({ id: ingredient.id });
  await expect(db.deleteIngredient(ingredient.id)).rejects.toThrow();
  expect(await db.listMealIngredients(meal.id)).toHaveLength(1);
});

test('invalid replacements preserve the prior menu and shelf check', async () => {
  const saved = await db.saveConfirmedMenu({ week: [{ day: 'Monday', menu: {} }] });
  const shelf = [{ ingredientId: 'example', quantity: 2.5 }];
  await db.saveShelfCheck(shelf);
  await expect(db.saveConfirmedMenu({ week: null })).rejects.toThrow();
  await expect(db.saveShelfCheck(null)).rejects.toThrow();
  expect(await db.getConfirmedMenu()).toEqual(saved);
  expect(await db.getShelf()).toEqual(shelf);
  expect(await db.saveShelfCheck([])).toEqual([]);
  expect(await db.getShelf()).toEqual([]);
});
