import { useEffect, useState } from 'react';
import axios from 'axios';
import { childName, getChildProfile } from '../../api/children';
import type { ChildProfile as Profile } from '../../api/children';
import type { Room } from '../../api/rooms';
import { authError } from '../../auth/transport';

export function ChildProfile({ id, rooms, onClose }: { id: string; rooms: Room[]; onClose: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null); setError('');
    void getChildProfile(id, controller.signal).then((value) => { if (!controller.signal.aborted) setProfile(value); })
      .catch((failure) => { if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load this profile.')); });
    return () => controller.abort();
  }, [id]);
  return <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm" aria-label="Child profile">
    <div className="flex items-start justify-between gap-4"><h2 className="text-xl font-bold">{profile ? childName(profile.child) : 'Child profile'}</h2>
      <button onClick={onClose} className="rounded-lg border px-3 py-1">Close profile</button></div>
    {error && <p role="alert" className="text-red-800">{error}</p>}
    {!profile && !error && <p role="status">Loading profile…</p>}
    {profile && <>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-slate-500">Date of birth</dt><dd>{profile.child.dateOfBirth || 'Not recorded'}</dd></div>
        <div><dt className="text-slate-500">Preferred name</dt><dd>{profile.child.preferredName || 'None'}</dd></div>
        <div><dt className="text-slate-500">Enrollment</dt><dd>{profile.child.active ? 'Active' : 'Inactive'}</dd></div>
        <div><dt className="text-slate-500">Room</dt><dd>{profile.room ? profile.room.name + (profile.room.active ? '' : ' (archived)') : 'Unassigned'}</dd></div>
      </dl>
      <div><h3 className="font-semibold">Operational notes</h3><p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{profile.child.notes || 'No notes recorded.'}</p></div>
      <div><h3 className="font-semibold">Recent attendance</h3><p className="mt-1 text-sm text-slate-500">The 10 most recent records, including attendance before room or enrollment changes.</p>
        {!profile.recentAttendance.length ? <p className="mt-3 text-sm">No attendance recorded.</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr className="border-b"><th className="py-2 pr-3">Room</th><th className="py-2 pr-3">Check-in</th><th className="py-2">Check-out</th></tr></thead>
          <tbody>{profile.recentAttendance.map((record) => <tr key={record.id} className="border-b">
            <td className="py-2 pr-3">{rooms.find((room) => room.id === record.roomId)?.name || 'Historical room'}</td>
            <td className="py-2 pr-3">{new Date(record.checkIn).toLocaleString()}</td><td className="py-2">{record.checkOut ? new Date(record.checkOut).toLocaleString() : 'Not checked out'}</td>
          </tr>)}</tbody></table></div>}
      </div>
    </>}
  </section>;
}
