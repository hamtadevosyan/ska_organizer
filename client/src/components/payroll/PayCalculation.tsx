import { useState } from 'react';
import type { FormEvent } from 'react';
import { CalendarDays, CheckCircle2, ClipboardCheck, Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Day, Details } from './types';

type Period = { start: string; end: string };
type Props = {
  data: Details; busy: boolean; dirty: boolean;
  onDirty: (dirty: boolean) => void; onPeriodChange: () => void;
  onCalculate: (period: Period) => void;
  onSave: (path: string, body: unknown) => Promise<boolean>;
  onSection: (section: string) => void;
};
const shift = (date: string, days: number) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const weekStart = (date: string, firstDay: number) => shift(date, -((new Date(date + 'T12:00:00Z').getUTCDay() - firstDay + 7) % 7));
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
const duration = (ms: number) => { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 3600)} hr ${Math.floor(seconds % 3600 / 60)} min${seconds % 60 ? ` ${seconds % 60} sec` : ''}`; };
function initialPeriod(zone: string): Period {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const end = `${get('year')}-${get('month')}-${get('day')}`;
  return { start: weekStart(end, 1), end };
}

export default function PayCalculation({ data, busy, dirty, onDirty, onPeriodChange, onCalculate, onSave, onSection }: Props) {
  const [period, setPeriod] = useState(() => initialPeriod(data.ledger.timeZone));
  const [reviewing, setReviewing] = useState('');
  const [draftTurn, setDraftTurn] = useState(0);
  const rules = data.profile.rules, days = data.ledger.days;
  const validPeriod = valid(period.start) && valid(period.end) && period.start <= period.end && Date.parse(period.end) - Date.parse(period.start) <= 92 * 86400000;
  const selected = validPeriod ? days.filter(day => day.date >= period.start && day.date <= period.end) : [];
  const related = selected.length ? days.filter(day => day.date >= weekStart(period.start, rules.workweekStart) && day.date <= shift(weekStart(period.end, rules.workweekStart), 6) && !selected.includes(day)) : [];
  const policyReady = rules.confirmed && !!rules.reference.trim() && rules.mode === 'ca-standard';
  const rateMissing = selected.length ? selected.some(day => !data.profile.rates.some(rate => rate.effectiveOn <= day.date)) : !data.profile.rates.length;
  function changePeriod(next: Period) {
    if (busy || dirty && !window.confirm('Discard the unsaved payroll form changes?')) return;
    setPeriod(next); setReviewing(''); onDirty(false); onPeriodChange();
  }
  async function save(event: FormEvent<HTMLFormElement>, path: string, body: (fields: FormData) => unknown) {
    event.preventDefault();
    if (busy) return;
    if (await onSave(path, body(new FormData(event.currentTarget)))) { setReviewing(''); onDirty(false); }
  }
  function ordinaryDay(day: Day) {
    const start = weekStart(day.date, rules.workweekStart);
    const workweek = days.filter(item => item.date >= start && item.date <= shift(start, 6));
    // Offer a simple explicit review only where recorded time cannot imply
    // daily, weekly or seventh-day overtime. The server still validates pay.
    return policyReady && !day.incomplete && day.paidMillis <= 8 * 3600000 && workweek.length < 7 && workweek.every(item => !item.incomplete) &&
      workweek.reduce((sum, item) => sum + Math.max(item.paidMillis, item.approval?.status === 'approved' ? item.approval.regularMillis + item.approval.overtimeMillis + item.approval.doubleMillis : 0), 0) <= 40 * 3600000 &&
      (!day.approval || day.approval.overtimeMillis === 0 && day.approval.doubleMillis === 0 && day.approval.adjustmentCents === 0 && day.approval.regularMillis === day.paidMillis);
  }
  function dayCard(day: Day) {
    return <article key={day.date} className="payroll-review-day">
      <div className="payroll-review-heading"><div><h4>{day.date}</h4><p>{duration(day.paidMillis)} recorded paid time</p>
        {day.unpaidMillis > 0 && <small>Previously recorded deduction: {duration(day.unpaidMillis)}</small>}</div>
        <span className={'payroll-status ' + (day.approval?.status === 'approved' ? 'is-ready' : '')}>{day.incomplete ? 'Missing checkout' : day.approval?.status === 'approved' ? 'Approved' : 'Needs review'}</span></div>
      {day.incomplete ? <><p>Record the missing checkout before calculating this day.</p><button type="button" disabled={busy} onClick={() => onSection('time')}>Fix checkout for {day.date}</button></> : <>
        <button type="button" disabled={busy} onClick={() => { if (dirty && !window.confirm('Discard the unsaved payroll form changes?')) return; onDirty(false); setReviewing(reviewing === day.date ? '' : day.date); }}>Review hours for {day.date}</button>
        {reviewing === day.date && (ordinaryDay(day) ? <form key={day.date + ':' + data.ledger.version} onChange={() => onDirty(true)} onSubmit={event => void save(event, 'approvals', () => ({ version: data.ledger.version, date: day.date, status: 'approved', regularMillis: day.paidMillis, overtimeMillis: 0, doubleMillis: 0, adjustmentCents: 0, rulesReviewed: true, reason: 'Administrator reviewed all recorded paid time and overtime; no adjustments.' }))}>
          <fieldset disabled={busy}><p>Approve the full recorded time above at the regular rate. No time is rounded, capped by the schedule or deducted automatically.</p>
            <label className="payroll-check"><input type="checkbox" required />I checked the hours and overtime for {day.date}.</label>
            <button>Approve recorded hours for {day.date}</button>
            <button type="button" onClick={() => onSection('time')}>Use different hours or adjustments</button>
          </fieldset></form> : <div className="payroll-note"><p>This day needs a detailed review of overtime, adjustments or payroll rules. Recorded time stays intact.</p><button type="button" disabled={busy} onClick={() => onSection('time')}>Review overtime and adjustments for {day.date}</button></div>)}
      </>}
    </article>;
  }
  return <div className="payroll-guided">
    <div className="payroll-guide-intro"><span className="payroll-guide-icon"><Coins size={27} aria-hidden="true" /></span><div><h2>Calculate pay</h2><p>Choose dates, check the hours, then see gross pay before taxes.</p></div></div>
    <div className="payroll-step">
      <h3><CalendarDays size={21} aria-hidden="true" />1. Choose pay dates</h3>
      <fieldset disabled={busy}><div className="payroll-grid"><label>Pay period start<input type="date" value={period.start} onChange={event => changePeriod({ ...period, start: event.target.value })} required /></label><label>Pay period end<input type="date" value={period.end} onChange={event => changePeriod({ ...period, end: event.target.value })} required /></label></div></fieldset>
      <p className="ska-muted">Dates use {data.ledger.timeZone}. The amount includes work inside these dates.</p>
      {!validPeriod && <p role="alert">Choose a valid date range of up to 93 days, with the start before or on the end.</p>}
    </div>
    <div className="payroll-step">
      <h3><ClipboardCheck size={21} aria-hidden="true" />2. Review hours</h3>
      {(rateMissing || !policyReady) && <aside className="payroll-setup"><h4>One-time employee setup</h4><p>Only an hourly rate and reviewed payroll rules are needed here. SSN, bank details and payroll documents can be entered separately.</p>
        {rateMissing && <form key={'rate:' + data.profile.version + ':' + draftTurn} onChange={() => onDirty(true)} onSubmit={event => void save(event, 'rates', fields => ({ version: data.profile.version, effectiveOn: String(fields.get('effectiveOn')), cents: Math.round(Number(fields.get('rate')) * 100), currency: 'USD', reason: 'Initial hourly rate entered during guided pay setup.' }))}><fieldset disabled={busy}>
          <div className="payroll-grid"><label>Hourly rate ($ per hour)<input type="number" name="rate" min="0.01" step="0.01" required /></label><label>Rate starts on<input type="date" name="effectiveOn" defaultValue={selected[0]?.date || period.start} required /></label></div><button>Save hourly rate</button>
        </fieldset></form>}
        {!rateMissing && !policyReady && (rules.mode === 'ca-standard' ? <form key={'policy:' + data.profile.version + ':' + draftTurn} onChange={() => onDirty(true)} onSubmit={event => void save(event, 'profile', fields => ({ version: data.profile.version, reason: 'Payroll rules explicitly reviewed during guided pay setup.', rules: { ...rules, confirmed: true, workweekStart: Number(fields.get('workweekStart')), reference: String(fields.get('reference')) } }))}><fieldset disabled={busy}>
          <p>Have the person who handles payroll verify these settings once. This calculation supports standard California non-exempt rules, with workdays starting at midnight.</p>
          <label>Workweek starts<select name="workweekStart" defaultValue={rules.workweekStart}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day, i) => <option value={i} key={day}>{day}</option>)}</select></label>
          <label>Payroll review note<input name="reference" defaultValue={rules.reference} placeholder="Who reviewed the rules and which policy applies" maxLength={2000} required /></label>
          <label className="payroll-check"><input type="checkbox" required />The applicable classification, overtime and adjustments have been reviewed.</label><button>Save reviewed payroll rules</button>
        </fieldset></form> : <><p>Your saved rule set requires payroll-provider review.</p><button disabled={busy} onClick={() => onSection('profile')}>Open payroll settings</button></>)}
      </aside>}
      {!selected.length ? <p>No recorded work in these dates. Choose a different period or check the employee's time records.</p> : <>
        <p>{selected.filter(day => day.approval?.status === 'approved').length} of {selected.length} recorded workdays approved. Review each day before calculating.</p>
        <div className="payroll-review-days">{selected.map(dayCard)}</div>
        {!!related.length && <details><summary>Related workweek days</summary><p>These dates are outside the pay period. Review them when needed to check the complete overtime workweek; their pay is not included in this period.</p><div className="payroll-review-days">{related.map(dayCard)}</div></details>}
      </>}
      <p>For a late checkout, <Link to="/staff/work-time">review extra work time</Link> before finalizing.</p>
    </div>
    <div className="payroll-step"><h3><CheckCircle2 size={21} aria-hidden="true" />3. Calculate gross pay</h3><p>The server checks the saved hours, effective rate and overtime rules. It will show anything still needing attention.</p>
      {dirty && <p role="status">Save or discard your changes before calculating. <button type="button" disabled={busy} onClick={() => { if (!window.confirm('Discard the unsaved payroll form changes?')) return; setDraftTurn(n => n + 1); setReviewing(''); onDirty(false); }}>Discard unsaved changes</button></p>}
      <button className="payroll-primary" disabled={busy || dirty || !validPeriod || !selected.length} onClick={() => onCalculate(period)}>Calculate gross pay</button></div>
  </div>;
}
