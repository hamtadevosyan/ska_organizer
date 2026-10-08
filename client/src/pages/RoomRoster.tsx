import { useEffect, useState } from 'react';
import axios from 'axios';
import { ArrowLeft, Building2, Users } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { childName, listChildren } from '../api/children';
import type { ChildRecord } from '../api/children';
import { getRoom } from '../api/rooms';
import type { Room } from '../api/rooms';
import { authError } from '../auth/transport';
import { ChildProfile } from '../components/children/ChildProfile';
import { useRooms } from '../components/rooms/useRooms';
import type { DocumentWork } from '../api/childDocuments';

const pageSize = 25;
type Snapshot = { room: Room; children: ChildRecord[]; total: number };
type Result = { key: string; status: 'loading' | 'loaded' | 'error'; data?: Snapshot; error?: string };

function RoomChildProfile({ id, room, onClose, onWorkChange }: { id: string; room: Room; onClose: () => void; onWorkChange: (work: DocumentWork) => void }) {
  const { rooms, error } = useRooms();
  return <>
    <ChildProfile id={id} rooms={rooms.length ? rooms : [room]} closeLabel="Back to room roster" onClose={onClose} onWorkChange={onWorkChange} />
    {error && <p role="status" className="text-sm text-slate-600">Historical room names could not be loaded. Reopen the profile to try again.</p>}
  </>;
}

// A new room gets a new component immediately, before its network request completes.
export default function RoomRoster() {
  const { roomId = '' } = useParams();
  return <SelectedRoomRoster key={roomId} roomId={roomId} />;
}

function SelectedRoomRoster({ roomId }: { roomId: string }) {
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [profileId, setProfileId] = useState('');
  const [documentWork, setDocumentWork] = useState<DocumentWork>({ dirty: false, busy: false });
  const [result, setResult] = useState<Result>({ key: '', status: 'loading' });
  const requestKey = JSON.stringify([q, includeInactive, page, revision]);
  const loaded = result.key === requestKey && result.status === 'loaded';
  const error = result.key === requestKey && result.status === 'error' ? result.error : '';
  const loading = !loaded && !error;
  const data = loaded ? result.data : undefined;

  useEffect(() => {
    const controller = new AbortController();
    setResult(previous => ({ key: requestKey, status: 'loading', data: previous.data }));
    const timer = window.setTimeout(() => {
      void Promise.all([
        getRoom(roomId, controller.signal),
        listChildren({ q, roomId, active: includeInactive ? 'all' : 'true', page, pageSize }, controller.signal),
      ]).then(([room, roster]) => {
        if (controller.signal.aborted) return;
        if (page > 1 && (page - 1) * pageSize >= roster.total) {
          setPage(Math.max(1, Math.ceil(roster.total / pageSize))); return;
        }
        setResult({ key: requestKey, status: 'loaded', data: { room, children: roster.items, total: roster.total } });
      }).catch(failure => {
        if (!controller.signal.aborted && !axios.isCancel(failure)) {
          setResult(previous => ({ key: requestKey, status: 'error', data: previous.data, error: authError(failure, 'Could not load this room roster.') }));
        }
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [roomId, q, includeInactive, page, requestKey]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setRevision(value => value + 1); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  return <div className="ska-page ska-core-page space-y-6">
    <Link to="/rooms" className="ska-button"><ArrowLeft size={18} aria-hidden="true" />Back to rooms</Link>
    <header className="ska-page-head">
      <div className="min-w-0"><h1 className="break-words"><span className="ska-heading-icon is-coral"><Building2 size={24} aria-hidden="true" /></span>{result.data?.room.name || 'Room roster'}</h1>
        <p>See who is assigned to this room and open a child’s profile.</p></div>
      <button disabled={loading || documentWork.busy} onClick={() => { setRevision(value => value + 1); }} className="ska-button">Refresh roster</button>
    </header>
    {loading && <p role="status" className="rounded-2xl border bg-white p-6">Loading room roster…</p>}
    {error && <div className="rounded-2xl border bg-white p-6"><p role="alert" className="text-red-800">{error}</p>
      <button onClick={() => setRevision(value => value + 1)} className="ska-button mt-4">Try again</button></div>}
    {data && <>
      <section aria-label="Room enrollment" className="flex flex-wrap items-center gap-4 rounded-2xl border bg-white p-5 shadow-sm">
        <p className="text-lg font-bold">{data.room.assignedChildCount} active {data.room.assignedChildCount === 1 ? 'child' : 'children'}</p>
        <p>Capacity {data.room.capacity ?? 'not configured'}</p>
        <span className={'rounded-full px-3 py-1 text-sm ' + (data.room.active ? 'bg-blue-50 text-blue-800' : 'bg-slate-100 text-slate-600')}>{data.room.active ? 'Active room' : 'Archived room'}</span>
        <p className="w-full text-sm text-slate-500">Inactive enrollment is excluded from this count. Search does not change room occupancy.</p>
        {data.room.overCapacity && <p role="status" className="w-full text-amber-800">Active enrollment exceeds the configured capacity.</p>}
      </section>
    </>}
    {profileId && result.data && <RoomChildProfile key={profileId} id={profileId} room={result.data.room} onWorkChange={setDocumentWork} onClose={() => { setProfileId(''); setDocumentWork({ dirty: false, busy: false }); setRevision(value => value + 1); }} />}
    {!profileId && <section aria-label="Room roster" className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">Search children<input type="search" value={q} maxLength={100} placeholder="Name or preferred name"
          onChange={event => { setQ(event.target.value); setPage(1); }} className="mt-1 block w-full rounded-lg border p-2.5" /></label>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={includeInactive} onChange={event => { setIncludeInactive(event.target.checked); setPage(1); }} className="h-5 w-5" />Include inactive children</label>
      </div>
      {data && (!data.children.length ? <div className="py-10 text-center"><Users className="mx-auto mb-3 text-blue-600" aria-hidden="true" />
        <p>{q.trim() ? 'No children match this search.' : includeInactive ? 'No children are assigned to this room.' : 'No actively enrolled children are assigned to this room.'}</p></div> : <>
        <p className="my-4 text-sm text-slate-500">{data.total} {data.total === 1 ? 'child' : 'children'} shown by these filters · Page {page} of {Math.max(1, Math.ceil(data.total / pageSize))}</p>
        <div className="overflow-x-auto"><table role="table" aria-label="Room roster records" className="ska-record-table w-full text-left text-sm">
          <thead role="rowgroup"><tr role="row" className="border-b bg-slate-50"><th role="columnheader" scope="col" className="p-3">Name</th><th role="columnheader" scope="col" className="p-3">Date of birth</th><th role="columnheader" scope="col" className="p-3">Enrollment</th><th role="columnheader" scope="col" className="p-3">Profile</th></tr></thead>
          <tbody role="rowgroup">{data.children.map(child => <tr role="row" key={child.id} aria-label={childName(child)} className="border-b">
            <td role="cell" data-primary className="p-3 font-semibold">{childName(child)}{child.preferredName && <span className="mt-1 block font-normal text-slate-500">Goes by {child.preferredName}</span>}</td>
            <td role="cell" data-label="Date of birth" className="p-3">{child.dateOfBirth || 'Not recorded'}</td>
            <td role="cell" data-label="Enrollment" className="p-3"><span className={'rounded-full px-2 py-1 text-xs ' + (child.active ? 'bg-blue-50 text-blue-800' : 'bg-slate-100 text-slate-600')}>{child.active ? 'Active' : 'Inactive'}</span></td>
            <td role="cell" className="ska-record-actions p-3"><div className="ska-table-actions"><button aria-label={'View ' + childName(child)} onClick={() => setProfileId(child.id)} className="ska-button">View profile</button></div></td>
          </tr>)}</tbody>
        </table></div>
        <div className="mt-4 flex flex-wrap justify-between gap-3"><button disabled={page === 1} onClick={() => setPage(value => value - 1)} className="ska-button">Previous</button>
          <button disabled={page * pageSize >= data.total} onClick={() => setPage(value => value + 1)} className="ska-button">Next</button></div>
      </>)}
    </section>}
  </div>;
}
