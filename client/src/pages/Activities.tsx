import { useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { authError } from '../auth/transport';
import { currentMonday } from '../lib/dates';
import { RoomSelect } from '../components/rooms/RoomSelect';
import { useRooms } from '../components/rooms/useRooms';

interface ActivityPlanItem { day: string; activity: string }
export default function Activities() {
  const { rooms, loading: loadingRooms, error: roomError, refresh } = useRooms();
  const [roomId, setRoomId] = useState('');
  const [weekStart, setWeekStart] = useState(currentMonday);
  const [activityPlan, setActivityPlan] = useState<ActivityPlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setActivityPlan([]); setError(''); setLoading(false);
    if (!roomId || !weekStart) return;
    setLoading(true);
    void axios.get<{ data: ActivityPlanItem[] }>(API_BASE_URL + '/api/activity/generate', {
      params: { roomId, weekStart }, signal: controller.signal,
    }).then((response) => { if (!controller.signal.aborted) setActivityPlan(response.data.data); })
      .catch((failure) => { if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load the activity plan.')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [roomId, weekStart]);
  return <div className="mx-auto max-w-6xl space-y-5 p-6">
    <h1 className="text-3xl font-bold">Weekly Activity Plan</h1>
    <div className="flex flex-wrap items-end gap-4">
      <label>Room<RoomSelect rooms={rooms} value={roomId} onChange={setRoomId} allowArchived disabled={loadingRooms} className="mt-1 block min-w-56 rounded-lg border bg-white p-2" /></label>
      <label>Week starting Monday<input type="date" value={weekStart} min="1970-01-05" step="7" onChange={(event) => setWeekStart(event.target.value)} className="mt-1 block rounded-lg border p-2" /></label>
      <button onClick={() => void refresh()} disabled={loadingRooms} className="rounded-lg border bg-white px-4 py-2">Refresh rooms</button>
    </div>
    {(roomError || error) && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{roomError || error}</p>}
    {loadingRooms && <p>Loading rooms…</p>}
    {!loadingRooms && !roomId && <p>{rooms.length ? 'Choose a room to view its activity plan.' : 'No rooms available. Add a room in Rooms & Classes.'}</p>}
    {loading ? <p>Loading activity plan…</p> : roomId && !error && (activityPlan.length ?
      <ul className="space-y-3">{activityPlan.map((item, index) => <li key={index} className="rounded-xl border bg-white p-4">
        <p className="font-semibold">{item.day}</p><p className="text-slate-600">{item.activity}</p>
      </li>)}</ul> : <p>No activities available for this room and week.</p>)}
  </div>;
}
