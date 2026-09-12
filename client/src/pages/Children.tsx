import { useEffect, useState } from 'react';
import axios from 'axios';
import { Plus, Users } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { childName, endEnrollment, listChildren } from '../api/children';
import type { ChildRecord, RosterFilters } from '../api/children';
import { useRooms } from '../components/rooms/useRooms';
import { ChildForm } from '../components/children/ChildForm';
import { ChildProfile } from '../components/children/ChildProfile';

const pageSize = 25;
export default function Children() {
  const { account } = useAuth();
  const canEdit = account?.role === 'admin' || account?.role === 'editor';
  const { rooms, loading: loadingRooms, error: roomError, refresh: refreshRooms } = useRooms();
  const [q, setQ] = useState('');
  const [roomId, setRoomId] = useState('');
  const [active, setActive] = useState<RosterFilters['active']>('true');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [children, setChildren] = useState<ChildRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ChildRecord | null>(null);
  const [profileId, setProfileId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const timer = window.setTimeout(() => {
      void listChildren({ q, roomId: roomId || undefined, active, page, pageSize }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (page > 1 && (page - 1) * pageSize >= result.total) { setPage(Math.max(1, Math.ceil(result.total / pageSize))); return; }
        setChildren(result.items); setTotal(result.total);
      }).catch((failure) => {
        if (!controller.signal.aborted && !axios.isCancel(failure)) { setChildren([]); setError(authError(failure, 'Could not load the roster.')); }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, roomId, active, page, revision]);
  function open(child: ChildRecord | null) {
    setEditing(child); setFormOpen(true); setProfileId(''); setMessage(''); setError('');
  }
  function saved(child: ChildRecord) {
    setFormOpen(false); setEditing(null); setProfileId('');
    setMessage(childName(child) + ' saved.'); setRevision((value) => value + 1);
    void refreshRooms();
  }
  async function end(child: ChildRecord) {
    if (!window.confirm('End enrollment for ' + childName(child) + '? Their profile, room reference and attendance history will remain.')) return;
    setBusyId(child.id); setError(''); setMessage('');
    try {
      await endEnrollment(child.id);
      setMessage('Enrollment ended for ' + childName(child) + '. History was preserved.');
      setProfileId(''); setRevision((value) => value + 1);
      await refreshRooms();
    } catch (failure) { if (!axios.isCancel(failure)) setError(authError(failure, 'Could not end enrollment.')); }
    finally { setBusyId(''); }
  }
  const roomName = (id: string | null) => {
    const room = rooms.find((item) => item.id === id);
    return room ? room.name + (room.active ? '' : ' (archived)') : id ? 'Room unavailable' : 'Unassigned';
  };
  return <div className="mx-auto max-w-6xl space-y-6 p-2 sm:p-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-3xl font-bold text-slate-900">Children</h1>
      <p className="mt-2 text-slate-600">Maintain the roster, enrollment details and room assignments.</p></div>
      <div className="flex gap-3"><button disabled={loading || !!busyId || formOpen} onClick={() => { setRevision((value) => value + 1); void refreshRooms(); }} className="rounded-lg border bg-white px-4 py-2 disabled:opacity-50">Refresh roster</button>
        {canEdit && !formOpen && <button disabled={!!busyId} onClick={() => open(null)} className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white"><Plus size={18} />Add child</button>}</div>
    </header>
    {(error || roomError) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error || roomError}</p>}
    {message && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    {canEdit && formOpen && <ChildForm key={editing?.id || 'new'} child={editing} rooms={rooms} loadingRooms={loadingRooms} onSaved={saved} onCancel={() => { setFormOpen(false); setEditing(null); }} />}
    {profileId && <ChildProfile key={profileId} id={profileId} rooms={rooms} onClose={() => setProfileId('')} />}
    <section className="rounded-2xl border bg-white p-5 shadow-sm" aria-label="Child roster">
      <div className="grid gap-4 md:grid-cols-3">
        <label>Search children<input type="search" maxLength={100} value={q} placeholder="Name or preferred name" onChange={(event) => { setQ(event.target.value); setPage(1); }} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label>Filter by room<select value={roomId} onChange={(event) => { setRoomId(event.target.value); setPage(1); }} className="mt-1 block w-full rounded-lg border p-2.5"><option value="">All rooms</option><option value="unassigned">Unassigned</option>
          {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}{room.active ? '' : ' (archived)'}</option>)}</select></label>
        <label>Enrollment<select value={active} onChange={(event) => { setActive(event.target.value as RosterFilters['active']); setPage(1); }} className="mt-1 block w-full rounded-lg border p-2.5">
          <option value="true">Active</option><option value="false">Inactive</option><option value="all">All enrollment</option></select></label>
      </div>
      {loading ? <p role="status" className="py-8">Loading roster…</p> : error ? <p className="py-8">Use Refresh roster to try again.</p> : !children.length ? <div className="py-10 text-center"><Users className="mx-auto mb-3 text-emerald-700" /><p>No children match these filters.</p></div> : <>
        <p className="my-4 text-sm text-slate-500">{total} {total === 1 ? 'child' : 'children'} · Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b bg-slate-50"><th className="p-3">Name</th><th className="p-3">Date of birth</th><th className="p-3">Room</th><th className="p-3">Enrollment</th><th className="p-3">Actions</th></tr></thead>
          <tbody>{children.map((child) => <tr key={child.id} className="border-b" aria-label={childName(child)}>
            <td className="p-3 font-semibold">{childName(child)}{child.preferredName && <span className="mt-1 block font-normal text-slate-500">Goes by {child.preferredName}</span>}</td>
            <td className="p-3">{child.dateOfBirth || 'Not recorded'}</td><td className="p-3">{roomName(child.roomId)}</td>
            <td className="p-3"><span className={'rounded-full px-2 py-1 text-xs ' + (child.active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{child.active ? 'Active' : 'Inactive'}</span></td>
            <td className="p-3"><div className="flex flex-wrap gap-3"><button disabled={formOpen || !!busyId} onClick={() => setProfileId(child.id)} aria-label={'View ' + childName(child)} className="text-emerald-800 disabled:opacity-50">View profile</button>
              {canEdit && <><button disabled={formOpen || !!busyId} onClick={() => open(child)} aria-label={'Edit ' + childName(child)} className="text-emerald-800 disabled:opacity-50">Edit</button>
                {child.active && <button disabled={formOpen || !!busyId} onClick={() => void end(child)} aria-label={'End enrollment for ' + childName(child)} className="text-slate-600 disabled:opacity-50">{busyId === child.id ? 'Saving…' : 'End enrollment'}</button>}</>}
            </div></td>
          </tr>)}</tbody></table></div>
        <div className="mt-4 flex justify-between"><button disabled={page === 1} onClick={() => setPage(page - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-50">Previous</button>
          <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-50">Next</button></div>
      </>}
    </section>
  </div>;
}
