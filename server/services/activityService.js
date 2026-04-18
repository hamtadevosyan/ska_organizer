// server/services/activityService.js
const db = require('./dbAdapter');

exports.listActivities = (opts = {}) => {
  return db.listActivities(opts);
};

exports.getById = (id) => {
  return db.getActivityById(id);
};

exports.createActivity = (payload) => {
  return db.createActivity({
    id: payload.id,
    name: payload.name,
    description: payload.description || '',
    roomId: payload.roomId || null,
    startTime: payload.startTime || null,
    endTime: payload.endTime || null
  });
};

exports.updateActivity = (id, changes) => {
  return db.updateActivity(id, changes);
};

exports.deleteActivity = (id) => {
  return db.deleteActivity(id);
};

// -------------------------
// NEW WEEKLY PLAN SERVICE
// -------------------------

let currentWeekPlan = null;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const ACTIVITIES = [
  "Reading Time",
  "Outdoor Play",
  "Art & Crafts",
  "Math Practice",
  "Science Exploration",
];

exports.generateWeeklyPlan = () => {
  return DAYS.map((day, index) => ({
    day,
    activity: ACTIVITIES[index % ACTIVITIES.length],
  }));
};

exports.getSavedWeeklyPlan = () => {
  return currentWeekPlan;
};

exports.saveWeeklyPlan = (plan) => {
  currentWeekPlan = plan;
  return currentWeekPlan;
};

