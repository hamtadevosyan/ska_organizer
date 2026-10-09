import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, RefreshCw } from 'lucide-react';
import axios from 'axios';
import { AuthContext } from '../../auth/context';
import { authError, onSessionExpired } from '../../auth/transport';
import { getStaffCompliance, staffComplianceLabels } from '../../api/staffDocuments';
import type { StaffCompliance } from '../../api/staffDocuments';
import { STAFF_COMPLIANCE_CHANGED } from '../../api/staffComplianceEvents';

export function StaffComplianceAlerts({ expanded = false }: { expanded?: boolean }) {
  const auth = useContext(AuthContext);
  const account = auth?.account;
  if (!account || account.disabled || account.mustChangePassword || !['admin', 'editor'].includes(account.role)) return null;
  return <EmployeeAlerts key={account.id + ':' + account.role} admin={account.role === 'admin'} expanded={expanded} />;
}

function EmployeeAlerts({ admin, expanded }: { admin: boolean; expanded: boolean }) {
  const [data, setData] = useState<StaffCompliance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('all'); const [page, setPage] = useState(1);
  const pending = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const refresh = useCallback(async () => {
    if (stopped.current) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError('');
    try {
      const result = await getStaffCompliance(controller.signal);
      if (!controller.signal.aborted && !stopped.current) setData(result);
    } catch (failure) {
      if (!controller.signal.aborted && !stopped.current && !axios.isCancel(failure)) {
        setData(null); setError(authError(failure, 'Could not check employee documents. Try again.'));
      }
    } finally { if (!controller.signal.aborted && !stopped.current) setLoading(false); }
  }, []);
  useEffect(() => {
    stopped.current = false;
    const unsubscribe = onSessionExpired(() => {
      stopped.current = true; pending.current?.abort(); setData(null); setError(''); setExpired(true);
    });
    const checkVisible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh();
    const timer = window.setInterval(checkVisible, 60000);
    window.addEventListener('focus', checkVisible); window.addEventListener('online', checkVisible);
    window.addEventListener(STAFF_COMPLIANCE_CHANGED, checkVisible);
    document.addEventListener('visibilitychange', checkVisible);
    return () => {
      stopped.current = true; pending.current?.abort(); unsubscribe(); window.clearInterval(timer);
      window.removeEventListener('focus', checkVisible); window.removeEventListener('online', checkVisible);
      window.removeEventListener(STAFF_COMPLIANCE_CHANGED, checkVisible);
      document.removeEventListener('visibilitychange', checkVisible);
    };
  }, [refresh]);
  if (expired) return null;
  const matches = (data?.items || []).filter(item => (!expanded || status === 'all' || item.status === status) &&
    (!expanded || (item.employeeName + ' ' + item.requirementTitle).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const pages = Math.max(1, Math.ceil(matches.length / 10)); const shownPage = Math.min(page, pages);
  const shown = expanded ? matches.slice((shownPage - 1) * 10, shownPage * 10) : matches.slice(0, 5);
  return <section aria-label="Employee document reminders" className="ska-panel min-w-0">
    <div className="ska-panel-head flex-wrap gap-3"><div className="min-w-0"><h2><BellRing size={19} aria-hidden="true" />Employee documents</h2>
      <p className="ska-muted">Missing paperwork and training renewals to follow up.</p></div>
      <button type="button" className="ska-button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />Check employee documents</button>
    </div>
    <div className="ska-panel-body space-y-3">
      {loading ? <p role="status">Checking employee documents…</p> : error ? <p role="alert" className="text-red-800">{error}</p> : data && <>
        {!data.configured ? <p className="rounded-xl bg-amber-50 p-3 text-amber-900">No required employee documents are configured yet. {admin ? <Link className="ska-link" to="/registration-forms">Set up employee requirements</Link> : 'Ask an administrator to set up employee requirements.'}</p> :
          data.items.length ? <>
            <p role="status" className="text-sm text-slate-600">{data.items.length} {data.items.length === 1 ? 'item needs' : 'items need'} attention · Reminder window: {data.warningDays} days · As of {data.today}</p>
            {expanded && <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Search employee reminders<input type="search" maxLength={160} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Employee or requirement" className="mt-1 block w-full min-w-0 rounded-xl border p-3" /></label>
              <label className="min-w-0 text-sm">Reminder status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }} className="mt-1 block w-full min-w-0 rounded-xl border p-3"><option value="all">All reminders</option>{Object.entries(staffComplianceLabels).filter(([key]) => key !== 'complete').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>}
            {!shown.length ? <p>No reminders match these filters.</p> : <ul className="space-y-2">{shown.map(item => <li key={item.staffId + ':' + item.requirementId} className="min-w-0 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <Link className="ska-link break-words" to={'/staff?employee=' + encodeURIComponent(item.staffId)}>{item.employeeName} · {item.requirementTitle}</Link>
              <p className="mt-1 break-words text-sm text-amber-950">{staffComplianceLabels[item.status]}{item.expiresOn ? item.status === 'expired' ? ' · Expired on ' + item.expiresOn : item.daysRemaining === 0 ? ' · Expires today' : ' · Expires ' + item.expiresOn + (item.daysRemaining !== null ? ' (' + item.daysRemaining + ' days)' : '') : ''}</p>
            </li>)}</ul>}
            {expanded && pages > 1 && <nav aria-label="Employee reminder pages" className="flex flex-wrap items-center gap-3"><button type="button" className="ska-button" disabled={shownPage === 1} onClick={() => setPage(shownPage - 1)}>Previous reminders</button><span className="text-sm">Page {shownPage} of {pages}</span><button type="button" className="ska-button" disabled={shownPage === pages} onClick={() => setPage(shownPage + 1)}>Next reminders</button></nav>}
            <p className="text-sm text-slate-600">Request missing paperwork or renewed training from the employee. {!expanded && <Link className="ska-link" to="/staff">View all employee reminders</Link>}</p>
          </> : <p role="status">No required employee documents need attention as of {data.today}.</p>}
      </>}
    </div>
  </section>;
}
