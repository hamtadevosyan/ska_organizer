const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const { createConnection } = require('../database/connection');
const { assertMigrated } = require('../database/migrate');
const defineModels = require('../database/models');
let sequelize;
let models;
const plain = (row) => row ? row.get({ plain: true }) : null;

exports.setup = async (connectionString, { schema = 'public' } = {}) => {
  if (sequelize) throw new Error('Database adapter is already initialized.');
  const connection = createConnection(connectionString, { schema });
  try {
    await connection.authenticate();
    await assertMigrated(connection, schema);
    models = defineModels(connection);
    sequelize = connection;
    return { sequelize, ...models };
  } catch (error) {
    await connection.close();
    throw error;
  }
};
exports.close = async () => {
  if (sequelize) await sequelize.close();
  sequelize = undefined;
  models = undefined;
};
function model(name) {
  if (!models) throw new Error('Database adapter is not initialized.');
  return models[name];
}
const list = async (name, options = {}) => (await model(name).findAll(options)).map(plain);
const get = async (name, id) => plain(await model(name).findByPk(id));
const create = async (name, payload) => {
  const entity = model(name);
  return sequelize.transaction(async (transaction) => plain(await entity.create(payload, { transaction })));
};
const update = async (name, id, changes) => {
  const entity = model(name);
  return sequelize.transaction(async (transaction) => {
    const row = await entity.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    return row ? plain(await row.update(changes, { transaction })) : null;
  });
};
const remove = async (name, id) => {
  const entity = model(name);
  return sequelize.transaction(async (transaction) => (await entity.destroy({ where: { id }, transaction })) > 0);
};

exports.listMeals = async ({ type } = {}) => list('Meal', {
  where: type ? { type } : {}, order: [['createdAt', 'ASC'], ['id', 'ASC']],
});
exports.listMealsByType = (type) => exports.listMeals({ type });
exports.getMealById = (id) => get('Meal', id);
exports.createMeal = (payload) => create('Meal', payload);
exports.updateMeal = (id, changes) => update('Meal', id, changes);
exports.deleteMeal = (id) => remove('Meal', id);
exports.listIngredients = () => list('Ingredient', { order: [['createdAt', 'ASC'], ['id', 'ASC']] });
exports.getIngredientById = (id) => get('Ingredient', id);
exports.createIngredient = (payload) => create('Ingredient', payload);
exports.updateIngredient = (id, changes) => update('Ingredient', id, changes);
exports.deleteIngredient = (id) => remove('Ingredient', id);
exports.listMealIngredients = (mealId) => list('MealIngredient', { where: { mealId }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
exports.addMealIngredient = (payload) => create('MealIngredient', payload);
exports.updateMealIngredient = (id, changes) => update('MealIngredient', id, changes);
exports.deleteMealIngredient = (id) => remove('MealIngredient', id);

exports.saveConfirmedMenu = async ({ week }) => {
  if (!Array.isArray(week)) throw new Error('week must be an array');
  const entity = model('ConfirmedMenu');
  return sequelize.transaction(async (transaction) => {
    const [record] = await entity.upsert({ id: 'current', week, confirmedAt: new Date() }, { transaction });
    const row = plain(record);
    return { week: row.week, confirmedAt: row.confirmedAt };
  });
};
exports.getConfirmedMenu = async () => {
  const row = await get('ConfirmedMenu', 'current');
  return row ? { week: row.week, confirmedAt: row.confirmedAt } : null;
};
exports.saveShelfCheck = async (items) => {
  if (!Array.isArray(items)) throw new Error('Shelf items must be an array');
  const entity = model('ShelfCheck');
  return sequelize.transaction(async (transaction) => {
    const [record] = await entity.upsert({ id: 'current', items }, { transaction });
    return plain(record).items;
  });
};
exports.getShelf = async () => (await get('ShelfCheck', 'current'))?.items || [];

exports.listChildren = ({ q, page = 1, pageSize = 50 } = {}) => list('Child', {
  where: q ? { [Op.or]: [{ firstName: { [Op.iLike]: `%${q}%` } }, { lastName: { [Op.iLike]: `%${q}%` } }] } : {},
  limit: pageSize, offset: (page - 1) * pageSize,
});
exports.getChildById = (id) => get('Child', id);
exports.createChild = (payload) => create('Child', payload);
exports.updateChild = (id, changes) => update('Child', id, changes);
exports.deleteChild = (id) => remove('Child', id);
exports.listAttendance = ({ roomId, childId, date } = {}) => {
  const where = {};
  if (roomId) where.roomId = roomId;
  if (childId) where.childId = childId;
  if (date) {
    const start = new Date(`${date}T00:00:00Z`);
    where.checkIn = { [Op.gte]: start, [Op.lt]: new Date(start.getTime() + 86400000) };
  }
  return list('Attendance', { where });
};
exports.getAttendanceById = (id) => get('Attendance', id);
exports.createAttendance = (payload) => create('Attendance', { checkIn: new Date(), checkOut: null, ...payload });
exports.updateAttendance = (id, changes) => update('Attendance', id, changes);
exports.deleteAttendance = (id) => remove('Attendance', id);
exports.listActivities = ({ q, roomId } = {}) => list('Activity', {
  where: { ...(roomId ? { roomId } : {}), ...(q ? { name: { [Op.iLike]: `%${q}%` } } : {}) },
});
exports.getActivityById = (id) => get('Activity', id);
exports.createActivity = (payload) => create('Activity', { ...payload, id: payload.id || randomUUID() });
exports.updateActivity = (id, changes) => update('Activity', id, changes);
exports.deleteActivity = (id) => remove('Activity', id);
