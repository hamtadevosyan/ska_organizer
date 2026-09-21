const db = require('./dbAdapter');
const rooms = require('./roomService');
const { validateWeekStart, problem } = require('./planValidation');
const validation = require('./activityValidation');
const { fieldError } = require('./catalogValidation');

async function values(payload, previous) {
  const result = validation.activity(payload, previous);
  if (result.roomId !== null && result.roomId !== previous?.roomId) await rooms.requireRoom(result.roomId, { active: true });
  result.materials = await Promise.all(result.materials.map(async (material) => {
    const item = await db.getInventoryById(material.itemId);
    if (!item) throw fieldError('materials', 'A material is no longer in Inventory. Choose it again.');
    if (item.unit !== material.unit) throw fieldError('materials', 'The material unit changed. Choose the inventory item again and review its quantity.', 409);
    return { ...material, name: item.name, location: item.location };
  }));
  return result;
}
exports.listActivities = (opts = {}) => {
  if (opts.q !== undefined && (typeof opts.q !== 'string' || opts.q.length > 100)) throw problem('Invalid activity search.');
  if (opts.roomId !== undefined) validation.identifier(opts.roomId, 'roomId');
  return db.listActivities(opts);
};
exports.getById = (id) => db.getActivityById(id);
exports.createActivity = (payload) => db.withRoomLock(() => db.withInventoryLock(async () =>
  db.createActivity(await values(payload))));
exports.updateActivity = (id, changes) => db.withRoomLock(() => db.withInventoryLock(async () => {
  const previous = await db.getActivityById(id);
  if (!previous) return null;
  return db.updateActivity(id, await values(changes, previous));
}));
exports.deleteActivity = (id) => db.withRoomLock(async () => {
  if (await db.activityInSchedule(id)) throw problem('This activity is used in a saved schedule and cannot be deleted.', 409);
  return db.deleteActivity(id);
});
exports.generateWeeklyPlan = async (roomId, weekStart) => {
  await rooms.requireRoom(roomId);
  validateWeekStart(weekStart);
  const activities = (await db.listActivities()).filter((activity) => !activity.roomId || activity.roomId === roomId);
  const byId = new Map(activities.map((activity) => [activity.id, activity.name]));
  const existing = await db.listScheduleEntries(roomId, weekStart);
  if (existing.length) return existing.map((entry) => ({
    day: new Date(entry.date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) + ' — ' + (entry.startTime ? entry.startTime + '–' + entry.endTime : entry.timeBlock),
    activity: entry.activitySnapshot?.name || byId.get(entry.activityId) || 'Unavailable activity',
  }));
  if (!activities.length) return [];
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
    day, activity: activities[index % activities.length].name,
  }));
};
exports.getSavedWeeklyPlan = (roomId, weekStart) => require('./scheduleService').listWeek(roomId, weekStart);
exports.saveWeeklyPlan = (roomId, weekStart, week, version) => require('./scheduleService').saveWeek(roomId, weekStart, week, version);
