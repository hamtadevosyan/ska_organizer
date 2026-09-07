const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const id = () => ({ type: DataTypes.STRING, primaryKey: true, defaultValue: DataTypes.UUIDV4 });
  const Meal = sequelize.define('Meal', {
    id: id(), name: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
  });
  const Ingredient = sequelize.define('Ingredient', {
    id: id(), name: { type: DataTypes.STRING, allowNull: false },
    unit: { type: DataTypes.STRING, allowNull: false },
    shelfLifeDays: { type: DataTypes.INTEGER, validate: { min: 0 } },
  });
  const MealIngredient = sequelize.define('MealIngredient', {
    id: id(), mealId: { type: DataTypes.STRING, allowNull: false },
    ingredientId: { type: DataTypes.STRING, allowNull: false },
    quantity: {
      type: DataTypes.DECIMAL(18, 6), allowNull: false,
      validate: { min: 0, isDecimal: true },
      get() { return Number(this.getDataValue('quantity')); },
    },
  });
  const ConfirmedMenu = sequelize.define('ConfirmedMenu', {
    id: { type: DataTypes.STRING, primaryKey: true },
    week: { type: DataTypes.JSONB, allowNull: false },
    confirmedAt: { type: DataTypes.DATE, allowNull: false },
  }, { timestamps: false });
  // One atomic snapshot matches the existing shelf-check API.
  const ShelfCheck = sequelize.define('ShelfCheck', {
    id: { type: DataTypes.STRING, primaryKey: true },
    items: { type: DataTypes.JSONB, allowNull: false },
  }, { timestamps: false });
  // Preserve the earlier adapter contracts; later stories complete these modules.
  const Child = sequelize.define('Child', {
    id: id(), firstName: DataTypes.STRING, lastName: DataTypes.STRING,
    dateOfBirth: DataTypes.DATEONLY, preferredName: DataTypes.STRING,
    photoConsent: DataTypes.BOOLEAN, notes: DataTypes.TEXT,
  });
  const Attendance = sequelize.define('Attendance', {
    id: id(), childId: { type: DataTypes.STRING, allowNull: false },
    roomId: DataTypes.STRING, checkIn: DataTypes.DATE,
    checkOut: DataTypes.DATE, recordedBy: DataTypes.STRING,
  }, { timestamps: false });
  const Activity = require('../models/activity')(sequelize, DataTypes);
  return { Meal, Ingredient, MealIngredient, ConfirmedMenu, ShelfCheck, Child, Attendance, Activity };
};
