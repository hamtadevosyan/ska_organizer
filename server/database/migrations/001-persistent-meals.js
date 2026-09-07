// Published migrations are immutable. Add a new numbered migration for later changes.
module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const id = () => ({ type: T.STRING, primaryKey: true, allowNull: false });
    const dates = () => ({
      createdAt: { type: T.DATE, allowNull: false },
      updatedAt: { type: T.DATE, allowNull: false },
    });
    const table = (tableName) => ({ tableName, schema });
    const create = (name, columns) => qi.createTable(table(name), columns, { transaction });
    await create('Meals', {
      id: id(), name: { type: T.STRING, allowNull: false },
      type: { type: T.STRING, allowNull: false },
      description: { type: T.TEXT, allowNull: false, defaultValue: '' }, ...dates(),
    });
    await create('Ingredients', {
      id: id(), name: { type: T.STRING, allowNull: false },
      unit: { type: T.STRING, allowNull: false }, shelfLifeDays: T.INTEGER, ...dates(),
    });
    await create('MealIngredients', {
      id: id(),
      mealId: { type: T.STRING, allowNull: false, references: { model: table('Meals'), key: 'id' }, onDelete: 'CASCADE' },
      ingredientId: { type: T.STRING, allowNull: false, references: { model: table('Ingredients'), key: 'id' }, onDelete: 'RESTRICT' },
      quantity: { type: T.DECIMAL(18, 6), allowNull: false }, ...dates(),
    });
    await qi.addIndex(table('MealIngredients'), ['mealId'], { transaction });
    await sequelize.query(`ALTER TABLE "${schema}"."MealIngredients" ADD CONSTRAINT "recipe_quantity_valid" CHECK ("quantity" >= 0 AND "quantity" <> 'NaN'::numeric)`, { transaction });
    await create('ConfirmedMenus', {
      id: id(), week: { type: T.JSONB, allowNull: false }, confirmedAt: { type: T.DATE, allowNull: false },
    });
    await create('ShelfChecks', { id: id(), items: { type: T.JSONB, allowNull: false } });
    await create('Children', {
      id: id(), firstName: T.STRING, lastName: T.STRING, dateOfBirth: T.DATEONLY,
      preferredName: T.STRING, photoConsent: T.BOOLEAN, notes: T.TEXT, ...dates(),
    });
    await create('Attendances', {
      id: id(), childId: { type: T.STRING, allowNull: false }, roomId: T.STRING,
      checkIn: T.DATE, checkOut: T.DATE, recordedBy: T.STRING,
    });
    await create('Activities', {
      id: id(), name: { type: T.STRING, allowNull: false }, description: T.TEXT,
      category: T.STRING, repeatWindowWeeks: T.INTEGER, type: T.STRING,
      location: T.STRING, ageMin: T.INTEGER, ageMax: T.INTEGER,
      energyLevel: T.STRING, estimatedCost: T.FLOAT, materialsLinks: T.JSON,
      materialsNotes: T.TEXT, roomId: T.STRING, startTime: T.DATE, endTime: T.DATE, ...dates(),
    });
  },
};
