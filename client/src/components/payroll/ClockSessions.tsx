import { datedClock, duration } from './types';
import type { RecordedSession } from './types';

export default function ClockSessions({ sessions, date, timeZone, earlier }: { sessions?: RecordedSession[]; date: string; timeZone: string; earlier?: { checkin?: string | null; checkout?: string | null; incomplete?: boolean } }) {
  if (!sessions?.length) return <div className="payroll-session-records"><p>Earlier record summary (individual sessions unavailable)</p><dl>
    <div><dt>First recorded arrival</dt><dd>{earlier?.checkin ? datedClock(earlier.checkin, timeZone) : 'Not available in earlier records'}</dd></div>
    <div><dt>Last recorded departure</dt><dd>{earlier?.checkout ? datedClock(earlier.checkout, timeZone) : earlier?.incomplete ? 'Checkout missing' : 'Not available'}</dd></div>
  </dl></div>;
  const ordered = [...sessions].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  return <div className="payroll-session-records"><h5>Recorded sessions</h5><ul aria-label={'Recorded sessions for ' + date}>{ordered.map((session, index) => {
    const clipped = !!session.dayStart && (Date.parse(session.dayStart) !== Date.parse(session.start) || session.dayEnd !== undefined && (session.dayEnd === null ? session.end !== null : session.end === null || Date.parse(session.dayEnd) !== Date.parse(session.end)));
    return <li key={session.id} aria-label={'Recorded session ' + (index + 1) + ' for ' + date}><dl>
      <div><dt>Check-in</dt><dd><time dateTime={session.start}>{datedClock(session.start, timeZone)}</time></dd></div>
      <div><dt>Checkout</dt><dd>{session.end ? <time dateTime={session.end}>{datedClock(session.end, timeZone)}</time> : 'Checkout missing'}</dd></div>
    </dl>{clipped && <p>Time counted on {date}: <time dateTime={session.dayStart}>{datedClock(session.dayStart!, timeZone)}</time> to {session.dayEnd ? <time dateTime={session.dayEnd}>{datedClock(session.dayEnd, timeZone)}</time> : 'Checkout missing'}{session.dayEnd ? ` (${duration(Date.parse(session.dayEnd) - Date.parse(session.dayStart!))})` : ''}. These boundaries are part of this session, not new clock punches.</p>}</li>;
  })}</ul><small>{timeZone}</small></div>;
}
