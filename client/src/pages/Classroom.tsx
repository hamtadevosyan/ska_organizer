import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, ClipboardCheck, Clock3, GraduationCap, Palette, RefreshCw, Sparkles, Sun, Users, Utensils } from 'lucide-react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { getClassroomActivities, getClassroomChildren, getClassroomMeals, getClassroomOverview } from '../api/classroom';
import type { ClassroomActivities, ClassroomChildren, ClassroomMeals, ClassroomOverview, ClassroomScope } from '../api/classroom';
import learningIllustration from '../assets/brand/learning-world-v5.png';
import './dashboard.css';
import './classroom.css';

type Section = 'overview' | 'children' | 'activities' | 'meals';
type Details = ClassroomChildren | ClassroomActivities | ClassroomMeals | null;
type Loaded = { key: string; overview: ClassroomOverview; details: Details; week: string };
const titles = { overview: 'My class', children: 'Children in my class', activities: 'Class activities', meals: 'Class meals' };
const icons = { overview: GraduationCap, children: Users, activities: BookOpen, meals: Utensils };
function monday(today: string) {
  const date = new Date(today + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime())) throw new Error('The class calendar is unavailable.');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function shiftedWeek(week: string, days: number) {
  const date = new Date(week + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function checkScope(value: ClassroomScope, assignedRoom: string | null) {
  if (value.state === 'assigned' && (!assignedRoom || value.room?.id !== assignedRoom)) throw new Error('Your class assignment changed. Refresh your session and try again.');
}
const slots: Record<string, string> = { breakfast: 'Breakfast', snack: 'Morning snack', lunch: 'Lunch', afternoonSnack: 'Afternoon snack' };

export default function Classroom({ section = 'overview' }: { section?: Section }) {
  const { account, serverUnavailable } = useAuth();
  const [week, setWeek] = useState('');
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = JSON.stringify([account?.id, account?.role, account?.roomId ?? null, section, week, revision, serverUnavailable]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, 30_000);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoaded(null); setFailure(null);
    if ((account?.role !== 'viewer' && account?.role !== 'teacher') || serverUnavailable) return () => controller.abort();
    const roomId = account.roomId ?? null;
    void (async () => {
      const overview = await getClassroomOverview(controller.signal); checkScope(overview, roomId);
      const selectedWeek = week || monday(overview.today);
      let details: Details = null;
      if (overview.state === 'assigned') {
        if (section === 'children') details = await getClassroomChildren(controller.signal);
        if (section === 'activities') details = await getClassroomActivities(selectedWeek, controller.signal);
        if (section === 'meals') details = await getClassroomMeals(selectedWeek, controller.signal);
        if (details) {
          checkScope(details, roomId);
          if (details.state !== 'assigned') { if (active) setLoaded({ key, overview: { ...overview, state: details.state, room: null, activeChildCount: 0 }, details: null, week: selectedWeek }); return; }
          if ('weekStart' in details && details.weekStart !== selectedWeek) throw new Error('The requested week could not be verified.');
        }
      }
      if (active) setLoaded({ key, overview, details, week: selectedWeek });
    })().catch(error => { if (active && !axios.isCancel(error)) setFailure({ key, message: authError(error, 'Could not load your class. Try again.') }); });
    return () => { active = false; controller.abort(); };
  }, [key, account?.role, account?.roomId, section, week, serverUnavailable]);
  const current = loaded?.key === key ? loaded : null;
  const error = failure?.key === key ? failure.message : '';
  const overview = current?.overview;
  const Icon = icons[section];
  const teacher = account?.role === 'teacher';
  const actions = teacher ? [
    { to: '/classroom/attendance', label: 'Take attendance', note: 'Arrivals & pickups', icon: ClipboardCheck, color: 'attendance' },
    { to: '/classroom/children', label: 'Class children', note: 'Children, health & emergency', icon: Users, color: 'child' },
    { to: '/classroom/activities', label: 'Activities', note: 'See your saved class plan', icon: Palette, color: 'activities' },
    { to: '/classroom/meals', label: 'Meals', note: 'See what’s on the menu', icon: Utensils, color: 'meals' },
  ] : [
    { to: '/classroom/children', label: 'Class children', note: 'Your classroom’s children', icon: Users, color: 'attendance' },
    { to: '/my-time', label: 'My time', note: 'Check in or out of work', icon: Clock3, color: 'child' },
    { to: '/classroom/activities', label: 'Activities', note: 'See your saved class plan', icon: Palette, color: 'activities' },
    { to: '/classroom/meals', label: 'Meals', note: 'See what’s on the menu', icon: Utensils, color: 'meals' },
  ];
  if ((account?.role !== 'viewer' && account?.role !== 'teacher')) return <p role="alert">Class viewer access is required.</p>;
  return <div className="ska-classroom ska-core-page">
    {section === 'overview' ? <header className="ska-page-head ska-classroom-welcome"><div><span className="ska-kicker"><span className="kicker-dot" />A new day. A little magic.</span><h1>{titles[section]} <Sun className="greeting-sun" size={30} aria-hidden="true" /></h1><p>Hello, {account?.displayName || 'team'}. A day full of possibilities starts in your classroom.</p></div><button type="button" onClick={() => setRevision(value => value + 1)} aria-label="Refresh class"><RefreshCw size={18} aria-hidden="true" />Refresh</button></header> :
    <header className={'ska-classroom-hero section-' + section}><div className="ska-classroom-icon"><Icon size={30} aria-hidden="true" /></div><div><p className="ska-classroom-eyebrow">Your classroom, together</p><h1>{titles[section]}</h1><p>{overview?.state === 'assigned' ? overview.room?.name : 'A simple view of your assigned class.'}</p></div>
      <button type="button" onClick={() => setRevision(value => value + 1)} aria-label="Refresh class"><RefreshCw size={18} aria-hidden="true" />Refresh</button>
    </header>}
    {serverUnavailable ? <p role="alert" className="ska-classroom-card">Your class is unavailable while the connection is interrupted. Reconnect to load current information.</p>
      : error ? <p role="alert" className="ska-classroom-card">{error}</p>
        : !current ? <p role="status" className="ska-classroom-card">Loading your class…</p>
          : overview?.state !== 'assigned' ? <section className="ska-classroom-card"><h2>{overview?.state === 'unassigned' ? 'No class assigned yet' : 'Class currently unavailable'}</h2><p>Ask an administrator to assign you to an active class.</p></section>
            : <>
              {section === 'overview' && <>
                <nav className="home-actions ska-classroom-actions" aria-label="Class quick actions">{actions.map(action => <Link to={action.to} key={action.to} className={'home-action action-' + action.color}><span className="home-action-top"><span className="home-action-icon"><action.icon size={29} aria-hidden="true" /></span></span><span className="home-action-title"><strong>{action.label}</strong><ArrowRight size={19} aria-hidden="true" /></span><small>{action.note}</small></Link>)}</nav>
                <section className="ska-classroom-card ska-classroom-at-glance"><div className="ska-classroom-section-title"><span className="ska-classroom-icon"><GraduationCap size={24} aria-hidden="true" /></span><div><p className="ska-classroom-eyebrow">Your little community</p><h2>{overview.room?.name}</h2></div></div><p className="ska-classroom-count"><Users aria-hidden="true" />{overview.activeChildCount} active {overview.activeChildCount === 1 ? 'child' : 'children'}</p><dl className="ska-classroom-facts"><div><dt>Age range</dt><dd>{overview.room?.ageMinMonths == null || overview.room.ageMaxMonths == null ? 'Not configured' : overview.room.ageMinMonths + '–' + overview.room.ageMaxMonths + ' months'}</dd></div><div><dt>Class capacity</dt><dd>{overview.room?.capacity ?? 'Not configured'}</dd></div></dl></section>
                <section className="home-spotlight ska-classroom-spotlight"><div><span className="ska-kicker"><Sparkles size={15} aria-hidden="true" />Little moments. Big discoveries.</span><h2>Let curiosity<br />lead the way.</h2><p>Make room for play, connection and a little wonder.</p><Link to="/classroom/activities" className="ska-link">Explore class activities <ArrowRight size={16} aria-hidden="true" /></Link></div><img src={learningIllustration} alt="" width="1536" height="1024" decoding="async" /></section>
              </>}
              {section === 'children' && <section className="ska-classroom-card"><h2>Children</h2><p>{(current.details as ClassroomChildren).total} active children in your class</p><ul className="ska-classroom-children">{(current.details as ClassroomChildren).items.map(child => <li key={child.id}><span aria-hidden="true" className="ska-classroom-avatar">{child.firstName.slice(0, 1)}{child.lastName.slice(0, 1)}</span><span>{child.firstName} {child.lastName}{child.preferredName && child.preferredName !== child.firstName && <small>Goes by {child.preferredName}</small>}</span></li>)}</ul>{!(current.details as ClassroomChildren).items.length && <p>No active children are assigned to your class.</p>}</section>}
              {(section === 'activities' || section === 'meals') && <>
                <section className="ska-classroom-week" aria-label="Week selection"><button onClick={() => setWeek(shiftedWeek(current.week, -7))}>Previous week</button><label><CalendarDays size={18} aria-hidden="true" />Week starting<input type="date" value={current.week} onChange={event => { if (event.target.value) setWeek(monday(event.target.value)); }} /></label><button onClick={() => setWeek(shiftedWeek(current.week, 7))}>Next week</button></section>
                {section === 'activities' && <section className="ska-classroom-card"><h2>Saved activities</h2>{!(current.details as ClassroomActivities).hasPlan ? <p>No activities have been saved for your class for this week.</p> : !(current.details as ClassroomActivities).entries.length ? <p>No activities are scheduled for this week.</p> : <ul className="ska-classroom-plans">{(current.details as ClassroomActivities).entries.map(entry => <li key={entry.id}><p className="ska-classroom-date">{entry.date} · {entry.startTime && entry.endTime ? entry.startTime + '–' + entry.endTime : entry.timeBlock || 'Time not set'}</p><h3>{entry.activity.name}</h3>{entry.activity.description && <p>{entry.activity.description}</p>}{entry.activity.durationMinutes != null && <small>{entry.activity.durationMinutes} minutes</small>}</li>)}</ul>}</section>}
                {section === 'meals' && <section className="ska-classroom-card"><h2>Shared academy menu for your class</h2><p>This saved menu is shared across the academy.</p>{!(current.details as ClassroomMeals).hasPlan ? <p>No menu has been saved for this week.</p> : <div className="ska-classroom-menu">{(current.details as ClassroomMeals).week.map(day => <article key={day.day}><h3>{day.day}</h3><dl>{day.meals.map(meal => <div key={meal.slot}><dt>{slots[meal.slot] || meal.slot}</dt><dd>{meal.name || 'No meal selected'}</dd></div>)}</dl></article>)}</div>}</section>}
              </>}
            </>}
  </div>;
}
