const db = require('./dbAdapter');
const rooms = require('./roomService');
const { validateWeekStart } = require('./planValidation');
const activityFields = ['name', 'description', 'roomId', 'startTime', 'endTime', 'category', 'repeatWindowWeeks',
  'type', 'location', 'ageMin', 'ageMax', 'energyLevel', 'estimatedCost', 'materialsLinks', 'materialsNotes'];
const values = (payload) => Object.fromEntries(activityFields.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]]));

exports.listActivities = (opts = {}) => db.listActivities(opts);
exports.getById = (id) => db.getActivityById(id);
exports.createActivity = (payload) => db.withRoomLock(async () => {
  if (payload.roomId != null) await rooms.requireRoom(payload.roomId, { active: true });
  return db.createActivity({ description: '', roomId: null, startTime: null, endTime: null, ...values(payload) });
});
exports.updateActivity = (id, changes) => db.withRoomLock(async () => {
  const previous = await db.getActivityById(id);
  if (!previous) return null;
  if (changes.roomId != null && changes.roomId !== previous.roomId) await rooms.requireRoom(changes.roomId, { active: true });
  return db.updateActivity(id, values(changes));
});
exports.deleteActivity = (id) => db.withRoomLock(() => db.deleteActivity(id));
exports.generateWeeklyPlan = async (roomId, weekStart) => {
  await rooms.requireRoom(roomId);
  validateWeekStart(weekStart);
  const activities = (await db.listActivities()).filter((activity) => !activity.roomId || activity.roomId === roomId);
  const byId = new Map(activities.map((activity) => [activity.id, activity.name]));
  const existing = await db.listScheduleEntries(roomId, weekStart);
  if (existing.length) return existing.map((entry) => ({
    day: new Date(entry.date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) + ' — ' + entry.timeBlock,
    activity: byId.get(entry.activityId) || 'Unavailable activity',
  }));
  if (!activities.length) return [];
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((day, index) => ({
    day, activity: activities[index % activities.length].name,
  }));
};
exports.getSavedWeeklyPlan = (roomId, weekStart) => require('./scheduleService').listWeek(roomId, weekStart);
exports.saveWeeklyPlan = (roomId, weekStart, week) => require('./scheduleService').saveWeek(roomId, weekStart, week);
