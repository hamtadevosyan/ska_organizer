const db = require('./dbAdapter');
const activityService = require('./activityService');

// Helper: get last N weeks of entries
async function getRecentEntries(roomId, weekStart, weeksBack = 8) {
  const start = new Date(weekStart);
  const entries = [];

  for (let i = 1; i <= weeksBack; i++) {
    const prev = new Date(start);
    prev.setDate(prev.getDate() - i * 7);
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
  if (context.roomAge < activity.ageMin || context.roomAge > activity.ageMax) {
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
  const activities = await activityService.listActivities({});

  // 2. Load recent entries to avoid repeats
  const recent = await getRecentEntries(roomId, weekStart);

  const recentById = {};
  for (const e of recent) {
    recentById[e.activityId] = e.date;
  }

  // 3. Build context helpers
  const context = {
    roomAge: 3, // TODO: load from room model later
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
    day.setDate(start.getDate() + i);
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

//exports.getTodaySchedule = () => ({
//  activities: [], // will be filled later
//  schedule: [
//    { time: '8:00 AM', event: 'Circle Time (Preschool)' },
//    { time: '9:00 AM', event: 'Snack Time' },
//    { time: '10:00 AM', event: 'Arts & Crafts (Toddlers)' },
//    { time: '11:00 AM', event: 'Story Time (Pre-K)' }
//  ]
//});
//
