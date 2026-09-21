import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, RefreshCw } from 'lucide-react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { authError } from '../auth/transport';
import type { DashboardMetrics, Section } from '../api/dashboard';

const button = 'min-h-11 rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium disabled:opacity-50';
const card = 'rounded-2xl border border-slate-200 bg-white p-5';
const link = 'inline-flex min-h-11 items-center gap-2 font-semibold text-emerald-800 underline-offset-4 hover:underline';
const displayDate = (date: string) => new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
}).format(new Date(date + 'T12:00:00Z'));
const displayTime = (date: string, timeZone: string, withDate = false) => new Intl.DateTimeFormat(undefined, {
  timeZone, hour: 'numeric', minute: '2-digit', ...(withDate ? { month: 'short', day: 'numeric' } as const : {}),
}).format(new Date(date));

function SectionError({ message, name, retry }: { message: string; name: string; retry: () => void }) {
  return <div className="space-y-2"><p role="alert" className="text-rose-800">{message}</p>
    <button type="button" className={button} onClick={retry}>Retry {name}</button></div>;
}
function Metric({ label, href, result, retry, review = false }: {
  label: string; href: string; result: Section<{ count: number | null }>; retry: () => void; review?: boolean;
}) {
  return <section aria-label={label} className={card}>
    <h3 className="text-sm font-medium text-slate-600">{label}</h3>
    {result.error ? <SectionError message={result.error} name={label.toLowerCase()} retry={retry} /> :
      review ? <><p className="mt-2 font-semibold text-amber-900">Check attendance</p>
        <p className="mt-1 text-sm text-slate-600">Some open visits need review before this count can be shown.</p></> :
        <p className="mt-2 text-4xl font-bold text-slate-950">{result.data?.count}</p>}
    <Link className={link + ' mt-2'} to={href}>{label === 'Present now' ? 'Open attendance' : label === 'Enrolled children' ? 'Open children' : 'Open staff'} <ArrowRight size={16} aria-hidden="true" /></Link>
  </section>;
}

export default function Dashboard() {
  // Empty selection follows the server's facility date, including after midnight.
  const [selectedDate, setSelectedDate] = useState('');
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController(); pending.current = request;
    setError(''); setLoading(true);
    try {
      const response = await axios.get<DashboardMetrics>(`${API_BASE_URL}/api/dashboard`, {
        params: selectedDate ? { date: selectedDate } : {}, signal: request.signal,
      });
      if (!request.signal.aborted) setMetrics(response.data);
    } catch (failure) {
      if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load the dashboard.'));
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, [selectedDate]);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  const retry = () => { void refresh(); };
  const sections = metrics?.sections;

  return <div className="mx-auto max-w-7xl space-y-6 p-2 text-slate-900 sm:p-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold">Dashboard</h1><p className="text-slate-600">A quick look at your childcare day.</p></div>
      <button type="button" className={button + ' inline-flex items-center gap-2'} disabled={loading} onClick={retry}>
        <RefreshCw size={18} aria-hidden="true" />Refresh dashboard</button>
    </header>
    <div className="flex flex-wrap items-end gap-2"><label className="text-sm font-medium">Plan date
      <input type="date" min="1900-01-01" max="9999-12-31" value={selectedDate || metrics?.date || ''}
        className="mt-1 block min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2"
        onChange={(event) => setSelectedDate(event.target.value)} /></label>
      <button type="button" className={button} onClick={() => { if (selectedDate) setSelectedDate(''); else retry(); }}>Today</button>
      <p className="pb-2 text-sm text-slate-600">Choose a date for saved meals and activities.</p>
    </div>
    {loading && <p role="status">Loading dashboard…</p>}
    {error && <SectionError message={error} name="dashboard" retry={retry} />}
    {metrics && sections && !loading && !error && (!selectedDate || selectedDate === metrics.date) && <>
      <section aria-labelledby="dashboard-current" className="space-y-3">
        <div><h2 id="dashboard-current" className="text-lg font-semibold">Right now</h2>
          <p className="text-sm text-slate-600">Updated {displayTime(metrics.takenAt, metrics.timeZone)} · {displayDate(metrics.today)} · {metrics.timeZone}</p></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Present now" href="/attendance" result={sections.attendance} review={sections.attendance.data?.reviewRequired} retry={retry} />
          <Metric label="Enrolled children" href="/children" result={sections.enrollment} retry={retry} />
          <Metric label="Active Staff" href="/staff" result={sections.staff} retry={retry} />
        </div>
      </section>
      <section aria-labelledby="dashboard-stock" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="dashboard-stock" className="text-lg font-semibold">Stock to check</h2>
          <Link to="/inventory" className={link}>Open inventory <ArrowRight size={16} aria-hidden="true" /></Link></div>
        {sections.inventory.error ? <SectionError message={sections.inventory.error} name="stock" retry={retry} /> : sections.inventory.data && <>
          <div className="mt-2 flex flex-wrap gap-6">
            <Link to="/inventory?status=out" className="rounded-lg p-2 text-rose-900 hover:bg-rose-50"><strong className="mr-2 text-3xl">{sections.inventory.data.out}</strong>Out of stock</Link>
            <Link to="/inventory?status=low" className="rounded-lg p-2 text-amber-900 hover:bg-amber-50"><strong className="mr-2 text-3xl">{sections.inventory.data.low}</strong>Running low</Link>
          </div>
          <p className="mt-2 text-sm text-slate-600">{sections.inventory.data.total === 0 ? 'No inventory items yet.' :
            sections.inventory.data.low + sections.inventory.data.out === 0 ? 'No items need restocking based on your saved amounts.' : 'Open a count to see the items that need attention.'}</p>
        </>}
      </section>
      <section aria-labelledby="dashboard-plans" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 id="dashboard-plans" className="text-lg font-semibold">{metrics.date === metrics.today ? 'Today’s plans' : 'Plans for ' + displayDate(metrics.date)}</h2>
            <p className="text-sm text-slate-600">Saved meals and activities. The counts above always show the current situation.</p></div>

        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <section aria-labelledby="dashboard-meals" className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="dashboard-meals" className="text-lg font-semibold">Meals</h3>
              <Link to="/meals" className={link}>Open meal planner <ArrowRight size={16} aria-hidden="true" /></Link></div>
            {sections.meals.error ? <SectionError message={sections.meals.error} name="meals" retry={retry} /> :
              sections.meals.data?.items.length ? <ul className="mt-2 divide-y divide-slate-100">{sections.meals.data.items.map((item) =>
                <li key={item.slot} className="py-3"><p className="text-sm text-slate-600">{item.label}</p><p className="font-semibold">{item.name}</p></li>)}</ul> :
                <p className="py-3 text-slate-600">No meals saved for this date.</p>}
          </section>
          <section aria-labelledby="dashboard-activities" className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="dashboard-activities" className="text-lg font-semibold">Room activities</h3>
              <Link to="/activities" className={link}>Open activity planner <ArrowRight size={16} aria-hidden="true" /></Link></div>
            {sections.activities.error ? <SectionError message={sections.activities.error} name="activities" retry={retry} /> :
              sections.activities.data?.rooms.length ? <div className="mt-2 space-y-4">{sections.activities.data.rooms.map((room) =>
                <section key={room.id} aria-label={room.name} className="border-t border-slate-100 pt-3">
                  <h4 className="font-semibold">{room.name}{!room.active && <span className="ml-2 text-sm font-normal text-slate-500">Archived room</span>}</h4>
                  {room.entries.length ? <ul className="mt-2 space-y-2">{room.entries.map((entry) => <li key={entry.id} className="flex flex-wrap gap-x-3">
                    <span className="text-sm text-slate-600">{entry.startTime ? entry.startTime + '–' + entry.endTime :
                      ({ morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon' }[entry.timeBlock || ''] || 'Time not recorded')}</span>
                    <span>{entry.name}</span></li>)}</ul> : <p className="mt-2 text-sm text-slate-600">No activities saved for this date.</p>}
                </section>)}</div> : <p className="py-3 text-slate-600">No rooms or saved activities for this date.</p>}
          </section>
        </div>
      </section>
      <section aria-labelledby="dashboard-changes" className={card}>
        <h2 id="dashboard-changes" className="text-lg font-semibold">Recent changes</h2>
        <p className="mb-2 text-sm text-slate-600">Latest recorded changes across all dates.</p>
        {sections.changes.error ? <SectionError message={sections.changes.error} name="recent changes" retry={retry} /> :
          sections.changes.data?.length ? <ul className="divide-y divide-slate-100">{sections.changes.data.map((event) =>
            <li key={event.id} className="flex flex-wrap items-center justify-between gap-x-4 py-1"><Link className={link} to={event.href}>{event.label}</Link>
              <time className="text-sm text-slate-500" dateTime={event.occurredAt}>{displayTime(event.occurredAt, metrics.timeZone, true)}</time></li>)}</ul> :
              <p className="py-3 text-slate-600">No operational changes recorded yet.</p>}
      </section>
    </>}
  </div>;
}
