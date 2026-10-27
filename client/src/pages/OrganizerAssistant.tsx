import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { authError, onSessionExpired, onWorkAccessRequired } from '../auth/transport';
import { assistantOptions, assistantSummary } from '../api/organizerAssistant';
import type { AssistantOptions, AssistantSummary, SummaryTask } from '../api/organizerAssistant';
const labels: Record<SummaryTask, string> = { room: 'Room overview', attendance: 'Attendance today', week: 'Saved activity week', inventory: 'Inventory counts' };
export default function OrganizerAssistant() {
  const { account, serverUnavailable } = useAuth();
  const [options, setOptions] = useState<AssistantOptions | null>(null);
  const [task, setTask] = useState<SummaryTask>('room');
  const [roomId, setRoomId] = useState('');
  const [week, setWeek] = useState('');
  const [result, setResult] = useState<AssistantSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const identity = JSON.stringify([account?.id, account?.role, account?.roomId, account?.staffMemberId, account?.mustChangePassword, account?.workAccess?.checkedIn, serverUnavailable]);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    sequence.current++; request.current?.abort(); setResult(null); setOptions(null); setBusy(false); setError('');
    if (!account || serverUnavailable) return () => controller.abort();
    void assistantOptions(controller.signal).then(value => {
      if (!current) return;
      setLoadedKey(identity); setOptions(value); setRoomId(value.rooms[0]?.id || ''); setWeek(value.weekStart); setTask(value.tasks[0] || 'room');
    }).catch(failure => { if (current && !controller.signal.aborted) setError(authError(failure, 'Could not check the AI connection.')); });
    return () => { current = false; controller.abort(); request.current?.abort(); };
  // identity includes every permission-bearing value used on this page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, refresh]);
  useEffect(() => {
    const clear = () => { sequence.current++; request.current?.abort(); setResult(null); setOptions(null); setBusy(false); setError('Your access changed. Sign in or verify your work status to continue.'); };
    const expired = onSessionExpired(clear), denied = onWorkAccessRequired(clear);
    return () => { expired(); denied(); };
  }, []);
  function cancel() { sequence.current++; request.current?.abort(); setBusy(false); }
  function changed() { cancel(); setResult(null); setError(''); }
  async function summarize() {
    if (!options) return;
    cancel(); const turn = ++sequence.current; const controller = new AbortController(); request.current = controller;
    setBusy(true); setResult(null); setError('');
    try {
      const answer = await assistantSummary({ task, ...(task !== 'inventory' ? { roomId } : {}), ...(task === 'week' ? { weekStart: week } : {}) }, controller.signal);
      if (sequence.current === turn && !controller.signal.aborted) setResult(answer);
    } catch (failure) { if (sequence.current === turn && !controller.signal.aborted) setError(authError(failure, 'The AI is unavailable. Organizer is still available.')); }
    finally { if (sequence.current === turn) setBusy(false); }
  }
  return <section aria-label="Local AI assistant" className="mx-auto w-full min-w-0 max-w-3xl space-y-5 p-4 sm:p-6">
    <header><div className="flex items-center gap-2 text-blue-700"><Sparkles aria-hidden="true" /><h1 className="text-2xl font-bold">Local AI assistant</h1></div>
      <p className="mt-2 text-slate-600">Summarize the records you can access. Summaries are not saved; your records stay unchanged.</p></header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{error}</p>}
    {!options && !error && <p role="status">Checking your AI connection…</p>}
    {options && loadedKey === identity && <>
      <p role="status" className="rounded-xl bg-blue-50 p-4 text-blue-900">{options.status.message}</p>
      <section aria-label="Choose a summary" className="grid min-w-0 gap-4 rounded-2xl border border-blue-100 bg-white p-4 shadow-sm">
        <label className="grid gap-1 font-medium">Summary<select aria-label="Summary" className="min-h-12 w-full min-w-0 rounded-lg border p-2" value={task} onChange={event => { changed(); setTask(event.target.value as SummaryTask); }}>
          {options.tasks.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
        {task !== 'inventory' && <label className="grid gap-1 font-medium">Room<select aria-label="Room" className="min-h-12 w-full min-w-0 rounded-lg border p-2" value={roomId} onChange={event => { changed(); setRoomId(event.target.value); }}>
          {!options.rooms.length && <option value="">No assigned room available</option>}
          {options.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>}
        {task === 'week' && <label className="grid gap-1 font-medium">Week starting Monday<input className="min-h-12 w-full min-w-0 rounded-lg border p-2" type="date" value={week} onChange={event => { changed(); setWeek(event.target.value); }} /></label>}
        <p className="text-sm text-slate-600">Only room settings, counts and schedule times are used. Names, health information and payroll records are excluded.</p>
        <button type="button" className="min-h-12 rounded-xl bg-blue-700 px-4 py-3 font-semibold text-white disabled:opacity-50" disabled={busy || !options.status.available || (task !== 'inventory' && !roomId) || (task === 'week' && !week)} onClick={() => void summarize()}>{busy ? 'Preparing summary…' : 'Summarize'}</button>
        {busy && <button type="button" className="min-h-12 rounded-xl border p-3" onClick={cancel}>Cancel</button>}
      </section>
    </>}
    {result && loadedKey === identity && <section aria-label="AI summary" className="min-w-0 space-y-3 rounded-2xl border border-blue-100 bg-white p-4">
      <h2 className="text-lg font-bold">{labels[result.task]}</h2>
      <p className="whitespace-pre-wrap break-words">{result.summary}</p>
      <p className="text-sm text-slate-600">Snapshot: {new Date(result.takenAt).toLocaleString()}</p>
      <ul className="list-inside list-disc text-sm">{result.sources.map(source => <li key={source.id}>{source.title}</li>)}</ul>
      <p className="text-sm text-slate-600">{result.warning}</p>
      <button type="button" className="min-h-12 rounded-xl border px-4" onClick={() => setResult(null)}>Clear summary</button>
    </section>}
    <div className="flex flex-wrap gap-4"><button type="button" className="min-h-12 text-blue-700 underline" onClick={() => { changed(); setRefresh(value => value + 1); }}>Check connection again</button>
      <Link className="flex min-h-12 items-center text-blue-700 underline" to={account?.role === 'viewer' || account?.role === 'teacher' ? '/classroom' : '/dashboard'}>Back to Organizer</Link></div>
  </section>;
}
