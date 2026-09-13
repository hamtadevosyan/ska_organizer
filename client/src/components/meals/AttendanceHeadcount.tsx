import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { attendanceUrl, attendanceTime, getTodayHeadcount } from '../../api/attendance';
import type { TodayHeadcount } from '../../api/attendance';
import { authError } from '../../auth/transport';

type FacilityConfig = { today: string; timeZone: string };
// Mount separately for each week so a late response cannot change another draft.
export function AttendanceHeadcount({ dates, disabled, onApply }: {
  dates: string[]; disabled: boolean; onApply: (date: string, count: number) => void;
}) {
  const [config, setConfig] = useState<FacilityConfig | null>(null);
  const [sample, setSample] = useState<TodayHeadcount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const working = useRef(false);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    void axios.get<FacilityConfig>(attendanceUrl + '/config', { signal: request.signal }).then(({ data }) => {
      if (!request.signal.aborted) setConfig(data);
    }).catch((failure) => { if (!request.signal.aborted) setError(authError(failure, 'Could not read the facility date.')); });
    return () => { request.abort(); controller.current?.abort(); };
  }, [revision]);
  async function requestCount(apply = false) {
    if (disabled || working.current) return;
    working.current = true; setBusy(true); setError(''); setMessage('');
    const request = new AbortController(); controller.current = request;
    try {
      if (apply && sample) {
        const { data } = await axios.get<FacilityConfig>(attendanceUrl + '/config', { signal: request.signal });
        if (request.signal.aborted) return;
        setConfig(data);
        if (data.today !== sample.date || !dates.includes(sample.date)) {
          setSample(null); throw new Error('The facility date changed. Read today’s attendance again.');
        }
        onApply(sample.date, sample.childrenCount);
        setMessage(`${sample.childrenCount} children applied to ${sample.date}. Save Menu to keep this change.`);
        setSample(null);
      } else {
        setSample(null);
        const result = await getTodayHeadcount(request.signal);
        if (request.signal.aborted) return;
        setConfig({ today: result.date, timeZone: result.timeZone });
        if (!dates.includes(result.date)) throw new Error('Choose the week containing today and generate its menu before using attendance.');
        setSample(result);
      }
    } catch (failure) { if (!request.signal.aborted) setError(authError(failure, 'Could not read today’s attendance.')); }
    finally { if (!request.signal.aborted) { working.current = false; setBusy(false); } }
  }
  const eligible = !!config && dates.includes(config.today);
  return <section aria-label="Attendance headcount" className="rounded-2xl border border-emerald-100 bg-white p-5 text-sm print:hidden">
    <h3 className="font-bold text-slate-900">Plan today’s meals from attendance</h3>
    <p className="mt-1 text-slate-600">Review the number of children present across all rooms, then apply it to today. Other days use their own counts; staff counts remain editable.</p>
    {config?.today && <p className="mt-2 text-slate-600">Today at the facility: {config.today} · {config.timeZone}</p>}
    {!eligible && <p className="mt-2 text-slate-600">Available when today is a weekday in the selected menu.</p>}
    <button disabled={disabled || busy || !eligible} onClick={() => void requestCount()} className="mt-3 rounded-lg border border-emerald-700 px-4 py-2 font-semibold text-emerald-800 disabled:opacity-50">{busy ? 'Reading attendance…' : 'Review today’s attendance count'}</button>
    {sample && <div className="mt-4 rounded-lg bg-emerald-50 p-4">
      <p className="font-semibold">{sample.childrenCount} children present, recorded {attendanceTime(sample.takenAt, sample.timeZone)}.</p>
      <button disabled={disabled || busy} onClick={() => void requestCount(true)} className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white disabled:opacity-50">Apply count to {sample.date} only</button>
      <button disabled={busy} onClick={() => setSample(null)} className="ml-3 underline">Cancel</button>
    </div>}
    {error && <div role="alert" className="mt-3 text-red-800"><p>{error}</p>{!config && <button onClick={() => { setError(''); setRevision((n) => n + 1); }} className="mt-2 underline">Retry facility date</button>}</div>}
    {message && <p role="status" className="mt-3 text-emerald-800">{message}</p>}
  </section>;
}
