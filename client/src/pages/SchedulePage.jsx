import { useEffect, useState } from "react";
import {
  getWeek,
  getSuggestions,
  saveWeek
} from "../api/scheduleApi";

import {
  generateEmptyWeek,
  buildGridFromEntries,
  mergeSchedule
} from "../utils/scheduleGrid";

import { getAllActivities } from "../api/activityApi"; 

export default function SchedulePage() {
  const [roomId, setRoomId] = useState("room1"); // TODO: dynamic later
  const [weekStart, setWeekStart] = useState("2026-04-20"); // TODO: dynamic later
  const [grid, setGrid] = useState({});
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);

  // Load activities + week on mount
  useEffect(() => {
    async function init() {
      setLoading(true);

      const [activityList, weekEntries] = await Promise.all([
        getAllActivities(),
        getWeek(roomId, weekStart)
      ]);

      setActivities(activityList);
      setGrid(buildGridFromEntries(weekEntries, weekStart));
      setLoading(false);
    }

    init();
  }, [roomId, weekStart]);

  // Handle activity selection
  function updateBlock(date, block, activityId) {
    setGrid(prev => ({
      ...prev,
      [date]: {
        ...prev[date],
        [block]: { activityId }
      }
    }));
  }

  // Apply suggestions
  async function applySuggestions() {
    const suggested = await getSuggestions(roomId, weekStart);
    const suggestedGrid = buildGridFromEntries(suggested.entries, weekStart);
    setGrid(prev => mergeSchedule(prev, suggestedGrid));
  }

  // Save week
  async function save() {
    const entries = [];

    for (const date in grid) {
      for (const block in grid[date]) {
        const activityId = grid[date][block].activityId;
        if (activityId) {
          entries.push({ date, timeBlock: block, activityId });
        }
      }
    }

    await saveWeek(roomId, weekStart, entries);
    alert("Schedule saved");
  }

  if (loading) return <div>Loading schedule…</div>;

  return (
    <div style={{ padding: "20px" }}>
      <h1>Weekly Schedule</h1>

      <div style={{ marginBottom: "20px" }}>
        <button onClick={applySuggestions}>Apply Suggestions</button>
        <button onClick={save} style={{ marginLeft: "10px" }}>
          Save Week
        </button>
      </div>

      <div style={{ display: "flex", gap: "20px" }}>
        {Object.keys(grid).map(date => (
          <div key={date} style={{ border: "1px solid #ccc", padding: "10px" }}>
            <h3>{date}</h3>

            {["morning", "midday", "afternoon"].map(block => (
              <div key={block} style={{ marginBottom: "10px" }}>
                <strong>{block}</strong>
                <select
                  value={grid[date][block].activityId || ""}
                  onChange={e => updateBlock(date, block, e.target.value)}
                >
                  <option value="">-- Select Activity --</option>
                  {activities.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

