const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { createConnection } = require('../database/connection');
const { assertMigrated } = require('../database/migrate');
const defineModels = require('../database/models');
let sequelize;
let models;
const plain = (row) => row ? row.get({ plain: true }) : null;
const transactionContext = new AsyncLocalStorage();
const transact = (fn) => transactionContext.getStore()
  ? fn(transactionContext.getStore())
  : sequelize.transaction((transaction) => transactionContext.run(transaction, () => fn(transaction)));
exports.withTransaction = transact;
const locked = (key, fn) => transact(async (transaction) => {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), :key)', {
    replacements: { schema: sequelize.options.define.schema, key }, transaction,
  });
  return fn();
});
exports.withCatalogLock = (fn) => locked(17003, fn);
exports.withAuthLock = (fn) => locked(17004, fn);
exports.withRoomLock = (fn) => locked(17005, fn);
exports.withInventoryLock = (fn) => locked(17006, fn);

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
const list = async (name, options = {}) => (await model(name).findAll({ transaction: transactionContext.getStore(), ...options })).map(plain);
const get = async (name, id) => plain(await model(name).findByPk(id, { transaction: transactionContext.getStore() }));
const create = async (name, payload) => {
  const entity = model(name);
  return transact(async (transaction) => plain(await entity.create(payload, { transaction })));
};
const update = async (name, id, changes) => {
  const entity = model(name);
  return transact(async (transaction) => {
    const row = await entity.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    return row ? plain(await row.update(changes, { transaction })) : null;
  });
};
const remove = async (name, id) => {
  const entity = model(name);
  return transact(async (transaction) => (await entity.destroy({ where: { id }, transaction })) > 0);
};

exports.listMeals = async ({ type, includeArchived = false } = {}) => list('Meal', {
  where: { ...(type ? { type } : {}), ...(!includeArchived ? { archived: false } : {}) }, order: [['createdAt', 'ASC'], ['id', 'ASC']],
});
exports.listMealsByType = (type) => exports.listMeals({ type });
exports.getMealById = (id) => get('Meal', id);
exports.createMeal = (payload) => create('Meal', payload);
exports.updateMeal = (id, changes) => update('Meal', id, changes);
exports.deleteMeal = (id) => remove('Meal', id);
exports.listIngredients = ({ includeArchived = false } = {}) => list('Ingredient', {
  where: includeArchived ? {} : { archived: false }, order: [['createdAt', 'ASC'], ['id', 'ASC']],
});
exports.getIngredientById = (id) => get('Ingredient', id);
exports.createIngredient = (payload) => create('Ingredient', payload);
exports.updateIngredient = (id, changes) => update('Ingredient', id, changes);
exports.deleteIngredient = (id) => remove('Ingredient', id);
exports.listMealIngredients = (mealId) => list('MealIngredient', { where: { mealId }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
exports.getMealIngredientById = (id) => get('MealIngredient', id);
exports.ingredientHasQuantities = async (id) => {
  if (await model('InventoryItem').count({ where: { ingredientId: id }, transaction: transactionContext.getStore() })) return true;
  if ((await list('MealIngredient', { where: { ingredientId: id }, limit: 1 })).length) return true;
  if ((await exports.getShelf()).some((item) => item.ingredientId === id)) return true;
  const schema = sequelize.options.define.schema;
  const [rows] = await sequelize.query(`SELECT 1 FROM "${schema}"."WeeklyPlans"
    WHERE "snapshot"->'items' @> CAST(:item AS jsonb)
      OR "snapshot"->'inHouse' ? :id LIMIT 1`, {
    replacements: { id, item: JSON.stringify([{ ingredient: { id } }]) }, transaction: transactionContext.getStore(),
  });
  return rows.length > 0;
};
exports.addMealIngredient = (payload) => create('MealIngredient', payload);
exports.updateMealIngredient = (id, changes) => update('MealIngredient', id, changes);
exports.deleteMealIngredient = (id) => remove('MealIngredient', id);

exports.saveConfirmedMenu = async ({ week }) => {
  if (!Array.isArray(week)) throw new Error('week must be an array');
  const entity = model('ConfirmedMenu');
  return transact(async (transaction) => {
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
  return transact(async (transaction) => {
    const [record] = await entity.upsert({ id: 'current', items }, { transaction });
    return plain(record).items;
  });
};
exports.getShelf = async () => (await get('ShelfCheck', 'current'))?.items || [];

const unpackPlan = (row) => row ? {
  ...row.snapshot, weekStart: row.weekStart, version: row.version,
  savedAt: new Date(row.savedAt).toISOString(),
} : null;
exports.getWeeklyPlan = async (weekStart) => unpackPlan(await get('WeeklyPlan', weekStart));
exports.saveWeeklyPlan = async (snapshot, expectedVersion) => {
  const { problem } = require('./planValidation');
  const entity = model('WeeklyPlan');
  return transact(async (transaction) => {
    // Serialize even the first insert, when there is no row to lock yet.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:schema), hashtext(:week))', {
      replacements: { schema: sequelize.options.define.schema, week: `plan:${snapshot.weekStart}` }, transaction,
    });
    const previous = await entity.findByPk(snapshot.weekStart, { transaction, lock: transaction.LOCK.UPDATE });
    if ((previous?.version || 0) !== expectedVersion) {
      throw problem('This week was saved elsewhere. Reopen the saved week before saving again.', 409);
    }
    const values = { weekStart: snapshot.weekStart, version: expectedVersion + 1, snapshot, savedAt: new Date() };
    const row = previous ? await previous.update(values, { transaction }) : await entity.create(values, { transaction });
    return unpackPlan(plain(row));
  });
};

const literalLike = (value) => value.replace(/[\\%_]/g, '\\$&');
exports.listInventoryGroups = () => list('InventoryGroup', { order: [['name', 'ASC'], ['id', 'ASC']] });
exports.inventoryGroupCounts = async () => {
  const schema = sequelize.options.define.schema;
  const [rows] = await sequelize.query('SELECT "groupId", count(*)::integer AS "total", ' +
    'count(*) FILTER (WHERE "quantity" > "reorderThreshold")::integer AS "available", ' +
    'count(*) FILTER (WHERE "quantity" > 0 AND "quantity" <= "reorderThreshold")::integer AS "lowStock", ' +
    'count(*) FILTER (WHERE "quantity" = 0)::integer AS "outOfStock" FROM "' + schema + '"."InventoryItems" GROUP BY "groupId"', { transaction: transactionContext.getStore() });
  return rows;
};
exports.getInventoryGroupById = (id) => get('InventoryGroup', id);
exports.getInventoryGroupByName = async (nameKey) => (await list('InventoryGroup', { where: { nameKey }, limit: 1 }))[0] || null;
exports.getInventoryGroupByRequestId = async (requestId) => (await list('InventoryGroup', { where: { requestId }, limit: 1 }))[0] || null;
exports.createInventoryGroup = (values) => create('InventoryGroup', values);
const inventoryWhere = ({ q, category, location, status, groupId } = {}) => {
  const checks = q ? q.split(/\s+/).map((part) => sqlWhere(col('name'), { [Op.iLike]: '%' + literalLike(part) + '%' })) : [];
  if (status === 'out') checks.push(sqlWhere(col('quantity'), Op.eq, 0));
  if (status === 'low') checks.push(sqlWhere(col('quantity'), Op.gt, 0), sqlWhere(col('quantity'), Op.lte, col('reorderThreshold')));
  if (status === 'available') checks.push(sqlWhere(col('quantity'), Op.gt, col('reorderThreshold')));
  return { ...(category ? { category } : {}), ...(groupId ? { groupId } : {}), ...(location ? { location } : {}), ...(checks.length ? { [Op.and]: checks } : {}) };
};
exports.listInventory = ({ page = 1, pageSize = 50, ...filters } = {}) => list('InventoryItem', {
  where: inventoryWhere(filters), limit: pageSize, offset: (page - 1) * pageSize, order: [['name', 'ASC'], ['id', 'ASC']],
});
exports.countInventory = (filters) => model('InventoryItem').count({ where: inventoryWhere(filters), transaction: transactionContext.getStore() });
exports.inventoryOptions = async () => {
  const rows = await list('InventoryItem', { attributes: ['category', 'location'], group: ['category', 'location'] });
  return { categories: [...new Set(rows.map((row) => row.category))].sort(), locations: [...new Set(rows.map((row) => row.location))].sort() };
};
exports.getInventoryById = (id) => get('InventoryItem', id);
exports.createInventory = (values) => create('InventoryItem', values);
exports.updateInventory = (id, values) => update('InventoryItem', id, values);
exports.appendInventoryMovement = (values) => create('InventoryMovement', values);
exports.getInventoryMovementByRequestId = async (requestId) => (await list('InventoryMovement', { where: { requestId }, limit: 1 }))[0] || null;
exports.listInventoryMovements = (itemId, { page = 1, pageSize = 50 } = {}) => list('InventoryMovement', {
  where: { itemId }, order: [['itemVersion', 'DESC']], limit: pageSize, offset: (page - 1) * pageSize,
});
exports.countInventoryMovements = (itemId) => model('InventoryMovement').count({ where: { itemId }, transaction: transactionContext.getStore() });

exports.listInventoryForIngredients = (ids) => list('InventoryItem', { where: { ingredientId: { [Op.in]: ids } }, order: [['id', 'ASC']] });
exports.createPurchaseReceipt = (values) => create('PurchaseReceipt', values);
exports.getPurchaseByMovementId = async (movementId) => (await list('PurchaseReceipt', { where: { movementId }, limit: 1 }))[0] || null;
exports.listPurchaseReceipts = ({ itemId, page = 1, pageSize = 25 } = {}) => list('PurchaseReceipt', {
  where: itemId ? { itemId } : {}, order: [['receivedOn', 'DESC'], ['recordedAt', 'DESC'], ['id', 'DESC']],
  limit: pageSize, offset: (page - 1) * pageSize,
});
exports.countPurchaseReceipts = ({ itemId } = {}) => model('PurchaseReceipt').count({
  where: itemId ? { itemId } : {}, transaction: transactionContext.getStore(),
});

const staffWhere = ({ q, roomId, active } = {}) => ({
  ...(roomId !== undefined ? { roomId } : {}),
  ...(active !== undefined ? { active } : {}),
  ...(q ? { [Op.and]: q.split(/\s+/).map((part) => sqlWhere(col('name'),
    { [Op.iLike]: '%' + literalLike(part) + '%' })) } : {}),
});
exports.listStaff = ({ page = 1, pageSize = 50, ...filters } = {}) => list('StaffMember', {
  where: staffWhere(filters), limit: pageSize, offset: (page - 1) * pageSize,
  order: [['name', 'ASC'], ['id', 'ASC']],
});
exports.countStaff = (filters) => model('StaffMember').count({ where: staffWhere(filters), transaction: transactionContext.getStore() });
exports.getStaffById = (id) => get('StaffMember', id);
exports.createStaff = (payload) => create('StaffMember', payload);
exports.updateStaff = (id, changes) => update('StaffMember', id, changes);

const childWhere = ({ q, roomId, active } = {}) => ({
  ...(roomId !== undefined ? { roomId } : {}),
  ...(active !== undefined ? { active } : {}),
  ...(q ? { [Op.and]: q.split(/\s+/).map((part) => sqlWhere(fn('concat_ws', ' ', col('firstName'), col('lastName'), col('preferredName')),
    { [Op.iLike]: '%' + literalLike(part) + '%' })) } : {}),
});
exports.listChildren = ({ page = 1, pageSize = 50, ...filters } = {}) => list('Child', {
  where: childWhere(filters), limit: pageSize, offset: (page - 1) * pageSize,
  order: [['firstName', 'ASC'], ['lastName', 'ASC'], ['id', 'ASC']],
});
exports.countChildren = (filters) => model('Child').count({ where: childWhere(filters), transaction: transactionContext.getStore() });
exports.findChildDuplicates = (firstName, lastName, excludeId) => list('Child', {
  where: {
    ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    [Op.and]: [['firstName', firstName], ['lastName', lastName]].map(([key, value]) =>
      sqlWhere(fn('lower', fn('regexp_replace', fn('btrim', col(key)), '\\s+', ' ', 'g')), value.toLowerCase())),
  }, order: [['createdAt', 'ASC'], ['id', 'ASC']], limit: 20,
});
exports.roomChildCounts = async () => Object.fromEntries((await model('Child').findAll({
  attributes: ['roomId', [fn('COUNT', col('id')), 'count']], where: { roomId: { [Op.ne]: null }, active: true },
  group: ['roomId'], raw: true, transaction: transactionContext.getStore(),
})).map((row) => [row.roomId, Number(row.count)]));
exports.listRooms = ({ includeArchived = false } = {}) => list('Room', {
  where: includeArchived ? {} : { active: true }, order: [['name', 'ASC'], ['id', 'ASC']],
});
exports.getRoomById = (id) => get('Room', id);
exports.createRoom = (payload) => create('Room', payload);
exports.updateRoom = (id, payload) => update('Room', id, payload);
const scheduleWhere = (roomId, weekStart) => {
  const end = new Date(weekStart + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 7);
  return { roomId, date: { [Op.gte]: weekStart, [Op.lt]: end.toISOString().slice(0, 10) } };
};
exports.listScheduleEntries = (roomId, weekStart) => list('ScheduleEntry', {
  where: scheduleWhere(roomId, weekStart), order: [['date', 'ASC'], ['startTime', 'ASC'], ['id', 'ASC']],
});
exports.getScheduleEntryById = (id) => get('ScheduleEntry', id);
exports.getScheduleWeek = async (roomId, weekStart) => (await list('ScheduleWeek', { where: { roomId, weekStart } }))[0] || null;
// All schedule writes share the room lock with room/activity changes.
exports.saveScheduleWeek = (values) => transact(async (transaction) => {
  await model('ScheduleWeek').upsert(values, { transaction });
  return exports.getScheduleWeek(values.roomId, values.weekStart);
});
exports.activityInSchedule = async (id) => (await model('ScheduleEntry').count({ where: { activityId: id }, transaction: transactionContext.getStore() })) > 0;
exports.saveScheduleEntries = (roomId, weekStart, entries) => transact(async (transaction) => {
  await model('ScheduleEntry').destroy({ where: scheduleWhere(roomId, weekStart), transaction });
  if (entries.length) await model('ScheduleEntry').bulkCreate(entries.map((entry) => ({
    ...entry, roomId, id: entry.id || randomUUID(),
  })), { transaction });
  return exports.listScheduleEntries(roomId, weekStart);
});

exports.getChildById = (id) => get('Child', id);
exports.createChild = (payload) => create('Child', payload);
exports.updateChild = (id, changes) => update('Child', id, changes);
exports.deleteChild = (id) => remove('Child', id);
exports.listAttendance = ({ roomId, childId, date, from, to, openOnly = false, includeVoided = true, needsReview } = {}) => {
  const where = {};
  if (roomId) where.roomId = roomId;
  if (childId) where.childId = childId;
  if (date) ({ from, to } = require('./facilityTime').dayBounds(date));
  if (to) where.checkIn = { [Op.lt]: new Date(to) };
  if (from) where[Op.or] = [{ checkOut: null }, { checkOut: { [Op.gt]: new Date(from) } }, { checkIn: { [Op.gte]: new Date(from) } }];
  if (openOnly) where.checkOut = null;
  if (!includeVoided) where.voided = false;
  if (needsReview !== undefined) where.needsReview = needsReview;
  return list('Attendance', { where, order: [['checkIn', 'ASC'], ['id', 'ASC']] });
};
exports.getAttendanceByRequestId = async (requestId) => (await list('Attendance', { where: { requestId }, limit: 1 }))[0] || null;
exports.createAttendanceCorrection = (values) => create('AttendanceCorrection', values);
exports.listAttendanceCorrections = async (attendanceId) => (await list('AttendanceCorrection', { where: { attendanceId } }))
  .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt) || a.after.version - b.after.version);
exports.getAttendanceById = (id) => get('Attendance', id);
exports.createAttendance = (payload) => create('Attendance', { checkIn: new Date(), checkOut: null, ...payload });
exports.updateAttendance = (id, changes) => update('Attendance', id, changes);
exports.deleteAttendance = (id) => remove('Attendance', id);
exports.listActivities = ({ q, roomId } = {}) => list('Activity', {
  where: { ...(roomId ? { roomId } : {}), ...(q ? { name: { [Op.iLike]: `%${q}%` } } : {}) },
  order: [['name', 'ASC'], ['id', 'ASC']],
});
exports.getActivityById = (id) => get('Activity', id);
exports.createActivity = (payload) => create('Activity', { ...payload, id: payload.id || randomUUID() });
exports.updateActivity = (id, changes) => update('Activity', id, changes);
exports.deleteActivity = (id) => remove('Activity', id);

exports.listAccounts = () => list('Account', { order: [['username', 'ASC']] });
exports.getAccount = (id) => get('Account', id);
exports.findAccount = async (username) => (await list('Account', { where: { username }, limit: 1 }))[0] || null;
exports.createAccount = (values) => create('Account', values);
exports.updateAccount = (id, values) => update('Account', id, values);
exports.createSession = (values) => create('Session', values);
exports.getSession = (id) => get('Session', id);
exports.updateSession = (id, values) => update('Session', id, values);
exports.deleteSession = (id) => remove('Session', id);
exports.revokeSessions = (accountId) => transact((transaction) => model('Session').destroy({ where: { accountId }, transaction }));
exports.getLoginAttempt = (id) => get('LoginAttempt', id);
exports.saveLoginAttempt = (values) => transact((transaction) => model('LoginAttempt').upsert(values, { transaction }));
exports.deleteLoginAttempt = (id) => remove('LoginAttempt', id);
exports.cleanAuthRecords = (now) => transact(async (transaction) => {
  for (const name of ['Session', 'LoginAttempt']) {
    await model(name).destroy({ where: { expiresAt: { [Op.lte]: now } }, transaction });
  }
});
exports.appendAudit = (values) => create('AuditEvent', values);
exports.listAudit = ({ limit = 50, offset = 0, actions } = {}) => list('AuditEvent', {
  ...(actions ? { where: { action: { [Op.in]: actions } } } : {}),
  order: [['occurredAt', 'DESC'], ['id', 'DESC']], limit, offset,
});
