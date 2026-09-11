import { useEffect, useState } from "react";
import axios from "axios";
import { getWeek, getSuggestions, saveWeek } from "../api/scheduleApi";
import { buildGridFromEntries, mergeSchedule } from "../utils/scheduleGrid";
import { getAllActivities } from "../api/activityApi";
import { RoomSelect } from "../components/rooms/RoomSelect";
import { useRooms } from "../components/rooms/useRooms";
import { currentMonday } from "../lib/dates";
import { useAuth } from "../auth/context";
import { authError } from "../auth/transport";

export default function SchedulePage() {
  const { account } = useAuth();
  const { rooms, loading: loadingRooms, error: roomError, refresh } = useRooms();
  const [roomId, setRoomId] = useState("");
  const [weekStart, setWeekStart] = useState(currentMonday);
  const [grid, setGrid] = useState({});
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const room = rooms.find((item) => item.id === roomId);
  const canWrite = account?.role !== "viewer" && room?.active;
  useEffect(() => {
    let active = true;
    setGrid({}); setActivities([]); setError(""); setMessage(""); setDirty(false); setLoading(false);
    if (!roomId || !weekStart) return;
    setLoading(true);
    void Promise.all([getAllActivities(), getWeek(roomId, weekStart)]).then(([allActivities, entries]) => {
      if (!active) return;
      setActivities(allActivities.filter((activity) => !activity.roomId || activity.roomId === roomId));
      setGrid(buildGridFromEntries(entries, weekStart));
    }).catch((failure) => {
      if (active && !axios.isCancel(failure)) setError(authError(failure, "Could not load the schedule."));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [roomId, weekStart]);
  function changeSelection(update) {
    if (dirty && !window.confirm("Discard unsaved schedule changes?")) return;
    update();
  }
  function updateBlock(date, block, activityId) {
    setDirty(true); setMessage("");
    setGrid((previous) => ({ ...previous, [date]: { ...previous[date], [block]: { activityId } } }));
  }
  async function applySuggestions() {
    setBusy(true); setError(""); setMessage("");
    try {
      const suggested = await getSuggestions(roomId, weekStart);
      setGrid((previous) => mergeSchedule(previous, buildGridFromEntries(suggested.entries, weekStart)));
      setDirty(true);
      setMessage(suggested.entries.length ? "Suggestions added to empty blocks. Save the week to keep them." : "No activities available for this room.");
    } catch (failure) { if (!axios.isCancel(failure)) setError(authError(failure, "Could not load suggestions.")); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(""); setMessage("");
    const entries = [];
    for (const date of Object.keys(grid)) for (const timeBlock of Object.keys(grid[date])) {
      const activityId = grid[date][timeBlock].activityId;
      if (activityId) entries.push({ date, timeBlock, activityId });
    }
    try {
      await saveWeek(roomId, weekStart, entries);
      setDirty(false); setMessage("Schedule saved.");
    } catch (failure) { if (!axios.isCancel(failure)) setError(authError(failure, "Could not save the schedule.")); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-7xl space-y-5 p-6">
    <h1 className="text-3xl font-bold">Weekly Schedule</h1>
    <div className="flex flex-wrap items-end gap-4">
      <label>Room<RoomSelect rooms={rooms} value={roomId} allowArchived disabled={busy || loadingRooms}
        onChange={(id) => changeSelection(() => setRoomId(id))} className="mt-1 block min-w-56 rounded-lg border bg-white p-2" /></label>
      <label>Week starting Monday<input type="date" value={weekStart} min="1970-01-05" step="7" disabled={busy}
        onChange={(event) => changeSelection(() => setWeekStart(event.target.value))} className="mt-1 block rounded-lg border p-2" /></label>
      <button disabled={busy || loadingRooms} onClick={() => void refresh()} className="rounded-lg border bg-white px-4 py-2">Refresh rooms</button>
    </div>
    {(error || roomError) && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{error || roomError}</p>}
    {message && <p role="status" className="rounded bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {!loadingRooms && !roomId && <p>{rooms.length ? "Choose a room to view its schedule." : "No rooms available. Add a room in Rooms & Classes."}</p>}
    {room && !room.active && <p className="rounded bg-slate-200 p-3">Archived room: saved schedules can be viewed. Choose an active room to make changes.</p>}
    {loading && <p>Loading schedule…</p>}
    {roomId && !loading && Object.keys(grid).length > 0 && <>
      <div className="flex gap-3">
        <button disabled={!canWrite || busy} onClick={() => void applySuggestions()} className="rounded-lg border bg-white px-4 py-2 disabled:opacity-50">Apply Suggestions</button>
        <button disabled={!canWrite || busy} onClick={() => void save()} className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50">Save Week</button>
      </div>
      <fieldset disabled={!canWrite || busy}><legend className="sr-only">Weekly activity selections</legend>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Object.keys(grid).map((date) => <section key={date} className="rounded-xl border bg-white p-4"><h2 className="mb-3 font-semibold">{date}</h2>
            {["morning", "midday", "afternoon"].map((block) => {
              const selected = grid[date][block].activityId;
              return <label key={block} className="mb-4 block capitalize">{block}<select aria-label={date + " " + block} value={selected || ""}
                onChange={(event) => updateBlock(date, block, event.target.value)} className="mt-1 block w-full rounded border p-2">
                <option value="">Choose an activity</option>
                {selected && !activities.some((activity) => activity.id === selected) && <option value={selected} disabled>Unavailable activity</option>}
                {activities.map((activity) => <option key={activity.id} value={activity.id}>{activity.name}</option>)}
              </select></label>;
            })}
          </section>)}
        </div>
      </fieldset>
    </>}
  </div>;
}
