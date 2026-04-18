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

