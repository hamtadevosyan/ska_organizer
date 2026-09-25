import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Boxes, CalendarDays, ClipboardCheck, Palette, RefreshCw, Sparkles, Sun, Users, Utensils } from 'lucide-react';
import axios from 'axios';
import { API_BASE_URL } from '../lib/api';
import { authError } from '../auth/transport';
import type { DashboardMetrics, Section } from '../api/dashboard';
import learningIllustration from '../assets/brand/learning-world-v5.png';
import './dashboard.css';

const displayDate = (date: string) => new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
}).format(new Date(date + 'T12:00:00Z'));
const displayTime = (date: string, timeZone: string, withDate = false) => new Intl.DateTimeFormat(undefined, {
  timeZone, hour: 'numeric', minute: '2-digit', ...(withDate ? { month: 'short', day: 'numeric' } as const : {}),
}).format(new Date(date));

function SectionError({ message, name, retry }: { message: string; name: string; retry: () => void }) {
  return <div className="home-section-error"><p role="alert">{message}</p>
    <button type="button" className="ska-button" onClick={retry}>Retry {name}</button></div>;
}
function Metric({ label, href, result, retry, review = false }: {
  label: string; href: string; result: Section<{ count: number | null }>; retry: () => void; review?: boolean;
}) {
  return <section aria-label={label} className="home-metric">
    <h3>{label}</h3>
    {result.error ? <SectionError message={result.error} name={label.toLowerCase()} retry={retry} /> :
      review ? <><p className="home-review">Check attendance</p>
        <p className="ska-muted">Some open visits need review before this count can be shown.</p></> :
        <p className="home-metric-count">{result.data?.count}</p>}
    <Link className="ska-link" to={href}>{label === 'Present now' ? 'Open attendance' : label === 'Enrolled children' ? 'Open children' : 'Open staff'} <ArrowRight size={15} aria-hidden="true" /></Link>
  </section>;
}

const actions = [
  { to: '/attendance', label: 'Take attendance', note: 'Arrivals & pickups', hint: 'Every child counts', icon: ClipboardCheck, color: 'attendance' },
  { to: '/attendance?find=child', label: 'Find a child', note: 'Search by name', hint: 'Your children, one tap away', icon: Users, color: 'child' },
  { to: '/activities', label: 'Activities', note: 'Open the activity planner', hint: 'Learning through play', icon: Palette, color: 'activities' },
  { to: '/meals', label: 'Meals', note: 'See what’s on the menu', hint: 'Little bites. Happy tummies.', icon: Utensils, color: 'meals' },
];

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
      if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not load Home.'));
    } finally { if (!request.signal.aborted) setLoading(false); }
  }, [selectedDate]);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  const retry = () => { void refresh(); };
  const ready = metrics && !loading && !error && (!selectedDate || selectedDate === metrics.date);
  const sections = ready ? metrics.sections : null;

  return <div className="ska-page home-page">
    <header className="ska-page-head">
      <div><span className="ska-kicker"><span className="kicker-dot" />A new day. A little magic.</span>
        <h1>Hello, team <Sun className="greeting-sun" size={30} aria-hidden="true" /></h1>
        <p>Your children, your classrooms, and a day full of possibilities.</p></div>
      <button type="button" className="ska-button" disabled={loading} onClick={retry} aria-label="Refresh dashboard">
        <RefreshCw size={17} aria-hidden="true" />Refresh</button>
    </header>
    <nav className="home-actions" aria-label="Quick actions">
      {actions.map((action) => <Link to={action.to} key={action.to} className={`home-action action-${action.color}`}>
        <span className="home-action-top"><span className="home-action-icon"><action.icon size={29} aria-hidden="true" /></span><span className="home-action-hint">{action.hint}</span></span>
        <span className="home-action-title"><strong>{action.label}</strong><ArrowRight size={19} aria-hidden="true" /></span>
        <small>{action.note}</small>
      </Link>)}
    </nav>
    {loading && <p role="status" className="ska-loading"><RefreshCw size={22} aria-hidden="true" />Loading your day…</p>}
    {error && <div className="ska-alert is-error"><SectionError message={error} name="dashboard" retry={retry} /></div>}
    <div className="home-grid">
      <div className="home-stack">
        {ready && sections && <>
          <section aria-labelledby="dashboard-current" className="ska-panel">
            <div className="ska-panel-head"><div><h2 id="dashboard-current">Today, at a glance</h2>
              <p className="ska-muted">Updated {displayTime(metrics.takenAt, metrics.timeZone)} · {displayDate(metrics.today)} · {metrics.timeZone}</p></div></div>
            <div className="home-metrics">
              <Metric label="Present now" href="/attendance" result={sections.attendance} review={sections.attendance.data?.reviewRequired} retry={retry} />
              <Metric label="Enrolled children" href="/children" result={sections.enrollment} retry={retry} />
              <Metric label="Active Staff" href="/staff" result={sections.staff} retry={retry} />
            </div>
          </section>
          <section aria-labelledby="dashboard-inspiration" className="home-spotlight">
            <div><span className="ska-kicker">Little moments. Big discoveries.</span><h2 id="dashboard-inspiration">Let curiosity<br />lead the way.</h2>
              <p>A little inspiration for your next activity.</p><Link to="/activities" className="ska-link">Explore activities <ArrowRight size={16} aria-hidden="true" /></Link></div>
            <img src={learningIllustration} alt="" width="1536" height="1024" decoding="async" />
          </section>
          <section aria-labelledby="dashboard-stock" className="ska-panel home-stock">
            <div className="ska-panel-head"><h2 id="dashboard-stock"><Boxes size={19} aria-hidden="true" />Stock to check</h2><Link to="/inventory" className="ska-link">Open inventory <ArrowRight size={15} aria-hidden="true" /></Link></div>
            <div className="ska-panel-body">{sections.inventory.error ? <SectionError message={sections.inventory.error} name="stock" retry={retry} /> : sections.inventory.data && <>
              <div className="home-stock-counts"><Link to="/inventory?status=out"><strong>{sections.inventory.data.out}</strong>Out of stock</Link>
                <Link to="/inventory?status=low"><strong>{sections.inventory.data.low}</strong>Running low</Link></div>
              <p className="ska-muted">{sections.inventory.data.total === 0 ? 'No inventory items yet.' :
                sections.inventory.data.low + sections.inventory.data.out === 0 ? 'No items need restocking based on your saved amounts.' : 'Open a count to see the items that need attention.'}</p>
            </>}</div>
          </section>
        </>}
      </div>
      <section aria-labelledby="dashboard-plans" className="ska-panel home-plans">
        <div className="ska-panel-head"><div><h2 id="dashboard-plans"><CalendarDays size={19} aria-hidden="true" />{ready ? metrics.date === metrics.today ? 'Today’s plans' : 'Plans for ' + displayDate(metrics.date) : 'Your plans'}</h2>
          <p className="ska-muted">Saved meals and activities. The counts always show the current situation.</p></div></div>
        <div className="home-plan-controls"><label className="ska-field">Plan date
          <input type="date" min="1900-01-01" max="9999-12-31" value={selectedDate || metrics?.date || ''} onChange={(event) => setSelectedDate(event.target.value)} /></label>
          <button type="button" className="ska-button" onClick={() => { if (selectedDate) setSelectedDate(''); else retry(); }}>Today</button>
        </div>
        {ready && sections && <div className="home-plan-sections">
          <section aria-labelledby="dashboard-meals" className="home-plan-group">
            <div className="home-plan-heading"><h3 id="dashboard-meals"><span className="home-plan-icon is-meal"><Utensils size={19} aria-hidden="true" /></span>Meals</h3><Link to="/meals" className="ska-link">Open meal planner <ArrowRight size={15} aria-hidden="true" /></Link></div>
            {sections.meals.error ? <SectionError message={sections.meals.error} name="meals" retry={retry} /> :
              sections.meals.data?.items.length ? <ul className="home-plan-list meal-list">{sections.meals.data.items.map((item) =>
                <li key={item.slot}><span className="home-plan-label">{item.label}</span><strong>{item.name}</strong></li>)}</ul> :
                <p className="home-empty">No meals saved for this date.</p>}
          </section>
          <section aria-labelledby="dashboard-activities" className="home-plan-group">
            <div className="home-plan-heading"><h3 id="dashboard-activities"><span className="home-plan-icon is-activity"><Palette size={19} aria-hidden="true" /></span>Room activities</h3><Link to="/activities" className="ska-link">Open activity planner <ArrowRight size={15} aria-hidden="true" /></Link></div>
            {sections.activities.error ? <SectionError message={sections.activities.error} name="activities" retry={retry} /> :
              sections.activities.data?.rooms.length ? <div className="home-room-plans">{sections.activities.data.rooms.map((room) =>
                <section key={room.id} aria-label={room.name}>
                  <h4>{room.name}{!room.active && <span className="ska-muted">Archived room</span>}</h4>
                  {room.entries.length ? <ul className="home-plan-list activity-list">{room.entries.map((entry) => <li key={entry.id}>
                    <span className="home-plan-label">{entry.startTime ? entry.startTime + '–' + entry.endTime :
                      ({ morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon' }[entry.timeBlock || ''] || 'Time not recorded')}</span>
                    <strong>{entry.name}</strong></li>)}</ul> : <p className="home-empty">No activities saved for this date.</p>}
                </section>)}</div> : <p className="home-empty">No rooms or saved activities for this date.</p>}
          </section>
        </div>}
      </section>
    </div>
    {ready && sections && <section aria-labelledby="dashboard-changes" className="ska-panel home-changes">
      <div className="ska-panel-head"><div><h2 id="dashboard-changes"><Sparkles size={19} aria-hidden="true" />Recent changes</h2><p className="ska-muted">Latest recorded changes across all dates.</p></div></div>
      <div className="ska-panel-body">{sections.changes.error ? <SectionError message={sections.changes.error} name="recent changes" retry={retry} /> :
        sections.changes.data?.length ? <ul>{sections.changes.data.map((event) =>
          <li key={event.id}><Link className="ska-link" to={event.href}>{event.label}</Link><time dateTime={event.occurredAt}>{displayTime(event.occurredAt, metrics.timeZone, true)}</time></li>)}</ul> :
          <p className="home-empty">No operational changes recorded yet.</p>}
      </div>
    </section>}
  </div>;
}
