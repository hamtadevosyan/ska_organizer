// Generate a 7‑day schedule grid with empty time blocks
export function generateEmptyWeek(weekStart) {
  const grid = {};
  const start = new Date(weekStart);

  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const iso = d.toISOString().slice(0, 10);

    grid[iso] = {
      morning: { activityId: null },
      midday: { activityId: null },
      afternoon: { activityId: null }
    };
  }

  return grid;
}

// Convert backend entries → frontend grid structure
export function buildGridFromEntries(entries, weekStart) {
  const grid = generateEmptyWeek(weekStart);

  for (const e of entries) {
    if (grid[e.date] && grid[e.date][e.timeBlock]) {
      grid[e.date][e.timeBlock].activityId = e.activityId;
    }
  }

  return grid;
}

// Merge suggestions into the current grid without overwriting user edits
export function mergeSchedule(current, suggested) {
  const merged = JSON.parse(JSON.stringify(current));

  for (const date in suggested) {
    for (const block in suggested[date]) {
      const currentId = merged[date][block].activityId;
      const suggestedId = suggested[date][block].activityId;

      // Only fill empty slots
      if (!currentId && suggestedId) {
        merged[date][block].activityId = suggestedId;
      }
    }
  }

  return merged;
}

