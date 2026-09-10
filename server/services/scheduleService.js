const db = require('./dbAdapter');
const rooms = require('./roomService');
const { problem, validateWeekStart } = require('./planValidation');
const { dateOnly } = require('./roomValidation');

exports.listWeek = async (roomId, weekStart) => {
  await rooms.requireRoom(roomId);
  validateWeekStart(weekStart);
  return db.listScheduleEntries(roomId, weekStart);
};
exports.saveWeek = (roomId, weekStart, entries) => db.withRoomLock(async () => {
  await rooms.requireRoom(roomId, { active: true });
  validateWeekStart(weekStart);
  if (!Array.isArray(entries) || entries.length > 21) throw problem('Supply at most 21 schedule entries.');
  const end = new Date(weekStart + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 7);
  const endDate = end.toISOString().slice(0, 10);
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw problem('Invalid schedule entry.');
    dateOnly(entry.date);
    if (entry.date < weekStart || entry.date >= endDate || !['morning', 'midday', 'afternoon'].includes(entry.timeBlock)) {
      throw problem('Schedule entries must be in the selected week and a supported time block.');
    }
    const key = entry.date + ':' + entry.timeBlock;
    if (seen.has(key)) throw problem('Choose one activity for each schedule block.');
    seen.add(key);
    if (typeof entry.activityId !== 'string') throw problem('Choose a valid activity.');
    const activity = await db.getActivityById(entry.activityId);
    if (!activity || (activity.roomId && activity.roomId !== roomId)) throw problem('Choose an activity available to this room.');
    normalized.push({ date: entry.date, timeBlock: entry.timeBlock, activityId: entry.activityId });
  }
  return db.saveScheduleEntries(roomId, weekStart, normalized);
});


// Helper: get last N weeks of entries
async function getRecentEntries(roomId, weekStart, weeksBack = 8) {
  const start = new Date(weekStart);
  const entries = [];

  for (let i = 1; i <= weeksBack; i++) {
    const prev = new Date(start);
    prev.setUTCDate(prev.getUTCDate() - i * 7);
    const iso = prev.toISOString().slice(0, 10);
    const weekEntries = await db.listScheduleEntries(roomId, iso);
    entries.push(...weekEntries);
  }

  return entries;
}

// Helper: compute activity score
function scoreActivity(activity, context) {
  let score = 0;

  // 1. Avoid repeating thematic activities too soon
  if (activity.category === 'thematic') {
    const lastUsed = context.recentById[activity.id];
    if (lastUsed) {
      const weeksSince = context.weeksSince(lastUsed);
      if (weeksSince < activity.repeatWindowWeeks) {
        score -= 100; // hard penalty
      }
    }
  }

  // 2. Age range match
  if (context.ageMinMonths < activity.ageMin * 12 || context.ageMaxMonths > activity.ageMax * 12) {
    score -= 50;
  }

  // 3. Energy balancing
  if (context.prevEnergy === activity.energyLevel) {
    score -= 10;
  }

  // 4. Indoor/outdoor balancing
  if (context.prevLocation === activity.location) {
    score -= 5;
  }

  // 5. Cost
  if (activity.estimatedCost > 20) score -= 5;
  if (activity.estimatedCost === 0) score += 5;

  // 6. Materials availability
  if (activity.materialsLinks?.length > 0 && !context.materialsAvailable) {
    score -= 10;
  }

  return score;
}

exports.suggestWeek = async (roomId, weekStart) => {
  // 1. Load all activities
  const room = await rooms.requireRoom(roomId, { active: true });
  validateWeekStart(weekStart);
  const activities = (await db.listActivities()).filter((activity) => !activity.roomId || activity.roomId === roomId);
  if (!activities.length) return { weekStart, entries: [] };

  // 2. Load recent entries to avoid repeats
  const recent = await getRecentEntries(roomId, weekStart);

  const recentById = {};
  for (const e of recent) {
    recentById[e.activityId] = e.date;
  }

  // 3. Build context helpers
  const context = {
    ageMinMonths: room.ageMinMonths, ageMaxMonths: room.ageMaxMonths,
    recentById,
    weeksSince: (dateStr) => {
      const then = new Date(dateStr);
      const now = new Date(weekStart);
      const diff = (now - then) / (1000 * 60 * 60 * 24 * 7);
      return Math.floor(diff);
    }
  };

  // 4. Build the week structure
  const week = [];
  const start = new Date(weekStart);

  const timeBlocks = ['morning', 'midday', 'afternoon'];

  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    const iso = day.toISOString().slice(0, 10);

    let prevEnergy = null;
    let prevLocation = null;

    for (const block of timeBlocks) {
      context.prevEnergy = prevEnergy;
      context.prevLocation = prevLocation;

      // Score all activities
      const scored = activities.map(a => ({
        activity: a,
        score: scoreActivity(a, context)
      }));

      // Pick best
      scored.sort((a, b) => b.score - a.score);
      const chosen = scored[0].activity;

      // Update context
      prevEnergy = chosen.energyLevel;
      prevLocation = chosen.location;

      week.push({
        date: iso,
        timeBlock: block,
        activityId: chosen.id
      });
    }
  }

  return {
    weekStart,
    entries: week
  };
};
