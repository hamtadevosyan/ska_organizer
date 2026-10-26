import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, RefreshCw } from 'lucide-react';
import axios from 'axios';
import { AuthContext } from '../../auth/context';
import { authError, onSessionExpired } from '../../auth/transport';
import { BILLING_CHANGED, billingMoney, billingPayer, getBillingAlerts } from '../../api/billing';
import type { BillingAlerts as Alerts } from '../../api/billing';
import '../../pages/billing.css';

export function BillingAlerts() {
  const auth = useContext(AuthContext);
  const account = auth?.account;
  if (!account || account.role !== 'admin' || account.disabled || account.mustChangePassword || auth?.serverUnavailable) return null;
  return <AdministratorAlerts key={account.id} />;
}

function AdministratorAlerts() {
  const [data, setData] = useState<Alerts | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const request = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const refresh = useCallback(async () => {
    if (stopped.current) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); setData(null);
    try {
      const result = await getBillingAlerts(controller.signal);
      if (!controller.signal.aborted && !stopped.current) setData(result);
    } catch (failure) {
      if (!controller.signal.aborted && !stopped.current && !axios.isCancel(failure)) setError(authError(failure, 'Could not check overdue tuition. Try again.'));
    } finally { if (!controller.signal.aborted && !stopped.current) setLoading(false); }
  }, []);
  useEffect(() => {
    stopped.current = false;
    const unsubscribe = onSessionExpired(() => { stopped.current = true; request.current?.abort(); setData(null); setError(''); setExpired(true); });
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh(); const timer = window.setInterval(visible, 60_000);
    window.addEventListener('focus', visible); window.addEventListener('online', visible); window.addEventListener(BILLING_CHANGED, visible); document.addEventListener('visibilitychange', visible);
    return () => { stopped.current = true; request.current?.abort(); unsubscribe(); window.clearInterval(timer); window.removeEventListener('focus', visible); window.removeEventListener('online', visible); window.removeEventListener(BILLING_CHANGED, visible); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  if (expired) return null;
  return <section aria-label="Tuition overdue alerts" className="ska-panel min-w-0">
    <div className="ska-panel-head flex-wrap gap-3"><div><h2><BellRing size={19} aria-hidden="true" />Tuition reminders</h2><p className="ska-muted">Payments five or more days past their due date.</p></div><button className="ska-button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />Check tuition reminders</button></div>
    <div className="ska-panel-body space-y-3">{loading ? <p role="status">Checking tuition payments…</p> : error ? <p role="alert">{error}</p> : data && <>
      {!!data.pendingMonthlyCharges && <p className="rounded-xl bg-amber-50 p-3 text-amber-950">Some monthly charges need updating. <Link className="ska-link" to="/billing">Open tuition to check charges</Link></p>}
      {!!data.awaitingCcrcCount && <p className="rounded-xl bg-blue-50 p-3 text-blue-950">{data.awaitingCcrcCount} {data.awaitingCcrcCount === 1 ? 'service month awaits' : 'service months await'} CCRC review. Parent reminders start after the review and confirmed due date. <Link className="ska-link" to="/billing?status=ccrc">Review CCRC payments</Link></p>}
      {data.items.length ? <><p><strong>{billingMoney(data.totalOutstandingCents)}</strong> needs follow-up across {data.items.length} unpaid {data.items.length === 1 ? 'balance' : 'balances'}.</p><ul className="billing-alert-list">{data.items.slice(0, 5).map(item => <li key={item.id}><Link className="ska-link" to={'/billing?child=' + encodeURIComponent(item.childId)}>{item.childName} · {billingMoney(item.outstandingCents)}</Link><p>{billingPayer(item.payer)} · Due {item.dueDate} · {item.daysOverdue} days overdue</p></li>)}</ul><Link className="ska-link" to="/billing?status=overdue">Review overdue tuition</Link></> : <p>No tuition payments are five days overdue.</p>}
      <p className="text-sm text-slate-500">As of {data.today} · {data.timeZone}. CCRC-supported months stay pending until their actual payments are reviewed and a parent due date is confirmed.</p>
    </>}</div>
  </section>;
}
