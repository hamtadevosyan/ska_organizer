// server/services/activityService.js
const db = require('./dbAdapter');

exports.listActivities = async (opts = {}) => {
  return db.listActivities(opts);
};

exports.getById = async (id) => {
  return db.getActivityById(id);
};

exports.createActivity = async (payload) => {
  return db.createActivity({
    id: payload.id,
    name: payload.name,
    description: payload.description || '',
    roomId: payload.roomId || null,
    startTime: payload.startTime || null,
    endTime: payload.endTime || null
  });
};

exports.updateActivity = async (id, changes) => {
  return db.updateActivity(id, changes);
};

exports.deleteActivity = async (id) => {
  return db.deleteActivity(id);
};

// -------------------------
// WEEKLY PLAN SERVICE
// -------------------------

exports.generateWeeklyPlan = async (roomId, weekStart) => {
  const activities = await db.listActivities({ roomId });

  if (!activities || activities.length === 0) {
    return [];
  }

  const existingEntries = await db.listScheduleEntries(roomId, weekStart);
  if (existingEntries && existingEntries.length > 0) {
    return existingEntries;
  }

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  return days.map((day, index) => {
    const activity = activities[index % activities.length];

    return {
      day,
      activity: activity.name,
    };
  });
};

exports.getSavedWeeklyPlan = async (roomId, weekStart) => {
  const entries = await db.listScheduleEntries(roomId, weekStart);
  return entries || [];
};

exports.saveWeeklyPlan = async (roomId, weekStart, week) => {
  await db.saveScheduleEntries(roomId, weekStart, week);
  return db.listScheduleEntries(roomId, weekStart);
};
