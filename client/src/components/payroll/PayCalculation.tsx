import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CalendarDays, ClipboardCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { approvedPaidMillis, duration, rateDecision } from './types';
import ClockSessions from './ClockSessions';
import RateAllocationFields, { PayRateSummary } from './RateAllocationFields';
import type { Day, Details, PayDayReview, PayReviewReason } from './types';

type Period = { start: string; end: string };
type Props = {
  data: Details; busy: boolean; dirty: boolean;
  onDirty: (dirty: boolean) => void; onPeriodChange: () => void;
  onCalculate: (period: Period) => void;
  onSave: (path: string, body: unknown) => Promise<boolean>;
  onSection: (section: string, date?: string) => void;
  result: ReactNode;
};
const shift = (date: string, days: number) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const weekStart = (date: string, firstDay: number) => shift(date, -((new Date(date + 'T12:00:00Z').getUTCDay() - firstDay + 7) % 7));
const valid = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
const clockLabel = (value: string) => { const [hour, minute] = value.split(':').map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`; };
const localDateTime = (instant: string, zone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};
function initialPeriod(zone: string): Period {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  const end = `${get('year')}-${get('month')}-${get('day')}`;
  return { start: weekStart(end, 1), end };
}

export default function PayCalculation({ data, busy, dirty, onDirty, onPeriodChange, onCalculate, onSave, onSection, result }: Props) {
  const [period, setPeriod] = useState(() => initialPeriod(data.ledger.timeZone));
  const [reviewing, setReviewing] = useState('');
  const [draftTurn, setDraftTurn] = useState(0);
  const [activeDraft, setActiveDraft] = useState('');
  const [paidDrafts, setPaidDrafts] = useState<Record<string, { hours: string; minutes: string }>>({});
  const rules = data.profile.rules, days = data.ledger.days;
  const validPeriod = valid(period.start) && valid(period.end) && period.start <= period.end && Date.parse(period.end) - Date.parse(period.start) <= 92 * 86400000;
  const shortDayWarnings = (data.shortDayWarnings ?? data.ledger.shortDayWarnings ?? []).filter(warning => validPeriod && warning.weekStart <= period.end && warning.weekEnd >= period.start);
  const selected = validPeriod ? days.filter(day => day.date >= period.start && day.date <= period.end) : [];
  const related = selected.length ? days.filter(day => day.date >= weekStart(period.start, rules.workweekStart) && day.date <= shift(weekStart(period.end, rules.workweekStart), 6) && !selected.includes(day)) : [];
  const policyReady = rules.confirmed && !!rules.reference.trim() && rules.mode === 'ca-standard';
  const rateMissing = selected.length ? selected.some(day => !data.profile.rates.some(rate => rate.effectiveOn <= day.date)) : !data.profile.rates.length;
  function changePeriod(next: Period) {
    if (busy || dirty && !window.confirm('Discard the unsaved payroll form changes?')) return;
    setPeriod(next); setReviewing(''); setActiveDraft(''); setPaidDrafts({}); onDirty(false); onPeriodChange();
  }
  async function save(event: FormEvent<HTMLFormElement>, path: string, body: (fields: FormData) => unknown) {
    event.preventDefault();
    if (busy || !event.currentTarget.reportValidity()) return;
    if (await onSave(path, body(new FormData(event.currentTarget)))) { setReviewing(''); setActiveDraft(''); setPaidDrafts({}); onDirty(false); }
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
    const suggestedPaidMillis = day.incomplete ? day.paidMillis : Math.ceil(day.paidMillis / 3600000) * 3600000;
    const roundingCreditMillis = suggestedPaidMillis - day.paidMillis;
    if (day.incomplete) add('MISSING_CHECKOUT', 'Record the missing checkout before calculating this day.', 'time');
    if (!policyReady) add('POLICY_UNCONFIRMED', rules.mode === 'ca-standard' ? 'Payroll rules have not been reviewed and confirmed.' : 'The saved payroll rules require payroll-provider review.', 'profile');
    if (!data.profile.rates.some(rate => rate.effectiveOn <= day.date)) add('RATE_MISSING', 'No hourly rate is saved for this date.', 'rates');
    if (day.approval?.status === 'returned') add('APPROVAL_RETURNED', `This day was returned for correction: ${day.approval.reason}`, 'time');
    if (day.approval?.status === 'needs-review') add('CLOCK_CHANGED', 'Clock records changed after approval. Review the updated time and approve this day again.', 'time');
    if (requiresOvertimeReview && !reviewedOvertime) add('OVERTIME_REVIEW', 'Overtime needs your review. Choose the hours and pay multiplier; no rate is chosen automatically.', 'time');
    if (day.approval?.mode !== 'manual-reviewed' && (day.approval?.overtimeMillis || day.approval?.doubleMillis)) add('LEGACY_OVERTIME', 'This earlier overtime allocation needs a new manual pay decision before calculating.', 'time');
    if (roundingCreditMillis > 0) add('ROUNDING_REVIEW', `Paid time is rounded up from ${duration(day.paidMillis)} to ${duration(suggestedPaidMillis)}. Review this rounded amount before approving.`, 'approve');
    if (day.approval?.status !== 'approved' && !reasons.length) add('APPROVAL_REQUIRED', 'Recorded time has not been approved yet.', 'approve');
    const attention = reasons.some(item => item.action !== 'approve' || item.code === 'ROUNDING_REVIEW');
    return { state: attention ? 'needs-attention' : day.approval?.status === 'approved' ? 'approved' : 'awaiting-approval', reasons,
      canApproveRecorded: !attention && !requiresOvertimeReview, requiresOvertimeReview, suggestedPaidMillis, scheduledCreditMillis: 0, roundingCreditMillis, requiresRoundingReview: roundingCreditMillis > 0 };
  }
  function dayCard(day: Day) {
    const review = reviewFor(day), work = review.workTime;
    const awaiting = review.state === 'awaiting-approval';
    const needsOvertimeReview = review.requiresOvertimeReview ?? (day.paidMillis > 8 * 3600000 || (work?.outsideMillis ?? 0) > 0 || !!day.approval?.overtimeMillis || !!day.approval?.doubleMillis);
    const suggestedPaidMillis = review.suggestedPaidMillis ?? day.paidMillis;
    const scheduledCreditMillis = review.scheduledCreditMillis ?? 0;
    const roundingCreditMillis = review.roundingCreditMillis ?? scheduledCreditMillis;
    const rate = data.profile.rates.filter(item => item.effectiveOn <= day.date).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn) || a.sequence - b.sequence).at(-1);
    const setupReady = policyReady && !!rate;
    const pendingWorkReview = review.reasons.some(reason => ['OUTSIDE_SCHEDULE', 'SCHEDULE_ISSUE'].includes(reason.code));
    const canReview = !day.incomplete && setupReady && !pendingWorkReview;
    const showApproval = canReview && (review.state !== 'approved' || reviewing === day.date);
    const needsNewRoundingDecision = review.reasons.some(reason => reason.code === 'ROUNDING_REVIEW');
    const priorPaidMillis = day.approval?.mode === 'manual-reviewed' && day.approval.status === 'approved' ? approvedPaidMillis(day.approval) : null;
    const existingPaidMillis = priorPaidMillis === null ? suggestedPaidMillis : needsNewRoundingDecision && !day.approval?.hoursOverride ? Math.max(priorPaidMillis, suggestedPaidMillis) : priorPaidMillis;
    const paidDraft = paidDrafts[day.date] ?? { hours: String(Math.floor(existingPaidMillis / 3600000)), minutes: String(Math.floor(existingPaidMillis % 3600000 / 60000)) };
    const validPaid = /^\d+$/.test(paidDraft.hours) && /^\d+$/.test(paidDraft.minutes) && Number(paidDraft.hours) <= 48 && Number(paidDraft.minutes) < 60 && Number(paidDraft.hours) * 60 + Number(paidDraft.minutes) <= 48 * 60;
    const chosenPaidMillis = paidDrafts[day.date] ? (Number(paidDraft.hours) * 60 + Number(paidDraft.minutes)) * 60000 : existingPaidMillis;
    const hoursOverride = validPaid && chosenPaidMillis !== suggestedPaidMillis;
    const belowClock = validPaid && chosenPaidMillis < day.paidMillis;
    const daySessions = data.ledger.sessions.filter(session => !session.voided && localDateTime(session.start, data.ledger.timeZone).slice(0, 10) <= day.date && (!session.end || localDateTime(session.end, data.ledger.timeZone).slice(0, 10) >= day.date));
    const missedSession = day.incomplete ? daySessions.find(session => !session.end) : undefined;
    const checkoutSession = missedSession ?? (daySessions.length === 1 ? daySessions[0] : undefined);
    const checkoutLocal = checkoutSession?.end ? localDateTime(checkoutSession.end, data.ledger.timeZone) : '';
    const editPaid = (part: 'hours' | 'minutes', value: string) => { setPaidDrafts(previous => ({ ...previous, [day.date]: { ...paidDraft, [part]: value } })); markDraft('day:' + day.date); };
    const actions = new Set(review.reasons.map(reason => reason.action));
    const timeTargets = [...new Set(review.reasons.filter(reason => reason.action === 'time').map(reason => reason.date || day.date))];
    const unresolvedRelatedTargets = timeTargets.filter(date => date !== day.date);
    const targetedWork = `/staff/work-time?staff=${encodeURIComponent(data.staff.id)}&date=${encodeURIComponent(day.date)}`;
    const checkoutForm = checkoutSession && <form key={'checkout:' + checkoutSession.id + ':' + draftTurn} onChange={() => markDraft('checkout:' + day.date)} onSubmit={event => void save(event, 'corrections', fields => ({
      version: data.ledger.version, sessionId: checkoutSession.id, start: checkoutSession.start, endLocal: String(fields.get('date')) + 'T' + String(fields.get('time')),
      ...(fields.get('occurrence') ? { endOccurrence: String(fields.get('occurrence')) } : {}), voided: false, reason: String(fields.get('reason')),
    }))}><fieldset disabled={locked('checkout:' + day.date)}><h5>{missedSession ? 'Record missed checkout' : 'Correct checkout'}</h5><p>Enter when the employee actually left. Times use {data.ledger.timeZone}.</p>
      <div className="payroll-grid"><label>Checkout date<input aria-label={'Actual checkout date for ' + day.date} type="date" name="date" defaultValue={checkoutLocal.slice(0, 10) || day.date} required /></label><label>Checkout time<input aria-label={'Actual checkout time for ' + day.date} type="time" name="time" defaultValue={checkoutLocal.slice(11)} required /></label></div>
      <label>Reason<input aria-label={'Reason for recording checkout for ' + day.date} name="reason" maxLength={1000} required /></label>
      <details><summary>Daylight-saving time</summary><label>If this time occurs twice<select name="occurrence" defaultValue=""><option value="">Choose only if requested</option><option value="earlier">First occurrence</option><option value="later">Second occurrence</option></select></label></details>
      <button>Save checkout for {day.date}</button>
    </fieldset></form>;
    return <article key={day.date} className="payroll-review-day" aria-label={'Pay review for ' + day.date}>
      <div className="payroll-review-heading"><div><h4>{day.date}</h4><p>{duration(day.paidMillis)} actual worked time</p>
        {day.unpaidMillis > 0 && <small>Previously recorded deduction: {duration(day.unpaidMillis)}</small>}</div>
        <span className={'payroll-status ' + (review.state === 'approved' ? 'is-ready' : '')}>{day.incomplete ? 'Missing checkout' : review.state === 'approved' ? 'Approved' : awaiting ? 'Awaiting approval' : 'Needs attention'}</span></div>
      {review.reasons.length > 0 && <div className={'payroll-day-reasons ' + (awaiting ? 'is-awaiting' : '')}>
        <strong>{awaiting ? 'What is needed' : 'What needs attention'}</strong>
        <ul>{review.reasons.map(reason => <li key={reason.code + ':' + reason.message}>{reason.message}</li>)}</ul>
      </div>}
      <details className="payroll-day-detail" open={review.state !== 'approved'}><summary>{review.state === 'approved' ? 'View approved day' : 'Clock times and pay details'}</summary>
      {work && <dl className="payroll-clock-comparison">
        <div><dt>Approved schedule</dt><dd>{work.plannedStart && work.plannedEnd ? `${clockLabel(work.plannedStart)}–${clockLabel(work.plannedEnd)}` : work.hasCapturedAllowance === false ? 'No approved schedule saved for this workday' : `Daily schedule · ${duration(work.plannedMinutes * 60000)}`}</dd><small>{work.scheduleTimeZone}</small></div>
      </dl>}
      <ClockSessions date={day.date} timeZone={work?.timeZone || data.ledger.timeZone} sessions={work?.sessions ?? daySessions} earlier={{ checkin: work?.checkin, checkout: work?.checkout, incomplete: day.incomplete }} />
      {roundingCreditMillis > 0 && <div className="payroll-credit-proposal"><strong>{duration(existingPaidMillis)} proposed paid time</strong><p>Actual work stays at {duration(day.paidMillis)}. {existingPaidMillis > suggestedPaidMillis ? `Your earlier paid-time decision is kept. The rounding suggestion is ${duration(suggestedPaidMillis)}.` : `Paid time is rounded up by ${duration(roundingCreditMillis)}.`}</p>{scheduledCreditMillis > 0 && !needsNewRoundingDecision && <small>The rounded time matches the approved daily schedule.</small>}</div>}
      {day.approval?.mode === 'manual-reviewed' && day.approval.status === 'approved' && <><p>Approved paid time: {duration(approvedPaidMillis(day.approval))}</p><PayRateSummary approval={day.approval} rate={rate} /></>}
      <div className="payroll-review-actions">
        {actions.has('work-time') && <Link to={targetedWork}>Review outside time for {day.date}</Link>}
        {day.incomplete && !missedSession && <button type="button" disabled={busy} onClick={() => onSection('time', day.date)}>Fix checkout for {day.date}</button>}
        {actions.has('rates') && <button type="button" disabled={busy} onClick={() => onSection('rates', day.date)}>Set hourly rate for {day.date}</button>}
        {actions.has('profile') && <button type="button" disabled={busy} onClick={() => onSection('profile', day.date)}>Review payroll rules for {day.date}</button>}
        {canReview && review.state === 'approved' && <button type="button" disabled={busy} onClick={() => { if (dirty && !window.confirm('Discard the unsaved payroll form changes?')) return; onDirty(false); setActiveDraft(''); setPaidDrafts({}); setDraftTurn(n => n + 1); setReviewing(day.date); }}>Review hours for {day.date}</button>}
        {unresolvedRelatedTargets.map(date => <button key={date} type="button" disabled={busy} onClick={() => onSection('time', date)}>Review workday {date}</button>)}
        {!canReview && !day.incomplete && !pendingWorkReview && timeTargets.includes(day.date) && <button type="button" disabled={busy} onClick={() => onSection('time', day.date)}>Review pay details for {day.date}</button>}
      </div>
      {checkoutForm && (missedSession ? checkoutForm : <details><summary>Correct checkout time</summary>{checkoutForm}</details>)}
      {showApproval && <form key={day.date + ':' + data.ledger.version + ':' + draftTurn} onChange={() => markDraft('day:' + day.date)} onSubmit={event => { if (!validPaid) { event.preventDefault(); return; } void save(event, 'approvals', fields => ({
        version: data.ledger.version, profileVersion: data.profile.version, date: day.date, status: 'approved', mode: 'manual-reviewed',
        paidMillis: chosenPaidMillis, hoursOverride, clockErrorConfirmed: belowClock && fields.has('clockErrorConfirmed'), ...rateDecision(fields, day.approval),
        adjustmentCents: day.approval?.adjustmentCents ?? 0, rulesReviewed: needsOvertimeReview || Number(fields.get('rateMillis')) > 0 || fields.has('replaceLegacyPremium') ? fields.has('payRateReviewed') : true, overtimeReviewed: fields.has('payRateReviewed'),
        reason: [hoursOverride ? String(fields.get('overrideReason')) : '', String(fields.get('payRateReason') || '')].filter(Boolean).join('; Pay review: ') || 'Administrator reviewed recorded time and the proposed paid hours; no automatic overtime multiplier.',
      })); }}>
        <fieldset disabled={locked('day:' + day.date)}>
          <div className="payroll-grid"><label>Paid hours<input aria-label={'Paid hours for ' + day.date} type="number" min="0" max="48" step="1" inputMode="numeric" value={paidDraft.hours} onChange={event => editPaid('hours', event.target.value)} aria-invalid={!validPaid} required /></label><label>Minutes<input aria-label={'Paid minutes for ' + day.date} type="number" min="0" max="59" step="1" inputMode="numeric" value={paidDraft.minutes} onChange={event => editPaid('minutes', event.target.value)} aria-invalid={!validPaid} required /></label></div>
          {!validPaid && <p role="alert">Enter whole hours and 0–59 minutes, up to 48 hours total.</p>}
          {work?.hasCapturedAllowance !== false && !!work?.plannedMinutes && <button type="button" onClick={() => { setPaidDrafts(previous => ({ ...previous, [day.date]: { hours: String(Math.floor(work.plannedMinutes / 60)), minutes: String(work.plannedMinutes % 60) } })); markDraft('day:' + day.date); }}>Use full scheduled day</button>}
          {hoursOverride && <div className="payroll-hours-reason"><label htmlFor={'paid-hours-reason-' + day.date}>Reason for this change</label><textarea key={chosenPaidMillis} id={'paid-hours-reason-' + day.date} aria-label={'Reason for changing paid hours for ' + day.date} name="overrideReason" maxLength={450} defaultValue={priorPaidMillis === chosenPaidMillis && (day.approval?.reason.length ?? 0) <= 450 ? day.approval?.reason || '' : ''} placeholder="For example: Sent home early; paying the full scheduled day" required />{priorPaidMillis === chosenPaidMillis && (day.approval?.reason.length ?? 0) > 450 && <p>Previous paid-hours reason: {day.approval?.reason}. Enter a new reason for this review.</p>}</div>}
          {belowClock && <label className="payroll-check"><input name="clockErrorConfirmed" type="checkbox" required />I verified the actual hours; the clock record is incorrect.</label>}
          {validPaid && <p>Approve {duration(chosenPaidMillis)} of paid time for this day.</p>}
          <RateAllocationFields date={day.date} paidMillis={validPaid ? chosenPaidMillis : 0} approval={day.approval} rate={rate} overtime={needsOvertimeReview} />
          <button disabled={!validPaid} aria-label={(needsOvertimeReview ? 'Approve reviewed pay for ' : 'Approve recorded hours for ') + day.date}>{needsOvertimeReview ? 'Approve reviewed pay' : validPaid ? `Approve ${duration(chosenPaidMillis)}` : 'Approve paid time'}</button>
          <details><summary>Detailed approval</summary><p>Open the complete daily decision and its history.</p><button type="button" onClick={() => onSection('time', day.date)}>Open detailed approval for {day.date}</button></details>
        </fieldset></form>}
      </details>
    </article>;
  }
  return <div className="payroll-guided">
    <h2>Calculate pay</h2>
    <div className="payroll-step">
      <h3><CalendarDays size={21} aria-hidden="true" />Pay dates</h3>
      <fieldset disabled={busy}><div className="payroll-grid"><label>Pay period start<input type="date" value={period.start} onChange={event => changePeriod({ ...period, start: event.target.value })} required /></label><label>Pay period end<input type="date" value={period.end} onChange={event => changePeriod({ ...period, end: event.target.value })} required /></label></div></fieldset>
      <small className="ska-muted">{data.ledger.timeZone}</small>
      {!validPeriod && <p role="alert">Choose a valid date range of up to 93 days, with the start before or on the end.</p>}
      {dirty && <p role="status">Save or discard your changes before calculating. <button type="button" disabled={busy} onClick={() => { if (!window.confirm('Discard the unsaved payroll form changes?')) return; setDraftTurn(n => n + 1); setReviewing(''); setActiveDraft(''); setPaidDrafts({}); onDirty(false); }}>Discard unsaved changes</button></p>}
      {!selected.length && validPeriod && <p>No recorded work in these dates. Choose a different period or check the employee's time records.</p>}
      <button type="button" className="payroll-primary payroll-calculate" aria-busy={busy} disabled={busy || dirty || !validPeriod || !selected.length} onClick={() => onCalculate(period)}>Calculate pay</button>
      {!!selected.length && selected.some(day => reviewFor(day).state !== 'approved') && <p className="payroll-pending-hint">{selected.filter(day => reviewFor(day).state !== 'approved').length} {selected.filter(day => reviewFor(day).state !== 'approved').length === 1 ? 'day needs' : 'days need'} review below before you can save the final amount.</p>}
    </div>
    {result}
    {!!shortDayWarnings.length && <aside className="payroll-short-warning"><h3>Repeated short workdays</h3><p>Review is needed because this happened more than once in the same week.</p>{shortDayWarnings.map(warning => <div key={warning.staffId + ':' + warning.weekStart}><p>{warning.count} short days in the week of {warning.weekStart}.</p><p>Actual work was below the approved daily schedule on {warning.dates.join(', ')}. Schedule credit does not remove this warning.</p></div>)}</aside>}
    <div className="payroll-step">
      <h3><ClipboardCheck size={21} aria-hidden="true" />Review days</h3>
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
      {!!selected.length && <>
        <p>{selected.filter(day => reviewFor(day).state === 'approved').length} of {selected.length} recorded workdays approved.</p>
        <div className="payroll-review-days">{selected.map(dayCard)}</div>
        {!!related.length && <details><summary>Related workweek days</summary><p>These dates are outside the pay period. Review them when needed to check the complete overtime workweek; their pay is not included in this period.</p><div className="payroll-review-days">{related.map(dayCard)}</div></details>}
      </>}
    </div>
  </div>;
}
