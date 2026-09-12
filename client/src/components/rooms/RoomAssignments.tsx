import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../../lib/api';
import { authError } from '../../auth/transport';
import { assignChild, roomsUrl } from '../../api/rooms';
import type { AssignmentPreview, ChildOption, Room } from '../../api/rooms';
import { RoomSelect } from './RoomSelect';

export function RoomAssignments({ rooms, onChanged }: { rooms: Room[]; onChanged: () => Promise<void> }) {
  const [children, setChildren] = useState<ChildOption[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [revision, setRevision] = useState(0);
  const [childId, setChildId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [preview, setPreview] = useState<AssignmentPreview | null>(null);
  const [confirmCapacity, setConfirmCapacity] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoadingChildren(true);
    const timer = window.setTimeout(() => {
      void axios.get<{ items: ChildOption[]; total: number }>(API_BASE_URL + '/api/children', {
        params: { q, page, pageSize: 50, active: 'true' }, signal: controller.signal,
      }).then((response) => {
        if (!controller.signal.aborted) { setChildren(response.data.items); setTotal(response.data.total); }
      }).catch((failure) => {
        if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load children.'));
      }).finally(() => { if (!controller.signal.aborted) setLoadingChildren(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, page, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setConfirmCapacity(false); setLoadingPreview(false);
    if (!roomId || !childId) return;
    setLoadingPreview(true);
    void axios.get<{ data: AssignmentPreview }>(roomsUrl + '/' + encodeURIComponent(roomId) + '/assignment-preview', {
      params: { childId }, signal: controller.signal,
    }).then((response) => { if (!controller.signal.aborted) setPreview(response.data.data); })
      .catch((failure) => { if (!controller.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not preview this assignment.')); })
      .finally(() => { if (!controller.signal.aborted) setLoadingPreview(false); });
    return () => controller.abort();
  }, [roomId, childId, revision]);
  const child = children.find((item) => item.id === childId);
  const selectedRoom = rooms.find((item) => item.id === roomId);
  const currentRoom = rooms.find((item) => item.id === child?.roomId);
  async function assign(targetId: string | null) {
    if (!childId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await assignChild(childId, targetId, confirmCapacity);
      setMessage(targetId ? 'Room assignment saved.' : 'Room assignment removed.');
      setChildId(''); setPreview(null); setConfirmCapacity(false); setRevision((value) => value + 1);
      await onChanged();
    } catch (failure) {
      if (!axios.isCancel(failure)) {
        setError(authError(failure, 'Could not save the room assignment.'));
        setConfirmCapacity(false); setRevision((value) => value + 1);
        await onChanged();
      }
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview || !selectedRoom?.active || (preview.exceedsCapacity && !confirmCapacity)) return;
    void assign(roomId);
  }
  return <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 className="text-xl font-bold">Assign an existing child</h2>
    <p className="mt-1 text-sm text-slate-600">Choose an actively enrolled child and check the proposed room count before saving.</p>
    {error && <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-red-800">{error}</p>}
    {message && <p role="status" className="mt-3 rounded bg-emerald-50 p-3 text-emerald-800">{message}</p>}
    <form onSubmit={submit}><fieldset disabled={busy} className="mt-4 space-y-4">
      <label className="block">Search children<input type="search" maxLength={100} value={q} onChange={(event) => {
        setQ(event.target.value); setPage(1); setChildId(''); setError(''); setMessage('');
      }} className="mt-1 block w-full rounded-lg border p-2" /></label>
      <label className="block">Child<select required disabled={loadingChildren} value={childId} onChange={(event) => {
        setChildId(event.target.value); setError(''); setMessage('');
      }} className="mt-1 block w-full rounded-lg border p-2"><option value="">Choose a child</option>
        {children.map((item) => <option key={item.id} value={item.id}>{item.firstName} {item.lastName}</option>)}
      </select></label>
      {loadingChildren ? <p>Loading children…</p> : !children.length && <p>No children available to assign{q ? ' for this search' : ''}.</p>}
      {total > 50 && <div className="flex gap-4 text-sm">
        <button type="button" disabled={page === 1 || loadingChildren} onClick={() => { setPage(page - 1); setChildId(''); }}>Previous children</button>
        <span>Page {page}</span>
        <button type="button" disabled={page * 50 >= total || loadingChildren} onClick={() => { setPage(page + 1); setChildId(''); }}>Next children</button>
      </div>}
      {child && <p className="text-sm text-slate-600">Current room: {currentRoom ? currentRoom.name + (currentRoom.active ? '' : ' (archived)') : child.roomId ? 'Room unavailable' : 'Unassigned'}</p>}
      <label className="block">Room for assignment<RoomSelect required rooms={rooms} value={roomId} onChange={(id) => {
        setRoomId(id); setError(''); setMessage('');
      }} className="mt-1 block w-full rounded-lg border p-2" /></label>
      {loadingPreview && <p>Checking room capacity…</p>}
      {preview && <p>Proposed count: <strong>{preview.proposedChildCount}</strong> / {preview.room.capacity ?? 'Not configured'}</p>}
      {preview?.alreadyAssigned && <p>This child is already assigned to this room.</p>}
      {preview?.exceedsCapacity && !preview.alreadyAssigned && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
        <p role="alert">This assignment exceeds the configured room capacity.</p>
        <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={confirmCapacity} onChange={(event) => setConfirmCapacity(event.target.checked)} className="mt-1" />I acknowledge the capacity warning and want to assign this child.</label>
      </div>}
      <div className="flex flex-wrap gap-3">
        <button disabled={!preview || loadingChildren || loadingPreview || !selectedRoom?.active || preview.alreadyAssigned || (preview.exceedsCapacity && !confirmCapacity)}
          className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Assign child</button>
        {child?.roomId && <button type="button" onClick={() => { if (window.confirm('Remove this child’s current room assignment?')) void assign(null); }} className="rounded-lg border px-4 py-2">Remove room assignment</button>}
      </div>
    </fieldset></form>
  </section>;
}
