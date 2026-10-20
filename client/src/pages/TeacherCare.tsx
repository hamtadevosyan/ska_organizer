import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { ClipboardCheck, HeartPulse, RefreshCw, Users } from 'lucide-react';
import { API_BASE_URL } from '../lib/api';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { attendanceTime, newAttendanceRequestId } from '../api/attendance';
import type { ClassroomChildren, ClassroomScope } from '../api/classroom';
import ChildSafetyCard from '../components/children/ChildSafetyCard';
import './classroom.css';

type Child = ClassroomChildren['items'][number];
type Visit = { id: string; checkIn: string | null; checkOut: string | null; version: number; voided: boolean; needsReview: boolean };
type Row = { child: Child; records: Visit[]; needsAdminReview: boolean; canCheckIn: boolean; canCheckOut: boolean };
type Roster = ClassroomScope & { today: string; timeZone: string; rows: Row[] };
const base = API_BASE_URL + '/api/classroom';
export default function TeacherCare({ section }: { section: 'children' | 'attendance' }) {
  const { account, serverUnavailable } = useAuth();
  const [revision, setRevision] = useState(0);
  const scope = JSON.stringify([account?.id, account?.role, account?.roomId, account?.staffMemberId]);
  const key = JSON.stringify([scope, section, revision, serverUnavailable]);
  const [loaded, setLoaded] = useState<{ key: string; roster: Roster } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [message, setMessage] = useState('');
  const requests = useRef(new Map<string, string>());
  const liveScope = useRef(scope); liveScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { requests.current.clear(); setSelected(''); setActionError(''); setMessage(''); }, [scope, section]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoaded(null); setFailure(null);
    if (account?.role !== 'teacher' || serverUnavailable) return () => controller.abort();
    void (async () => {
      const roster = (await axios.get<{ data: Roster }>(base + '/attendance', { signal: controller.signal })).data.data;
      if (roster.state === 'assigned' && (!account.roomId || roster.room?.id !== account.roomId)) throw new Error('Your class assignment changed. Reload your session.');
      if (active) setLoaded({ key, roster });
    })().catch(error => { if (active && !axios.isCancel(error)) setFailure({ key, message: authError(error, 'Could not load your class. Try again.') }); });
    return () => { active = false; controller.abort(); };
  }, [key, account?.role, account?.roomId, section, serverUnavailable]);
  useEffect(() => {
    const refresh = () => { if (!busy && document.visibilityState === 'visible') setRevision(value => value + 1); };
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [busy]);
  const current = loaded?.key === key ? loaded.roster : null;
  const error = failure?.key === key ? failure.message : '';
  const chosen = current?.state === 'assigned' ? current.rows.find(row => row.child.id === selected)?.child : null;
  async function record(row: Row, visit?: Visit) {
    if (!current || busy || account?.role !== 'teacher') return;
    const operationScope = scope;
    const requestKey = current.today + ':' + row.child.id;
    setBusy(row.child.id); setActionError(''); setMessage('');
    let replayedClosedVisit = false;
    try {
      if (visit) {
        await axios.post(base + '/attendance/' + encodeURIComponent(visit.id) + '/checkout', { date: current.today, version: visit.version });
        requests.current.delete(requestKey);
      }
      else {
        if (!requests.current.has(requestKey)) requests.current.set(requestKey, newAttendanceRequestId());
        const response = await axios.post<{ data: { record: Visit } }>(base + '/children/' + encodeURIComponent(row.child.id) + '/checkin', { date: current.today, requestId: requests.current.get(requestKey) });
        replayedClosedVisit = !!response.data.data?.record.checkOut;
        requests.current.delete(requestKey);
      }
      if (mounted.current && liveScope.current === operationScope) { setMessage(replayedClosedVisit ? 'The previous arrival was already recorded and that visit is closed. Review attendance before recording another arrival.' : (visit ? 'Departure' : 'Arrival') + ' recorded for ' + row.child.firstName + '.'); setRevision(value => value + 1); }
    } catch (failure) { if (mounted.current && liveScope.current === operationScope && !axios.isCancel(failure)) setActionError(authError(failure, 'Could not confirm attendance. Refresh to check the result, or retry the same action.')); }
    finally { if (mounted.current && liveScope.current === operationScope) setBusy(''); }
  }
  if (account?.role !== 'teacher') return <p role="alert">Teacher access is required.</p>;
  return <div className="ska-classroom ska-core-page">
    <header className="ska-classroom-hero"><div className="ska-classroom-icon">{section === 'attendance' ? <ClipboardCheck aria-hidden="true" /> : <Users aria-hidden="true" />}</div><div><p className="ska-classroom-eyebrow">Teacher · attendance & child safety</p><h1>{section === 'attendance' ? 'Class attendance' : 'Children in my class'}</h1><p>{current?.room?.name || 'Your assigned class'}</p></div><button disabled={!!busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={18} aria-hidden="true" />Refresh class</button></header>
    {serverUnavailable ? <p role="alert" className="ska-classroom-card">The connection is interrupted. Current attendance and safety information are unavailable. Use the facility emergency backup.</p>
      : error ? <p role="alert" className="ska-classroom-card">{error}</p> : !current ? <p role="status">Loading your class…</p>
        : current.state !== 'assigned' ? <section className="ska-classroom-card"><h2>{current.state === 'unassigned' ? 'No class assigned yet' : 'Class currently unavailable'}</h2><p>Ask an administrator to assign an active class.</p></section> : <>
          <section className="ska-classroom-card"><p><strong>{current.today}</strong> · {current.timeZone}</p><p>Record the child’s actual arrival or departure. The authorized adult’s required sign-in or sign-out signature is handled separately.</p><p>Attendance corrections and earlier open visits need an administrator or editor.</p></section>
          {actionError && <p role="alert">{actionError}</p>}{message && <p role="status">{message}</p>}
          {chosen && <section className="ska-classroom-card"><button onClick={() => setSelected('')}>Close safety card</button><ChildSafetyCard key={scope + ':' + chosen.id} childId={chosen.id} name={chosen.firstName + ' ' + chosen.lastName} /></section>}
          {!current.rows.length && <p className="ska-classroom-card">No active children are assigned to your class.</p>}
          <div className="ska-classroom-menu">{current.rows.map(row => {
            const open = row.records.find(visit => !visit.checkOut && !visit.voided);
            return <article key={row.child.id} className="ska-classroom-card" aria-label={row.child.firstName + ' ' + row.child.lastName}>
              <h2>{row.child.firstName} {row.child.lastName}</h2>{row.child.preferredName && <p>Goes by {row.child.preferredName}</p>}
              <button onClick={() => setSelected(row.child.id)}><HeartPulse size={18} aria-hidden="true" />Health & emergency</button>
              <><p>{row.needsAdminReview ? 'Attendance needs administrator review.' : open ? 'Currently checked in' : 'Not currently checked in'}</p>
                {row.records.map(visit => <p key={visit.id}>Arrived: {attendanceTime(visit.checkIn, current.timeZone)}{visit.checkOut && <><br />Departed: {attendanceTime(visit.checkOut, current.timeZone)}</>}</p>)}
                <button disabled={!!busy || !row.canCheckIn} onClick={() => void record(row)}>Check in {row.child.firstName}</button>
                <button disabled={!!busy || !row.canCheckOut || !open} onClick={() => { if (open) void record(row, open); }}>Check out {row.child.firstName}</button>
              </>
            </article>;
          })}</div>
        </>}
  </div>;
}
