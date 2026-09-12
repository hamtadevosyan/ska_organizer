const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const id = () => ({ type: DataTypes.STRING, primaryKey: true, defaultValue: DataTypes.UUIDV4 });
  const Meal = sequelize.define('Meal', {
    id: id(), name: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  const Ingredient = sequelize.define('Ingredient', {
    id: id(), name: { type: DataTypes.STRING, allowNull: false },
    unit: { type: DataTypes.STRING, allowNull: false },
    shelfLifeDays: { type: DataTypes.INTEGER, validate: { min: 0 } },
    archived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
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
  const WeeklyPlan = sequelize.define('WeeklyPlan', {
    weekStart: { type: DataTypes.DATEONLY, primaryKey: true },
    version: { type: DataTypes.INTEGER, allowNull: false },
    snapshot: { type: DataTypes.JSONB, allowNull: false },
    savedAt: { type: DataTypes.DATE, allowNull: false },
  }, { timestamps: false });
  // One atomic snapshot matches the existing shelf-check API.
  const ShelfCheck = sequelize.define('ShelfCheck', {
    id: { type: DataTypes.STRING, primaryKey: true },
    items: { type: DataTypes.JSONB, allowNull: false },
  }, { timestamps: false });
  // Preserve the earlier adapter contracts; later stories complete these modules.
  const Room = sequelize.define('Room', {
    id: id(), name: { type: DataTypes.STRING(100), allowNull: false },
    ageMinMonths: DataTypes.INTEGER, ageMaxMonths: DataTypes.INTEGER, capacity: DataTypes.INTEGER,
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  const Child = sequelize.define('Child', {
    id: id(), firstName: DataTypes.STRING, lastName: DataTypes.STRING,
    dateOfBirth: DataTypes.DATEONLY, preferredName: DataTypes.STRING,
    photoConsent: DataTypes.BOOLEAN, notes: DataTypes.TEXT, roomId: DataTypes.STRING,
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  const Attendance = sequelize.define('Attendance', {
    id: id(), childId: { type: DataTypes.STRING, allowNull: false },
    roomId: DataTypes.STRING, checkIn: DataTypes.DATE,
    checkOut: DataTypes.DATE, recordedBy: DataTypes.STRING,
  }, { timestamps: false });
  const Activity = require('../models/activity')(sequelize, DataTypes);
  const ScheduleEntry = require('../models/scheduleEntry')(sequelize, DataTypes);
  const Account = sequelize.define('Account', {
    id: id(), username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    displayName: { type: DataTypes.STRING(100), allowNull: false },
    passwordHash: { type: DataTypes.TEXT, allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false },
    disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    mustChangePassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  });
  const Session = sequelize.define('Session', {
    id: id(), accountId: { type: DataTypes.STRING, allowNull: false },
    createdAt: DataTypes.DATE, lastSeenAt: DataTypes.DATE, expiresAt: DataTypes.DATE,
  }, { timestamps: false });
  const LoginAttempt = sequelize.define('LoginAttempt', {
    id: id(), count: DataTypes.INTEGER, expiresAt: DataTypes.DATE,
  }, { timestamps: false });
  const AuditEvent = sequelize.define('AuditEvent', {
    id: id(), actorId: DataTypes.STRING, actorUsername: DataTypes.STRING(64),
    action: DataTypes.STRING(80), entityId: DataTypes.STRING, occurredAt: DataTypes.DATE,
  }, { timestamps: false });
  return { Meal, Ingredient, MealIngredient, ConfirmedMenu, WeeklyPlan, ShelfCheck, Child, Attendance, Activity,
    Account, Session, LoginAttempt, AuditEvent, Room, ScheduleEntry };
};
