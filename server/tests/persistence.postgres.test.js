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
  expect(reopened.recipe[0].quantity).toBe(1);
  // The existing saved-shopping API uses 20 children + 5 staff (SKAO-18 changes that).
  expect(reopened.shopping[0]).toMatchObject({ required: 125, inStorage: 20, toBuy: 105 });
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
