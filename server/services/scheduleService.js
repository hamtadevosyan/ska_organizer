const db = require('./dbAdapter');
const rooms = require('./roomService');
const { validateWeekStart } = require('./planValidation');

exports.listWeek = async (roomId, weekStart) => {
  await rooms.requireRoom(roomId);
  validateWeekStart(weekStart);
  return db.listScheduleEntries(roomId, weekStart);
};
// Legacy array endpoints remain readable. Existing weeks still require the
// version from the new plan endpoint, so old clients cannot overwrite a week.
exports.saveWeek = async (roomId, weekStart, entries, version = 0) => {
  const saved = await require('./activityPlanService').save({ roomId, weekStart, entries, version, requestId: require('node:crypto').randomUUID() });
  return saved.entries;
};

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
  if (activity.ageMinMonths != null && (context.ageMinMonths < activity.ageMinMonths || context.ageMaxMonths > activity.ageMaxMonths)) {
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
  const activities = (await db.listActivities()).filter((activity) => require('./activityValidation').suitable(activity, room));
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
