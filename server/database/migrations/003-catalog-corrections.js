// Existing duplicate rows contributed their summed quantities to shopping.
// Retain that total and the oldest link before enforcing one link per ingredient.
exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  const query = sequelize.getQueryInterface();
  for (const tableName of ['Meals', 'Ingredients']) {
    await query.addColumn({ tableName, schema }, 'archived', {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
    }, { transaction });
  }
  const table = `"${schema}"."MealIngredients"`;
  await sequelize.query(`WITH grouped AS (
    SELECT (array_agg("id" ORDER BY "createdAt", "id"))[1] AS keeper,
      SUM("quantity") AS total FROM ${table} GROUP BY "mealId", "ingredientId"
  ) UPDATE ${table} AS link SET "quantity" = grouped.total
    FROM grouped WHERE link."id" = grouped.keeper`, { transaction });
  await sequelize.query(`DELETE FROM ${table} WHERE "id" IN (
    SELECT "id" FROM (SELECT "id", row_number() OVER (
      PARTITION BY "mealId", "ingredientId" ORDER BY "createdAt", "id") AS position
      FROM ${table}) ranked WHERE position > 1
  )`, { transaction });
  await query.addConstraint({ tableName: 'MealIngredients', schema }, {
    fields: ['mealId', 'ingredientId'], type: 'unique', name: 'meal_ingredient_unique', transaction,
  });
};
