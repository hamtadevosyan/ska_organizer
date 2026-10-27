import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Plus, RefreshCw, WalletCards } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../auth/context';
import { authError, onSessionExpired } from '../auth/transport';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import { BILLING_CHANGED, billingCents, billingDollars, billingMoney, billingPayer, billingRequestId, getBillingChild, getBillingSummary, saveBillingChange } from '../api/billing';
import type { BillingCharge, BillingDetail, BillingPayer, BillingRate, BillingSummary, BillingTotals } from '../api/billing';
import './billing.css';

const payers: BillingPayer[] = ['family', 'ccrc'];
const readableDate = (date: string) => new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const friendlyEvent = (type: string) => ({ profile: 'Tuition setup saved', generate: 'Monthly charges checked', monthly_charge: 'Monthly tuition charged', charge: 'Fee added', payment: 'Payment recorded', credit: 'Credit applied', reverse: 'Payment reversed', payment_reversal: 'Payment reversed', adjustment: 'Charge adjusted', ccrc_review: 'CCRC payments reviewed', ccrc_mode: 'Charge changed to actual CCRC payments', ccrc_review_reopened: 'CCRC review reopened' }[type] || type.replaceAll('_', ' '));
type FormKind = 'profile' | 'registration' | 'manual' | 'payment' | 'adjustment' | 'credit' | 'reverse' | 'ccrc-review' | 'ccrc-convert';
type Pending = { path: string; body: Record<string, unknown> };

const monthlyTuition = (rate: Pick<BillingRate, 'monthlyCents' | 'familyCents' | 'ccrcCents'>) => rate.monthlyCents ?? (rate.familyCents || 0) + (rate.ccrcCents || 0);
const paymentCapacity = (charge: BillingCharge, payer: BillingPayer) => charge.allocationCapacityCents?.[payer] ?? (charge.settlementMode === 'ccrc_actual' ? charge.outstandingCents : charge.payers[payer].outstandingCents);
const acceptsPayment = (charge: BillingCharge, payer: BillingPayer) => payer === 'ccrc' && charge.settlementMode === 'ccrc_actual' || paymentCapacity(charge, payer) > 0;
const chargeLabel = (charge: BillingCharge) => charge.title + (charge.month ? ' · Service month ' + charge.month : '');
function Totals({ value }: { value: BillingTotals }) {
  return <><dl className="billing-summary"><div><dt>Parent balance due</dt><dd>{billingMoney(value.familyOutstandingCents)}</dd></div><div><dt>Awaiting CCRC review</dt><dd>{billingMoney(value.awaitingCcrcCents || 0)}</dd></div><div><dt>Available credit</dt><dd>{billingMoney(value.creditCents)}</dd></div></dl>{!!value.awaitingCcrcCount && <p className="billing-muted">{value.awaitingCcrcCount} {value.awaitingCcrcCount === 1 ? 'service month awaits' : 'service months await'} CCRC review.</p>}{value.ccrcOutstandingCents > 0 && <p className="billing-muted">Earlier fixed CCRC charges: {billingMoney(value.ccrcOutstandingCents)}. These stay in history until you review them.</p>}</>;
}

export default function Billing() {
  const { account, serverUnavailable } = useAuth();
  if (!account || account.role !== 'admin' || account.disabled || account.mustChangePassword) return <p role="alert">Administrator access is required to view tuition and payments.</p>;
  return <>{serverUnavailable && <p role="alert" className="billing-note">Connection interrupted. Your unsaved billing entry is kept here; reconnect before saving.</p>}<BillingWorkspace key={account.id} /></>;
}

function BillingWorkspace() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('child') || '';
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [search, setSearch] = useState(''), [filter, setFilter] = useState(params.get('status') || 'all');
  const [work, setWork] = useState({ dirty: false, busy: false });
  const pending = useRef<AbortController | null>(null), stopped = useRef(false);
  const onWork = useCallback((dirty: boolean, busy: boolean) => setWork({ dirty, busy }), []);
  const refresh = useCallback(async () => {
    if (stopped.current) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError('');
    try { const result = await getBillingSummary(controller.signal); if (!controller.signal.aborted && !stopped.current) setSummary(result); }
    catch (failure) { if (!controller.signal.aborted && !stopped.current && !axios.isCancel(failure)) { setSummary(null); setError(authError(failure, 'Could not load tuition balances. Try again.')); } }
    finally { if (!controller.signal.aborted && !stopped.current) setLoading(false); }
  }, []);
  useEffect(() => {
    stopped.current = false; void refresh();
    const changed = () => void refresh();
    const unsubscribe = onSessionExpired(() => { stopped.current = true; pending.current?.abort(); setSummary(null); setError(''); });
    window.addEventListener(BILLING_CHANGED, changed);
    return () => { stopped.current = true; pending.current?.abort(); unsubscribe(); window.removeEventListener(BILLING_CHANGED, changed); };
  }, [refresh]);
  function choose(id: string) {
    if (work.busy || work.dirty && !window.confirm('Discard the unsaved billing entries and change child?')) return;
    setParams(id ? { child: id } : {}); setWork({ dirty: false, busy: false });
  }
  const shown = (summary?.children || []).filter(row => row.child.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
    (filter === 'all' || filter === 'overdue' && row.overdueCount > 0 || filter === 'paid' && row.profile && !row.pendingMonthlyCharges && !row.totals.awaitingCcrcCount && row.totals.outstandingCents === 0 || filter === 'partial' && row.totals.paidCents > 0 && row.totals.outstandingCents > 0 || filter === 'ccrc' && ((row.totals.awaitingCcrcCount || 0) > 0 || row.totals.ccrcOutstandingCents > 0) || filter === 'setup' && !row.profile));
  return <div className="billing-page ska-core-page">
    <header className="billing-hero"><div><span className="billing-kicker"><WalletCards size={19} aria-hidden="true" />A little clarity, every month</span><h1>Tuition &amp; payments</h1><p>Fees, payments and reminders in one place.</p><p><Link to="/billing/ccrc-statements">Import CCRC statement</Link></p></div><button disabled={loading || work.busy} onClick={() => void refresh()}><RefreshCw size={17} aria-hidden="true" />Refresh balances</button></header>
    {error && <p role="alert">{error}</p>}
    <section className="billing-panel"><label>Billing child<select value={selected} disabled={work.busy} onChange={event => choose(event.target.value)}><option value="">All children</option>{summary?.children.map(row => <option value={row.child.id} key={row.child.id}>{row.child.name}{row.child.active ? '' : ' (inactive)'}</option>)}</select></label>{loading && <p role="status">Loading tuition balances…</p>}</section>
    {selected ? <ChildBilling key={selected} childId={selected} onWork={onWork} /> : !loading && summary && <>
      <Totals value={summary.totals} />
      <section className="billing-panel" aria-label="Child billing balances"><div className="billing-grid"><label>Search billing children<input type="search" value={search} maxLength={160} onChange={event => setSearch(event.target.value)} placeholder="Search by name" /></label><label>Payment status<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All children</option><option value="overdue">Five days overdue</option><option value="partial">Partially paid</option><option value="paid">Paid</option><option value="ccrc">Awaiting CCRC review</option><option value="setup">Tuition not set up</option></select></label></div>
        {!shown.length ? <p>No children match these filters.</p> : <div className="billing-list">{shown.map(row => <article className="billing-child" key={row.child.id} aria-label={row.child.name + ' billing'}><div className="billing-card-head"><h2><Link to={'/billing?child=' + encodeURIComponent(row.child.id)}>{row.child.name}</Link></h2>{!!row.overdueCount && <span className="billing-status is-overdue">{row.overdueCount} overdue {row.overdueCount === 1 ? 'balance' : 'balances'}</span>}</div>{!row.child.active && <p className="billing-muted">Inactive child · History retained</p>}{!row.profile ? <p>Tuition has not been set up.</p> : <><p>Parents owe: <strong>{billingMoney(row.totals.familyOutstandingCents)}</strong>{!!row.totals.awaitingCcrcCount && <> · {row.totals.awaitingCcrcCount} {row.totals.awaitingCcrcCount === 1 ? 'month awaits' : 'months await'} CCRC review</>}</p>{!!row.pendingMonthlyCharges && <p className="billing-note">Monthly charges need updating.</p>}</>}<button onClick={() => choose(row.child.id)}>Open tuition for {row.child.name}</button></article>)}</div>}
      </section>
    </>}
  </div>;
}

function ChildBilling({ childId, onWork }: { childId: string; onWork: (dirty: boolean, busy: boolean) => void }) {
  const [data, setData] = useState<BillingDetail | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [form, setForm] = useState<FormKind | null>(null), [draft, setDraft] = useState<Record<string, string>>({}), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const alive = useRef(true), locked = useRef(false), stopped = useRef(false), request = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null);
  const report = useUnsavedChanges();
  const formPanel = useRef<HTMLElement | null>(null);
  const refresh = useCallback(async () => {
    if (stopped.current) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try { const result = await getBillingChild(childId, controller.signal); if (!controller.signal.aborted && alive.current && !stopped.current) setData(result); }
    catch (failure) { if (!controller.signal.aborted && alive.current && !stopped.current && !axios.isCancel(failure)) { setData(null); setError(authError(failure, 'Could not load this child’s billing. Try again.')); } }
    finally { if (!controller.signal.aborted && alive.current && !stopped.current) setLoading(false); }
  }, [childId]);
  useEffect(() => {
    alive.current = true; stopped.current = false; void refresh();
    const unsubscribe = onSessionExpired(() => { stopped.current = true; request.current?.abort(); mutation.current?.abort(); setData(null); setDraft({}); setForm(null); setDirty(false); setPending(null); setError(''); });
    return () => { alive.current = false; stopped.current = true; request.current?.abort(); mutation.current?.abort(); unsubscribe(); };
  }, [refresh]);
  useEffect(() => { report(dirty || !!pending, busy); onWork(dirty || !!pending, busy); return () => { report(false, false); onWork(false, false); }; }, [dirty, pending, busy, report, onWork]);
  useEffect(() => { if (!dirty && !pending && !busy) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, pending, busy]);
  useEffect(() => { if (form) formPanel.current?.scrollIntoView?.({ block: 'start' }); }, [form]);
  async function mutate(operation: Pending) {
    if (locked.current || stopped.current) return;
    locked.current = true; setBusy(true); setPending(operation); setError(''); setMessage('');
    const controller = new AbortController(); mutation.current = controller;
    try {
      const result = await saveBillingChange(childId, operation.path, operation.body, controller.signal);
      if (!alive.current || controller.signal.aborted || stopped.current) return;
      setData(result); setPending(null); setDraft({}); setForm(null); setDirty(false); setMessage('Saved. Balances and reminders are up to date.');
    } catch (failure) {
      if (!alive.current || controller.signal.aborted || stopped.current || axios.isCancel(failure)) return;
      const definitive = axios.isAxiosError(failure) && failure.response && failure.response.status >= 400 && failure.response.status < 500 && failure.response.status !== 408;
      if (definitive) { setPending(null); setError(authError(failure, 'Could not save the billing change. Check your entries and try again.')); }
      else setError('The save result could not be confirmed. Your entries are kept. Retry this same save before entering it again.');
    } finally { locked.current = false; if (alive.current && !stopped.current) setBusy(false); }
  }
  function open(next: FormKind, chargeId = '', paymentId = '') {
    if (!data || busy || pending || dirty && !window.confirm('Discard the unsaved billing entries?')) return;
    const profile = data.profile;
    const charge = data.charges.find(value => value.id === chargeId);
    const payment = data.payments.find(value => value.id === paymentId);
    const chosenPayer = payment?.payer || (charge?.settlementMode === 'ccrc_actual' && (charge.pendingCcrc || charge.outstandingCents === 0) || charge && charge.payers.family.outstandingCents === 0 && charge.payers.ccrc.outstandingCents > 0 ? 'ccrc' : 'family');
    const availableCharge = data.charges.find(value => acceptsPayment(value, chosenPayer));
    setForm(next); setDirty(false); setError(''); setMessage('');
    setDraft({ billingStart: profile?.pausedForEnrollment ? data.today : profile?.billingStart || data.today, billingEnd: profile?.billingEnd || '', effectiveMonth: profile && profile.effectiveMonth > data.today.slice(0, 7) ? profile.effectiveMonth : data.today.slice(0, 7), monthly: billingDollars(profile ? monthlyTuition(profile) : 0), ccrcManaged: profile?.ccrcManaged || profile?.ccrcCents ? 'yes' : '', family: billingDollars(profile?.familyCents || 0), ccrc: billingDollars(profile?.ccrcCents || 0), familyDueDay: String(profile?.familyDueDay || 1), ccrcDueDay: String(profile?.ccrcDueDay || 1), registration: billingDollars(profile?.registrationCents || 0), enabled: profile?.enabled === false ? '' : 'yes', title: next === 'registration' ? 'Registration fee' : 'One-time tuition charge', familyDueDate: data.today, ccrcDueDate: data.today, amount: next === 'registration' ? billingDollars(profile?.registrationCents || 0) : '', date: data.today, method: chosenPayer === 'ccrc' ? 'ccrc' : 'cash', reference: '', reason: '', payer: chosenPayer, chargeId: charge?.id || availableCharge?.id || '', paymentId: payment?.id || '', adjustment: 'reduce', newDueDate: '', parentDueDate: data.today });
    if (next === 'adjustment' && charge?.settlementMode === 'ccrc_actual') setDraft(previous => ({ ...previous, payer: 'family' }));
    if (next === 'registration') setDraft(previous => ({ ...previous, family: billingDollars(profile?.registrationCents || 0), ccrc: '0.00' }));
  }
  const change = (name: string, value: string) => {
    setDraft(previous => {
      const next = { ...previous, [name]: value };
      if (name === 'chargeId' && form === 'adjustment' && data?.charges.find(charge => charge.id === value)?.settlementMode === 'ccrc_actual') next.payer = 'family';
      if (name === 'billingStart' && !data?.profile) next.effectiveMonth = value.slice(0, 7);
      if (name === 'payer' && form === 'payment') { next.chargeId = data?.charges.find(charge => acceptsPayment(charge, value as BillingPayer))?.id || ''; next.method = value === 'ccrc' ? 'ccrc' : 'cash'; }
      if (name === 'paymentId' && form === 'credit') {
        const payment = data?.payments.find(payment => payment.id === value);
        if (payment) { next.payer = payment.payer; next.chargeId = data?.charges.find(charge => paymentCapacity(charge, payment.payer) > 0)?.id || ''; }
      }
      return next;
    }); setDirty(true); setMessage('');
  };
  const input = (label: string, name: string, type = 'text', required = true) => <label>{label}<input name={name} type={type} value={draft[name] || ''} onChange={event => change(name, event.target.value)} required={required} step={type === 'number' ? '0.01' : undefined} min={type === 'number' ? '0' : undefined} maxLength={type === 'text' ? 160 : undefined} /></label>;
  const select = (label: string, name: string, options: { id: string; name: string }[], includeBlank = false) => <label>{label}<select name={name} value={draft[name] || ''} onChange={event => change(name, event.target.value)} required={!includeBlank}>{includeBlank && <option value="">Leave as credit</option>}{options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>;
  const payer = (draft.payer || 'family') as BillingPayer;
  const selectedCharge = data?.charges.find(charge => charge.id === draft.chargeId);
  const selectedPayment = data?.payments.find(payment => payment.id === draft.paymentId);
  const enteredAmount = billingCents(draft.amount || '');
  const eligibleCharges = (data?.charges || []).filter(charge => acceptsPayment(charge, payer));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data || busy || pending || !event.currentTarget.reportValidity()) return;
    setError('');
    const cents = (name: string) => { const amount = billingCents(draft[name] || ''); if (amount === null) throw new Error('Enter amounts in dollars and cents, such as 1500.00.'); return amount; };
    let path = '', values: Record<string, unknown> = {};
    try {
      if (form === 'profile') {
        path = 'profile'; values = { billingStart: draft.billingStart, billingEnd: draft.billingEnd || null, effectiveMonth: draft.effectiveMonth, monthlyCents: cents('monthly'), ccrcManaged: draft.ccrcManaged === 'yes', familyDueDay: Number(draft.familyDueDay), registrationCents: cents('registration'), enabled: draft.enabled === 'yes', reason: draft.reason || '' };
      } else if (form === 'registration' || form === 'manual') {
        path = 'charges'; values = { kind: form === 'registration' ? 'registration' : 'manual', title: draft.title, familyCents: cents('family'), ccrcCents: cents('ccrc'), familyDueDate: draft.familyDueDate, ccrcDueDate: draft.ccrcDueDate, reason: draft.reason, ...(draft.additionalRegistration === 'yes' ? { confirmAdditionalRegistration: true } : {}) };
      } else if (form === 'payment') {
        path = 'payments'; values = { payer, amountCents: cents('amount'), date: draft.date, method: draft.method, reference: draft.reference || '', chargeId: draft.chargeId || null };
      } else if (form === 'adjustment') {
        if (!selectedCharge) throw new Error('Choose the charge to adjust.');
        path = 'charges/' + encodeURIComponent(selectedCharge.id) + '/adjustments';
        const amountCents = draft.adjustment === 'waive' ? -(selectedCharge.settlementMode === 'ccrc_actual' ? selectedCharge.outstandingCents : selectedCharge.payers[payer].outstandingCents) : cents('amount') * (draft.adjustment === 'increase' ? 1 : -1);
        values = { payer: selectedCharge.settlementMode === 'ccrc_actual' ? 'family' : payer, amountCents, reason: draft.reason, ...(selectedCharge.settlementMode !== 'ccrc_actual' && draft.newDueDate ? { dueDate: draft.newDueDate } : {}) };
      } else if (form === 'credit') {
        path = 'credits'; values = { paymentId: draft.paymentId, chargeId: draft.chargeId, amountCents: cents('amount') };
      } else if (form === 'ccrc-review') {
        path = 'charges/' + encodeURIComponent(draft.chargeId) + '/ccrc-review'; values = { familyDueDate: draft.parentDueDate, reason: draft.reason, ...((selectedCharge?.ccrcUnappliedCents || 0) > 0 ? { acknowledgeUnappliedCredit: draft.unappliedReviewed === 'yes' } : {}) };
      } else if (form === 'ccrc-convert') {
        path = 'charges/' + encodeURIComponent(draft.chargeId) + '/ccrc-mode'; values = { reason: draft.reason };
      } else if (form === 'reverse') { path = 'payments/' + encodeURIComponent(draft.paymentId) + '/reverse'; values = { reason: draft.reason }; }
      if (path) void mutate({ path, body: { ...values, version: data.version, requestId: billingRequestId() } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the billing entries.'); }
  }
  const cancel = () => { if (busy || pending || dirty && !window.confirm('Discard these unsaved billing entries?')) return; setForm(null); setDirty(false); setDraft({}); setError(''); };
  const formTitle = form === 'profile' ? 'Billing setup' : form === 'registration' ? 'Add registration fee' : form === 'manual' ? 'Add one-time charge' : form === 'payment' ? 'Record payment' : form === 'credit' ? 'Apply credit' : form === 'reverse' ? 'Reverse payment' : form === 'ccrc-review' ? 'Finish CCRC review' : form === 'ccrc-convert' ? 'Review earlier CCRC charge' : 'Adjust a charge';
  if (stopped.current) return null;
  if (!data) return <section className="billing-panel">{error && <p role="alert">{error}</p>}{loading && <p role="status">Loading child billing…</p>}<button disabled={loading} onClick={() => void refresh()}>Retry child billing</button></section>;
  const creditPayments = data.payments.filter(payment => !payment.reversed && payment.creditCents > 0);
  return <>
    <section className="billing-panel"><div className="billing-card-head"><div><h2>{data.child.name}</h2><p className="billing-muted">{data.child.active ? 'Active enrollment' : 'Inactive enrollment · History retained'} · {data.timeZone}</p></div><Link to="/billing"><ArrowLeft size={16} aria-hidden="true" />All billing children</Link></div><Totals value={data.totals} />
      {!!data.pendingMonthlyCharges && <p className="billing-note">{data.pendingMonthlyCharges} monthly {data.pendingMonthlyCharges === 1 ? 'charge needs' : 'charges need'} updating. Balances may be incomplete.</p>}
      {data.profile ? <><p>Tuition setup from {data.profile.effectiveMonth}: <strong>{billingMoney(monthlyTuition(data.profile))}</strong> per month{data.profile.ccrcManaged || data.profile.ccrcCents ? ' · CCRC supported' : ' · Paid by parents'}</p>{!data.profile.enabled && <p className="billing-note">{data.profile.pausedForEnrollment ? 'Monthly tuition was paused when enrollment ended on ' + data.profile.pausedOn + '. Reactivating the child does not restart billing. Choose the new billing period before resuming.' : 'Monthly charging is paused.'}</p>}<p className="billing-muted">{data.profile.ccrcManaged || data.profile.ccrcCents ? 'CCRC payments are recorded against the service month when they arrive. Review that month’s receipts and set the parent due date after CCRC has finished paying.' : 'Parent due day ' + data.profile.familyDueDay + '. A day beyond the month’s end uses its last day.'} Each charge retains the tuition used when it was created.</p></> : <p className="billing-note">Set up monthly tuition before recording charges or payments.</p>}
      <div className="billing-actions"><button className="billing-primary" disabled={busy || !!pending} onClick={() => open('profile')}>{data.profile ? 'Edit tuition setup' : 'Set up tuition'}</button>{data.profile && <><button disabled={busy || !!pending} onClick={() => open('registration')}><Plus size={17} aria-hidden="true" />Add registration fee</button><button disabled={busy || !!pending} onClick={() => open('payment')}>Record payment</button></>}</div>
      {data.profile && <details><summary>Other billing actions</summary><div className="billing-actions"><button disabled={busy || !!pending} onClick={() => open('manual')}>Add one-time charge</button><button disabled={busy || !!pending || !data.charges.length} onClick={() => open('adjustment', data.charges[0]?.id)}>Adjust a charge</button><button disabled={busy || !!pending || !creditPayments.length} onClick={() => { open('credit', '', creditPayments[0]?.id); }}>Apply credit</button><button disabled={busy || !!pending || dirty} onClick={() => void mutate({ path: 'generate', body: { version: data.version, requestId: billingRequestId(), throughMonth: data.today.slice(0, 7) } })}><CalendarDays size={17} aria-hidden="true" />Check monthly charges</button></div></details>}
      <button disabled={busy || !!pending} onClick={() => void refresh()}>Refresh child billing</button>{loading && <p role="status">Refreshing child billing…</p>}
    </section>
    {message && <p role="status" className="billing-success">{message}</p>}
    {error && <div role="alert">{error}</div>}
    {pending && !busy && <div className="billing-note"><p>This save needs confirmation. Retry uses the same request so a payment is not recorded twice.</p><button className="billing-primary" onClick={() => void mutate(pending)}>Retry same save</button></div>}
    {form && <section className="billing-panel" ref={formPanel}><div className="billing-form-head"><h3>{formTitle}</h3><button disabled={busy || !!pending} onClick={cancel}>Cancel billing entry</button></div>
      <form aria-label={formTitle} onSubmit={submit}><fieldset disabled={busy || !!pending || loading}>
        {form === 'profile' && <><p className="billing-note">{draft.enabled !== 'yes' ? 'Monthly charging will stay paused. Existing charges and payments are retained.' : draft.billingStart > data.today ? 'Monthly charging will start on ' + draft.billingStart + '. No current monthly charges will be created.' : 'Saving creates any missing monthly charges from ' + draft.billingStart + ' through ' + (draft.billingEnd && draft.billingEnd < data.today ? draft.billingEnd : data.today) + '.'} Each month uses the full monthly amount; adjust a partial month separately. Previously saved charges keep their original amounts.</p><div className="billing-grid">{input('Billing starts', 'billingStart', 'date')}{input('Billing ends (optional)', 'billingEnd', 'date', false)}{input('Applies from month', 'effectiveMonth', 'month')}{input('Registration fee ($)', 'registration', 'number')}</div><div className="billing-grid">{input('Monthly tuition ($)', 'monthly', 'number')}{draft.ccrcManaged !== 'yes' && <label>Parent due day<input type="number" min="1" max="31" step="1" required value={draft.familyDueDay} onChange={event => change('familyDueDay', event.target.value)} /></label>}</div><label className="billing-check"><input type="checkbox" checked={draft.ccrcManaged === 'yes'} onChange={event => change('ccrcManaged', event.target.checked ? 'yes' : '')} />CCRC helps pay this child’s tuition</label><p className="billing-muted">{draft.ccrcManaged === 'yes' ? 'CCRC can pay a different amount each month, usually after the month of care. Leave the parent balance awaiting review until the actual CCRC payments are recorded. No fixed CCRC amount is needed.' : 'The full monthly fee is due from the parents.'} The registration amount is a default; adding that fee is a separate action.</p><label className="billing-check"><input type="checkbox" checked={draft.enabled === 'yes'} onChange={event => change('enabled', event.target.checked ? 'yes' : '')} />Create monthly tuition charges</label>{data.profile?.pausedForEnrollment && draft.enabled === 'yes' && <label className="billing-check"><input type="checkbox" required checked={draft.resumeReviewed === 'yes'} onChange={event => change('resumeReviewed', event.target.checked ? 'yes' : '')} />I reviewed the new billing start and end dates before resuming tuition.</label>}{input('Setup note (optional)', 'reason', 'text', false)}<button className="billing-primary">Save tuition setup</button></>}
        {(form === 'registration' || form === 'manual') && <>{input('Fee name', 'title')}<div className="billing-grid">{input('Family amount ($)', 'family', 'number')}{input('CCRC amount ($)', 'ccrc', 'number')}{input('Family due date', 'familyDueDate', 'date')}{input('CCRC due date', 'ccrcDueDate', 'date')}</div>{input('Reason', 'reason')}{form === 'registration' && data.charges.some(charge => charge.kind === 'registration') && <label className="billing-check"><input type="checkbox" required checked={draft.additionalRegistration === 'yes'} onChange={event => change('additionalRegistration', event.target.checked ? 'yes' : '')} />I want to add another registration fee for this child.</label>}<p className="billing-muted">Enter 0.00 for both amounts to record a waived registration fee with its reason.</p><button className="billing-primary">{form === 'registration' ? 'Save registration fee' : 'Save one-time charge'}</button></>}
        {form === 'payment' && <>{select('Paid by', 'payer', payers.map(id => ({ id, name: billingPayer(id) })))}<div className="billing-grid">{input('Amount received ($)', 'amount', 'number')}{input('Payment date', 'date', 'date')}{select('Payment method', 'method', [{ id: 'cash', name: 'Cash' }, { id: 'check', name: 'Check' }, { id: 'bank-transfer', name: 'Bank transfer' }, { id: 'ccrc', name: 'CCRC statement' }, { id: 'other', name: 'Other' }])}{input('Reference (optional)', 'reference', 'text', false)}</div>{select('Apply payment to', 'chargeId', eligibleCharges.map(charge => ({ id: charge.id, name: chargeLabel(charge) + ' · ' + billingMoney(paymentCapacity(charge, payer)) + ' remaining' })), true)}{payer === 'ccrc' && <p className="billing-note">Select the month of care, even if the payment arrived the following month. Record each receipt, then finish that service month’s CCRC review to confirm what the parents owe. Enter the reviewed amount from the receipt here.</p>}{enteredAmount !== null && <p className="billing-credit">{billingMoney(Math.min(enteredAmount, selectedCharge ? paymentCapacity(selectedCharge, payer) : 0))} will apply to the selected charge. {billingMoney(Math.max(0, enteredAmount - (selectedCharge ? paymentCapacity(selectedCharge, payer) : 0)))} will remain as {billingPayer(payer)} credit.</p>}<button className="billing-primary">Save payment</button></>}
        {form === 'adjustment' && <>{select('Charge to adjust', 'chargeId', data.charges.map(charge => ({ id: charge.id, name: charge.title })))}{selectedCharge?.settlementMode === 'ccrc_actual' ? <p>The adjustment changes this month’s total tuition. Actual receipts stay in payment history, and the CCRC review reopens.</p> : select('Responsible payer', 'payer', payers.map(id => ({ id, name: billingPayer(id) })))}{select('Adjustment action', 'adjustment', [{ id: 'reduce', name: 'Reduce balance' }, { id: 'increase', name: 'Increase balance' }, { id: 'waive', name: 'Waive remaining balance' }])}{draft.adjustment !== 'waive' && input('Adjustment amount ($)', 'amount', 'number')}{selectedCharge?.settlementMode !== 'ccrc_actual' && input('New due date (optional)', 'newDueDate', 'date', false)}{input('Reason', 'reason')}<p className="billing-note">A correction stays in history. Payments already allocated to this charge are preserved.</p><button className="billing-primary">Save charge adjustment</button></>}
        {form === 'credit' && <>{select('Payment credit', 'paymentId', creditPayments.map(payment => ({ id: payment.id, name: readableDate(payment.date) + ' · ' + billingPayer(payment.payer) + ' · ' + billingMoney(payment.creditCents) })))}<p>{selectedPayment ? billingMoney(selectedPayment.creditCents) + ' ' + billingPayer(selectedPayment.payer) + ' credit available.' : 'Choose a payment credit.'}</p>{select('Apply credit to', 'chargeId', data.charges.filter(charge => selectedPayment && paymentCapacity(charge, selectedPayment.payer) > 0).map(charge => ({ id: charge.id, name: charge.title })))}{input('Credit amount ($)', 'amount', 'number')}<button className="billing-primary">Save credit allocation</button></>}
        {form === 'ccrc-review' && <><p>Service month: <strong>{selectedCharge?.month}</strong>. Tuition {billingMoney(selectedCharge?.amountCents || 0)} less CCRC applied {billingMoney(selectedCharge?.payers.ccrc.paidCents || 0)} and parent payments {billingMoney(selectedCharge?.payers.family.paidCents || 0)} leaves <strong>{billingMoney(selectedCharge?.outstandingCents || 0)}</strong> for the parents.</p><p className="billing-note">Finish only after all CCRC receipts for this service month have been checked. You can confirm zero CCRC payment with a note. Parents are reminded five days after the due date below.</p><label>Parent due date<input type="date" required min={data.today} value={draft.parentDueDate} onChange={event => change('parentDueDate', event.target.value)} /></label>{input('Review note', 'reason')}{(selectedCharge?.ccrcUnappliedCents || 0) > 0 && <div className="billing-note"><p>{billingMoney(selectedCharge?.ccrcUnappliedCents || 0)} received from CCRC for this service month remains unapplied. Review this credit and any parent overpayment before confirming. Nothing is refunded or transferred automatically.</p><label className="billing-check"><input type="checkbox" required checked={draft.unappliedReviewed === 'yes'} onChange={event => change('unappliedReviewed', event.target.checked ? 'yes' : '')} />I reviewed the unapplied CCRC credit for this service month.</label></div>}<label className="billing-check"><input type="checkbox" required checked={draft.ccrcReviewed === 'yes'} onChange={event => change('ccrcReviewed', event.target.checked ? 'yes' : '')} />I checked the CCRC payments for this service month.</label><button className="billing-primary">Confirm parent balance</button></>}{form === 'ccrc-convert' && <><p className="billing-note">Use the full tuition of {billingMoney(selectedCharge?.amountCents || 0)} and the actual payments already recorded. The earlier fixed split stays in history. Parent reminders pause until you finish reviewing CCRC for this month.</p>{input('Reason', 'reason')}<button className="billing-primary">Use actual CCRC payments</button></>}{form === 'reverse' && <><p className="billing-note">Reverse the payment of {billingMoney(selectedPayment?.amountCents || 0)} dated {selectedPayment?.date}. Its original record stays in history and any affected balance reopens.</p>{input('Reason', 'reason')}<button className="billing-primary">Confirm payment reversal</button></>}
      </fieldset></form>{busy && <p role="status">Saving billing entry…</p>}
    </section>}
    <section className="billing-panel" aria-label="Charges and payments">
      <h2>Charges &amp; payments</h2><p className="billing-muted">For CCRC-supported tuition, review the actual receipts for the service month first. Parent reminders start five calendar days after the parent due date you confirm.</p>
      {!data.charges.length ? <p>No charges recorded yet.</p> : <div className="billing-list">{data.charges.map(charge => <article className="billing-charge" key={charge.id} aria-label={'Charge ' + charge.title}>
        <div className="billing-card-head"><h3>{charge.title}</h3><span className={'billing-status' + (payers.some(payer => charge.payers[payer].overdue) ? ' is-overdue' : '')}>{charge.pendingCcrc || charge.status === 'awaiting_ccrc' ? 'Awaiting CCRC' : charge.status === 'partial' ? 'Partially paid' : charge.status === 'paid' ? 'Paid' : charge.status === 'waived' ? 'Waived' : 'Unpaid'}</span></div>
        {charge.settlementMode === 'ccrc_actual' ? <>
          <p className="billing-muted">Service month: {charge.month}. A later receipt date does not change the month of care.</p>
          <dl className="billing-settlement" aria-label="Service month tuition balance">
            <div><dt>Monthly tuition</dt><dd>{billingMoney(charge.amountCents)}</dd></div>
            <div><dt>CCRC received</dt><dd>{billingMoney(charge.ccrcReceivedCents ?? charge.payers.ccrc.paidCents)}</dd></div><div><dt>CCRC applied to tuition</dt><dd>{billingMoney(charge.payers.ccrc.paidCents)}</dd></div>{!!charge.ccrcUnappliedCents && <div><dt>CCRC unapplied credit</dt><dd>{billingMoney(charge.ccrcUnappliedCents)}</dd></div>}
            <div><dt>Parents paid</dt><dd>{billingMoney(charge.payers.family.paidCents)}</dd></div>
            <div className="billing-parent-balance"><dt>{charge.pendingCcrc ? 'Remaining tuition · pending CCRC review' : 'Parents still owe'}</dt><dd>{billingMoney(charge.outstandingCents)}</dd></div>
            <div><dt>Parent due date</dt><dd>{charge.pendingCcrc ? 'Set after CCRC review' : charge.payers.family.dueDate}</dd></div>
          </dl>
          {!!charge.ccrcUnappliedCents && <p className="billing-note">CCRC receipts exceed the amount available to apply to this month. The unapplied credit needs review; it has not been refunded or transferred.</p>}{charge.pendingCcrc && <p className="billing-note">CCRC can pay a different amount each month. This balance is provisional; no parent overdue reminder is raised while the CCRC review is pending.</p>}
          {charge.payers.family.overdue && <p className="billing-status is-overdue">{charge.payers.family.daysOverdue} days overdue</p>}
          {charge.ccrcReview && !charge.pendingCcrc && <p className="billing-muted">CCRC review: {charge.ccrcReview.reason}</p>}
        </> : <div className="billing-payers">{payers.map(payer => <dl className="billing-payer" key={payer} aria-label={billingPayer(payer) + ' charge balance'}><div><dt>{billingPayer(payer)} charged</dt><dd>{billingMoney(charge.payers[payer].amountCents)}</dd></div><div><dt>{billingPayer(payer)} paid</dt><dd>{billingMoney(charge.payers[payer].paidCents)}</dd></div><div><dt>{billingPayer(payer)} remaining</dt><dd>{billingMoney(charge.payers[payer].outstandingCents)}</dd></div><div><dt>Due date</dt><dd>{charge.payers[payer].dueDate}</dd></div>{charge.payers[payer].overdue && <p className="billing-status is-overdue">{charge.payers[payer].daysOverdue} days overdue</p>}</dl>)}</div>}
        <div className="billing-actions">
          <button disabled={busy || !!pending} onClick={() => open('payment', charge.id)}>Record payment for {charge.title}</button>
          {charge.settlementMode === 'ccrc_actual' && <button disabled={busy || !!pending} onClick={() => open('ccrc-review', charge.id)}>{charge.pendingCcrc ? 'Finish CCRC review for ' : 'Review CCRC for '}{charge.title}</button>}
          {charge.kind === 'monthly' && charge.settlementMode !== 'ccrc_actual' && (data.profile?.ccrcManaged || (charge.payers.ccrc.amountCents > 0)) && <button disabled={busy || !!pending} onClick={() => open('ccrc-convert', charge.id)}>Use actual CCRC payments for {charge.title}</button>}
          <button disabled={busy || !!pending} onClick={() => open('adjustment', charge.id)}>Adjust {charge.title}</button>
        </div>
        {charge.adjustments.length > 0 && <details><summary>Charge corrections ({charge.adjustments.length})</summary><ul>{charge.adjustments.map(adjustment => <li key={adjustment.id}>{billingPayer(adjustment.payer)} · {billingMoney(adjustment.amountCents)} · {adjustment.reason}</li>)}</ul></details>}
      </article>)}</div>}
    </section>
    <section className="billing-panel"><h2>Payment history</h2>{!data.payments.length ? <p>No payments recorded yet.</p> : <div className="billing-list">{[...data.payments].reverse().map(payment => <article className="billing-payment" key={payment.id} aria-label={billingPayer(payment.payer) + ' payment ' + payment.date}><div className="billing-card-head"><h3>{billingMoney(payment.amountCents)} · {billingPayer(payment.payer)}</h3><span className={'billing-status' + (payment.reversed ? ' is-muted' : '')}>{payment.reversed ? 'Reversed' : 'Recorded'}</span></div><p>{readableDate(payment.date)} · {payment.method}{payment.reference ? ' · ' + payment.reference : ''}</p>{payment.serviceMonth && <p>CCRC service month: {payment.serviceMonth}</p>}{payment.source?.statementId && <p><Link to={'/billing/ccrc-statements?statement=' + encodeURIComponent(payment.source.statementId)}>Open source statement</Link>{payment.source.page ? ' · Page ' + payment.source.page : ''}</p>}<p>Applied to charges: {billingMoney(payment.allocatedCents)}{payment.creditCents > 0 ? ' · Available credit: ' + billingMoney(payment.creditCents) : ''}</p>{payment.allocations.length > 0 && <ul className="billing-history" aria-label={payment.reversed ? 'Original payment allocations' : 'Payment allocations'}>{payment.allocations.map((allocation, index) => <li key={allocation.chargeId + ':' + index}>{data.charges.find(charge => charge.id === allocation.chargeId)?.title || allocation.chargeId} · {billingMoney(allocation.amountCents)}</li>)}</ul>}{payment.reverseReason && <p>Reversal reason: {payment.reverseReason}</p>}{!payment.reversed && <div className="billing-actions">{payment.creditCents > 0 && <button disabled={busy || !!pending} onClick={() => open('credit', '', payment.id)}>Apply this payment credit</button>}<button disabled={busy || !!pending} onClick={() => open('reverse', '', payment.id)}>Reverse this payment</button></div>}</article>)}</div>}</section>
    {data.profile && <section className="billing-panel"><details><summary>Monthly tuition history</summary><ul className="billing-history">{[...data.profile.rates].reverse().map((rate, index) => <li key={rate.at + ':' + index}>From {rate.effectiveMonth}: Monthly tuition {billingMoney(monthlyTuition(rate))}{rate.ccrcManaged || rate.ccrcCents ? ' · CCRC supported' : ' · Paid by parents'}</li>)}</ul></details><details><summary>Billing activity history</summary><ul className="billing-history">{[...data.history].reverse().slice(0, 100).map(event => <li key={event.id}>{friendlyEvent(event.type)} · {new Intl.DateTimeFormat('en-US', { timeZone: data.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.at))}{event.actorName ? ' · ' + event.actorName : ''}{event.reason ? ' · ' + event.reason : ''}</li>)}</ul></details></section>}
  </>;
}
