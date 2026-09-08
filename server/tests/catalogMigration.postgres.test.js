const { DataTypes } = require('sequelize');
const { context } = require('./databaseSetup');
const migration = require('../database/migrations/003-catalog-corrections');
const initial = require('../database/migrations/001-persistent-meals');

test('catalog upgrade keeps duplicate recipe totals and installs the uniqueness constraint', async () => {
  const { connection: sequelize, schema: currentSchema } = context();
  const schema = `${currentSchema}_upgrade`;
  await sequelize.createSchema(schema);
  try {
    await sequelize.transaction(async (transaction) => {
      await initial.up({ sequelize, schema, transaction, DataTypes });
      const query = sequelize.getQueryInterface();
      const createdAt = new Date('2026-01-01T00:00:00Z');
      await query.bulkInsert({ tableName: 'Meals', schema }, [{ id: 'meal', name: 'Breakfast', type: 'breakfast', description: '', createdAt, updatedAt: createdAt }], { transaction });
      await query.bulkInsert({ tableName: 'Ingredients', schema }, [{ id: 'ingredient', name: 'Oats', unit: 'g', createdAt, updatedAt: createdAt }], { transaction });
      await query.bulkInsert({ tableName: 'MealIngredients', schema }, ['a', 'b'].map((id) => ({
        id, mealId: 'meal', ingredientId: 'ingredient', quantity: id === 'a' ? 1.25 : 2.5, createdAt, updatedAt: createdAt,
      })), { transaction });
      await migration.up({ sequelize, schema, transaction, DataTypes });
    });
    const [rows] = await sequelize.query(`SELECT "id", "quantity" FROM "${schema}"."MealIngredients"`);
    expect(rows).toEqual([{ id: 'a', quantity: '3.750000' }]);
    const [meals] = await sequelize.query(`SELECT "name", "archived" FROM "${schema}"."Meals"`);
    expect(meals).toEqual([{ name: 'Breakfast', archived: false }]);
    const [constraints] = await sequelize.query(`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = :schema AND table_name = 'MealIngredients' AND constraint_type = 'UNIQUE'`, { replacements: { schema } });
    expect(constraints).toContainEqual({ constraint_name: 'meal_ingredient_unique' });
    await expect(sequelize.query(`INSERT INTO "${schema}"."MealIngredients"
      ("id", "mealId", "ingredientId", "quantity", "createdAt", "updatedAt")
      VALUES ('duplicate', 'meal', 'ingredient', 10, NOW(), NOW())`)).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  } finally { await sequelize.dropSchema(schema, { cascade: true }); }
});
