import { useState } from 'react';
import type { FormEvent } from 'react';
import { CalendarDays, CheckCircle2, ClipboardCheck, Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import { approvedPaidMillis } from './types';
import type { Day, Details, PayDayReview, PayReviewReason } from './types';

type Period = { start: string; end: string };
type Props = {
  data: Details; busy: boolean; dirty: boolean;
  onDirty: (dirty: boolean) => void; onPeriodChange: () => void;
  onCalculate: (period: Period) => void;
  onSave: (path: string, body: unknown) => Promise<boolean>;
  onSection: (section: string, date?: string) => void;
};
const shift = (date: string, days: number) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const weekStart = (date: string, firstDay: number) => shift(date, -((new Date(date + 'T12:00:00Z').getUTCDay() - firstDay + 7) % 7));
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
const clockLabel = (value: string) => { const [hour, minute] = value.split(':').map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`; };
const actualClock = (instant: string | null, zone: string) => instant ? new Date(instant).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Checkout missing';
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
  const [activeDraft, setActiveDraft] = useState('');
  const rules = data.profile.rules, days = data.ledger.days;
  const validPeriod = valid(period.start) && valid(period.end) && period.start <= period.end && Date.parse(period.end) - Date.parse(period.start) <= 92 * 86400000;
  const shortDayWarnings = (data.shortDayWarnings ?? data.ledger.shortDayWarnings ?? []).filter(warning => validPeriod && warning.weekStart <= period.end && warning.weekEnd >= period.start);
  const selected = validPeriod ? days.filter(day => day.date >= period.start && day.date <= period.end) : [];
  const related = selected.length ? days.filter(day => day.date >= weekStart(period.start, rules.workweekStart) && day.date <= shift(weekStart(period.end, rules.workweekStart), 6) && !selected.includes(day)) : [];
  const policyReady = rules.confirmed && !!rules.reference.trim() && rules.mode === 'ca-standard';
  const rateMissing = selected.length ? selected.some(day => !data.profile.rates.some(rate => rate.effectiveOn <= day.date)) : !data.profile.rates.length;
  function changePeriod(next: Period) {
    if (busy || dirty && !window.confirm('Discard the unsaved payroll form changes?')) return;
    setPeriod(next); setReviewing(''); setActiveDraft(''); onDirty(false); onPeriodChange();
  }
  async function save(event: FormEvent<HTMLFormElement>, path: string, body: (fields: FormData) => unknown) {
    event.preventDefault();
    if (busy) return;
    if (await onSave(path, body(new FormData(event.currentTarget)))) { setReviewing(''); setActiveDraft(''); onDirty(false); }
  }
  function markDraft(id: string) { setActiveDraft(id); onDirty(true); }
  const locked = (id: string) => busy || dirty && activeDraft !== id;
  function reviewFor(day: Day): PayDayReview {
    if (day.review) return day.review;
    // Older detail responses remain readable while the current server supplies
    // the authoritative suggestion and review flags.
    const reasons: PayReviewReason[] = [];
    const add = (code: string, message: string, action: PayReviewReason['action']) => reasons.push({ code, message, action });
    const start = weekStart(day.date, rules.workweekStart);
    const week = days.filter(item => item.date >= start && item.date <= shift(start, 6));
    const requiresOvertimeReview = day.paidMillis > 8 * 3600000 || week.filter(item => item.date <= day.date).reduce((sum, item) => sum + item.paidMillis, 0) > 40 * 3600000 || week.length === 7 && day.date === shift(start, 6);
    const reviewedOvertime = day.approval?.mode === 'manual-reviewed' && day.approval.overtimeReviewed;
    if (day.incomplete) add('MISSING_CHECKOUT', 'Record the missing checkout before calculating this day.', 'time');
    if (!policyReady) add('POLICY_UNCONFIRMED', rules.mode === 'ca-standard' ? 'Payroll rules have not been reviewed and confirmed.' : 'The saved payroll rules require payroll-provider review.', 'profile');
    if (!data.profile.rates.some(rate => rate.effectiveOn <= day.date)) add('RATE_MISSING', 'No hourly rate is saved for this date.', 'rates');
    if (day.approval?.status === 'returned') add('APPROVAL_RETURNED', `This day was returned for correction: ${day.approval.reason}`, 'time');
    if (day.approval?.status === 'needs-review') add('CLOCK_CHANGED', 'Clock records changed after approval. Review the updated time and approve this day again.', 'time');
    if (requiresOvertimeReview && !reviewedOvertime) add('OVERTIME_REVIEW', 'Overtime needs your review. Enter the additional pay amount explicitly; no multiplier is applied automatically.', 'time');
    if (day.approval?.mode !== 'manual-reviewed' && (day.approval?.overtimeMillis || day.approval?.doubleMillis)) add('LEGACY_OVERTIME', 'This earlier overtime allocation needs a new manual pay decision before calculating.', 'time');
    if (day.approval?.status !== 'approved' && !reasons.length) add('APPROVAL_REQUIRED', 'Recorded time has not been approved yet.', 'approve');
    const attention = reasons.some(item => item.action !== 'approve');
    return { state: attention ? 'needs-attention' : day.approval?.status === 'approved' ? 'approved' : 'awaiting-approval', reasons,
      canApproveRecorded: !attention && !requiresOvertimeReview, requiresOvertimeReview, suggestedPaidMillis: day.paidMillis, scheduledCreditMillis: 0 };
  }
  function dayCard(day: Day) {
    const review = reviewFor(day), work = review.workTime;
    const awaiting = review.state === 'awaiting-approval';
    const needsOvertimeReview = review.requiresOvertimeReview ?? (day.paidMillis > 8 * 3600000 || (work?.outsideMillis ?? 0) > 0 || !!day.approval?.overtimeMillis || !!day.approval?.doubleMillis);
    const suggestedPaidMillis = review.suggestedPaidMillis ?? day.paidMillis;
    const scheduledCreditMillis = review.scheduledCreditMillis ?? 0;
    const setupReady = policyReady && data.profile.rates.some(rate => rate.effectiveOn <= day.date);
    const pendingWorkReview = review.reasons.some(reason => ['OUTSIDE_SCHEDULE', 'SCHEDULE_ISSUE'].includes(reason.code));
    const canReview = !day.incomplete && setupReady && !pendingWorkReview;
    const showApproval = canReview && (review.state !== 'approved' || reviewing === day.date);
    const existingPaidMillis = day.approval?.mode === 'manual-reviewed' && day.approval.status === 'approved' ? approvedPaidMillis(day.approval) : suggestedPaidMillis;
    const actions = new Set(review.reasons.map(reason => reason.action));
    const timeTargets = [...new Set(review.reasons.filter(reason => reason.action === 'time').map(reason => reason.date || day.date))];
    const unresolvedRelatedTargets = timeTargets.filter(date => date !== day.date);
    const targetedWork = `/staff/work-time?staff=${encodeURIComponent(data.staff.id)}&date=${encodeURIComponent(day.date)}`;
    return <article key={day.date} className="payroll-review-day" aria-label={'Pay review for ' + day.date}>
      <div className="payroll-review-heading"><div><h4>{day.date}</h4><p>{duration(day.paidMillis)} actual worked time</p>
        {day.unpaidMillis > 0 && <small>Previously recorded deduction: {duration(day.unpaidMillis)}</small>}</div>
        <span className={'payroll-status ' + (review.state === 'approved' ? 'is-ready' : '')}>{day.incomplete ? 'Missing checkout' : review.state === 'approved' ? 'Approved' : awaiting ? 'Awaiting approval' : 'Needs attention'}</span></div>
      {review.reasons.length > 0 && <div className={'payroll-day-reasons ' + (awaiting ? 'is-awaiting' : '')}>
        <strong>{awaiting ? 'What is needed' : 'What needs attention'}</strong>
        <ul>{review.reasons.map(reason => <li key={reason.code + ':' + reason.message}>{reason.message}</li>)}</ul>
      </div>}
      {work && <dl className="payroll-clock-comparison">
        <div><dt>Approved schedule</dt><dd>{work.plannedStart && work.plannedEnd ? `${clockLabel(work.plannedStart)}–${clockLabel(work.plannedEnd)}` : `Earlier daily-hours schedule · ${duration(work.plannedMinutes * 60000)}`}</dd><small>{work.scheduleTimeZone}</small></div>
        <div><dt>Actual check-in</dt><dd>{work.checkin ? actualClock(work.checkin, work.timeZone || data.ledger.timeZone) : 'Not available'}</dd></div>
        <div><dt>Actual checkout</dt><dd>{actualClock(work.checkout, work.timeZone || data.ledger.timeZone)}</dd></div>
      </dl>}
      {scheduledCreditMillis > 0 && <div className="payroll-credit-proposal"><strong>{duration(suggestedPaidMillis)} proposed paid time</strong><p>Includes {duration(scheduledCreditMillis)} of approved schedule credit. The actual clock record stays at {duration(day.paidMillis)}.</p></div>}
      {day.approval?.mode === 'manual-reviewed' && day.approval.status === 'approved' && <p>Approved paid time: {duration(approvedPaidMillis(day.approval))} · Additional pay: ${((day.approval.premiumCents ?? 0) / 100).toFixed(2)}</p>}
      <div className="payroll-review-actions">
        {actions.has('work-time') && <Link to={targetedWork}>Review outside time for {day.date}</Link>}
        {day.incomplete && <button type="button" disabled={busy} onClick={() => onSection('time', day.date)}>Fix checkout for {day.date}</button>}
        {actions.has('rates') && <button type="button" disabled={busy} onClick={() => onSection('rates', day.date)}>Set hourly rate for {day.date}</button>}
        {actions.has('profile') && <button type="button" disabled={busy} onClick={() => onSection('profile', day.date)}>Review payroll rules for {day.date}</button>}
        {canReview && review.state === 'approved' && <button type="button" disabled={busy} onClick={() => { if (dirty && !window.confirm('Discard the unsaved payroll form changes?')) return; onDirty(false); setActiveDraft(''); setReviewing(day.date); }}>Review hours for {day.date}</button>}
        {unresolvedRelatedTargets.map(date => <button key={date} type="button" disabled={busy} onClick={() => onSection('time', date)}>Review workday {date}</button>)}
        {!canReview && !day.incomplete && !pendingWorkReview && timeTargets.includes(day.date) && <button type="button" disabled={busy} onClick={() => onSection('time', day.date)}>Review pay details for {day.date}</button>}
      </div>
      {showApproval && <form key={day.date + ':' + data.ledger.version + ':' + draftTurn} onChange={() => markDraft('day:' + day.date)} onSubmit={event => void save(event, 'approvals', fields => ({
        version: data.ledger.version, profileVersion: data.profile.version, date: day.date, status: 'approved', mode: 'manual-reviewed',
        paidMillis: existingPaidMillis, premiumCents: needsOvertimeReview ? Math.round(Number(fields.get('premium')) * 100) : day.approval?.mode === 'manual-reviewed' ? day.approval.premiumCents ?? 0 : 0,
        adjustmentCents: day.approval?.adjustmentCents ?? 0, rulesReviewed: fields.has(needsOvertimeReview ? 'overtimeReviewed' : 'reviewed'), overtimeReviewed: needsOvertimeReview ? fields.has('overtimeReviewed') : false,
        reason: needsOvertimeReview ? String(fields.get('reason')) : 'Administrator reviewed recorded time and the proposed paid hours; no automatic overtime multiplier.',
      }))}>
        <fieldset disabled={locked('day:' + day.date)}><p>Proposed paid time: {duration(existingPaidMillis)}. Original check-in/out times are kept. No overtime multiplier or deduction is applied automatically.</p>
          {!!day.approval?.adjustmentCents && <p>Existing pay adjustment: ${(day.approval.adjustmentCents / 100).toFixed(2)}. This amount is retained unless you change the detailed decision.</p>}
          {!needsOvertimeReview && <label className="payroll-check"><input name="reviewed" type="checkbox" required />I checked the hours and overtime for {day.date}.</label>}
          {needsOvertimeReview && <div className="payroll-manual-review">
            <h5>Overtime needs your decision</h5>
            <p>Review the actual work and enter any required additional pay. Enter 0 only when you have verified that no additional pay is due.</p>
            <label>Additional pay for {day.date} ($)<input name="premium" type="number" min="0" step="0.01" defaultValue={day.approval?.mode === 'manual-reviewed' ? String((day.approval.premiumCents ?? 0) / 100) : ''} required /></label>
            <label>Pay review reason for {day.date}<input name="reason" maxLength={1000} required /></label>
            <label className="payroll-check"><input name="overtimeReviewed" type="checkbox" required />I reviewed overtime and additional pay for {day.date}.</label>
          </div>}
          <button>{needsOvertimeReview ? 'Approve reviewed pay for ' : 'Approve recorded hours for '}{day.date}</button>
          <details><summary>Change paid hours or add an adjustment</summary><p>Open the detailed decision to enter different paid hours or another reviewed adjustment.</p><button type="button" onClick={() => onSection('time', day.date)}>Open detailed approval for {day.date}</button></details>
        </fieldset></form>}
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
    {!!shortDayWarnings.length && <aside className="payroll-short-warning"><h3>Repeated short workdays</h3>{shortDayWarnings.map(warning => <div key={warning.staffId + ':' + warning.weekStart}><p>{warning.count} short days in the week of {warning.weekStart}.</p><p>Actual work was below the approved daily schedule on {warning.dates.join(', ')}. Schedule credit does not remove this warning.</p></div>)}</aside>}
    <div className="payroll-step">
      <h3><ClipboardCheck size={21} aria-hidden="true" />2. Review hours</h3>
      {(rateMissing || !policyReady) && <aside className="payroll-setup"><h4>One-time employee setup</h4><p>Only an hourly rate and reviewed payroll rules are needed here. SSN, bank details and payroll documents can be entered separately.</p>
        {rateMissing && <form key={'rate:' + data.profile.version + ':' + draftTurn} onChange={() => markDraft('rate')} onSubmit={event => void save(event, 'rates', fields => ({ version: data.profile.version, effectiveOn: String(fields.get('effectiveOn')), cents: Math.round(Number(fields.get('rate')) * 100), currency: 'USD', reason: 'Initial hourly rate entered during guided pay setup.' }))}><fieldset disabled={locked('rate')}>
          <div className="payroll-grid"><label>Hourly rate ($ per hour)<input type="number" name="rate" min="0.01" step="0.01" required /></label><label>Rate starts on<input type="date" name="effectiveOn" defaultValue={selected[0]?.date || period.start} required /></label></div><button>Save hourly rate</button>
        </fieldset></form>}
        {!rateMissing && !policyReady && (rules.mode === 'ca-standard' ? <form key={'policy:' + data.profile.version + ':' + draftTurn} onChange={() => markDraft('policy')} onSubmit={event => void save(event, 'profile', fields => ({ version: data.profile.version, reason: 'Payroll rules explicitly reviewed during guided pay setup.', rules: { ...rules, confirmed: true, workweekStart: Number(fields.get('workweekStart')), reference: String(fields.get('reference')) } }))}><fieldset disabled={locked('policy')}>
          <p>Have the person who handles payroll verify these settings once. Workdays start at midnight. Overtime is flagged for your review; the app does not choose a pay multiplier.</p>
          <label>Workweek starts<select name="workweekStart" defaultValue={rules.workweekStart}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day, i) => <option value={i} key={day}>{day}</option>)}</select></label>
          <label>Payroll review note<input name="reference" defaultValue={rules.reference} placeholder="Who reviewed the rules and which policy applies" maxLength={2000} required /></label>
          <label className="payroll-check"><input type="checkbox" required />The applicable classification, overtime and adjustments have been reviewed.</label><button>Save reviewed payroll rules</button>
        </fieldset></form> : <><p>Your saved rule set requires payroll-provider review.</p><button disabled={busy} onClick={() => onSection('profile')}>Open payroll settings</button></>)}
      </aside>}
      {!selected.length ? <p>No recorded work in these dates. Choose a different period or check the employee's time records.</p> : <>
        <p>{selected.filter(day => reviewFor(day).state === 'approved').length} of {selected.length} recorded workdays approved. Review each day before calculating.</p>
        <div className="payroll-review-days">{selected.map(dayCard)}</div>
        {!!related.length && <details><summary>Related workweek days</summary><p>These dates are outside the pay period. Review them when needed to check the complete overtime workweek; their pay is not included in this period.</p><div className="payroll-review-days">{related.map(dayCard)}</div></details>}
      </>}
      <p>For work outside the approved schedule, <Link to="/staff/work-time">review work time</Link> before finalizing.</p>
    </div>
    <div className="payroll-step"><h3><CheckCircle2 size={21} aria-hidden="true" />3. Calculate gross pay</h3><p>The server checks the saved hours, effective rate and overtime rules. It will show anything still needing attention.</p>
      {dirty && <p role="status">Save or discard your changes before calculating. <button type="button" disabled={busy} onClick={() => { if (!window.confirm('Discard the unsaved payroll form changes?')) return; setDraftTurn(n => n + 1); setReviewing(''); setActiveDraft(''); onDirty(false); }}>Discard unsaved changes</button></p>}
      <button className="payroll-primary" disabled={busy || dirty || !validPeriod || !selected.length} onClick={() => onCalculate(period)}>Calculate gross pay</button></div>
  </div>;
}
