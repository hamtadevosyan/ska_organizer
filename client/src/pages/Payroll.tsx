import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { API_BASE_URL } from '../lib/api';
import { useAuth } from '../auth/context';
import { authError } from '../auth/transport';
import { staffAccountOptionsUrl } from '../api/staffAccountOptions';
import type { StaffAccountOption } from '../api/staffAccountOptions';
import { hours, localTime, money, payrollRequestId } from '../components/payroll/types';
import type { ClockSession, Details, Preview } from '../components/payroll/types';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import PayCalculation from '../components/payroll/PayCalculation';
import './payroll.css';
const base = API_BASE_URL + '/api/payroll/staff/';
const value = (data: FormData, key: string) => String(data.get(key) || '');
const asMillis = (data: FormData, key: string) => Math.round(Number(value(data, key)) * 3600000);
const today = (zone: string, instant = new Date()) => { const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant); const get = (kind: string) => parts.find(part => part.type === kind)?.value; return `${get('year')}-${get('month')}-${get('day')}`; };
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the selected file.')); reader.readAsDataURL(file); });
function StaffPayroll({ staffId, onWork }: { staffId: string; onWork: (dirty: boolean, busy: boolean) => void }) {
  const reportUnsaved = useUnsavedChanges();
  const [data, setData] = useState<Details | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0); const [tab, setTab] = useState('pay'); const [dirty, setDirty] = useState(false); const [formTurn, setFormTurn] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null); const [snapshot, setSnapshot] = useState<{ sourceChanged: boolean; preview: Preview } | null>(null);
  const [correction, setCorrection] = useState<ClockSession | null>(null);
  const [targetDay, setTargetDay] = useState('');
  const dayPanels = useRef(new Map<string, HTMLDetailsElement>());
  const correctionPanel = useRef<HTMLFormElement | null>(null);
  const policyPanel = useRef<HTMLDetailsElement | null>(null);
  const resultPanel = useRef<HTMLDivElement | null>(null);
  const snapshotLoad = useRef<AbortController | null>(null);
  const mounted = useRef(true); const controller = useRef<AbortController | null>(null); const snapshotRequest = useRef(payrollRequestId());
  useEffect(() => { if (preview || snapshot) resultPanel.current?.scrollIntoView?.({ block: 'start' }); }, [preview, snapshot]);
  useEffect(() => {
    if (tab !== 'time' || !targetDay) return;
    const panel = dayPanels.current.get(targetDay);
    if (panel) { panel.open = true; panel.scrollIntoView?.({ block: 'start' }); }
  }, [tab, targetDay, formTurn]);
  useEffect(() => { if (tab === 'time' && correction) correctionPanel.current?.scrollIntoView?.({ block: 'start' }); }, [tab, correction]);
  useEffect(() => { if (tab === 'profile' && targetDay && policyPanel.current) { policyPanel.current.open = true; policyPanel.current.scrollIntoView?.({ block: 'start' }); } }, [tab, targetDay, formTurn]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); snapshotLoad.current?.abort(); }; }, []);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    void axios.get<{ data: Details }>(base + encodeURIComponent(staffId), { signal: request.signal }).then(response => { if (!request.signal.aborted) setData(response.data.data); })
      .catch(failure => { if (!request.signal.aborted && !axios.isCancel(failure)) { setData(null); setError(authError(failure, 'Could not load private payroll records.')); } });
    return () => request.abort();
  }, [staffId, revision]);
  useEffect(() => { reportUnsaved(dirty, busy); onWork(dirty, busy); return () => { reportUnsaved(false, false); onWork(false, false); }; }, [dirty, busy, reportUnsaved, onWork]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  async function operation(path: string, body: unknown, after?: (result: unknown) => void, refresh = true) {
    if (busy) return false; snapshotLoad.current?.abort(); setBusy(true); setError(''); setMessage('');
    try {
      const response = await axios.post<{ data: unknown }>(base + encodeURIComponent(staffId) + '/' + path, body);
      if (!mounted.current) return false;
      after?.(response.data.data); setDirty(false);
      if (refresh) {
        try {
          const latest = await axios.get<{ data: Details }>(base + encodeURIComponent(staffId));
          if (mounted.current) { setData(latest.data.data); setPreview(null); setFormTurn(n => n + 1); setMessage('Saved.'); }
        } catch { if (mounted.current) { setData(null); setError('The change was saved, but the latest record could not be loaded. Retry payroll before making another change.'); } return false; }
      } else setMessage('Preview calculated.');
      return true;
    } catch (failure) { if (mounted.current) setError(authError(failure, 'Could not save the payroll change. Refresh and review the latest record.')); return false; }
    finally { if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>, action: (fields: FormData) => void) { event.preventDefault(); action(new FormData(event.currentTarget)); }
  function clearResults() { snapshotLoad.current?.abort(); setPreview(null); setSnapshot(null); }
  function choose(next: string, date = '') {
    if (next === tab && !date) return;
    if (busy || dirty && !window.confirm('Discard the unsaved payroll form changes?')) return;
    snapshotLoad.current?.abort(); setTab(next); setTargetDay(date); setDirty(false); setFormTurn(n => n + 1);
    const incomplete = next === 'time' && data?.ledger.days.some(day => day.date === date && day.incomplete);
    setCorrection(incomplete && data ? data.ledger.sessions.find(session => !session.voided && !session.end && today(data.ledger.timeZone, new Date(session.start)) <= date) || null : null);
  }
  function openSnapshot(id: string) {
    if (busy || dirty) return;
    snapshotLoad.current?.abort(); const request = new AbortController(); snapshotLoad.current = request;
    void axios.get<{ data: { preview: Preview; sourceChanged: boolean } }>(base + encodeURIComponent(staffId) + '/snapshots/' + encodeURIComponent(id), { signal: request.signal }).then(response => {
      if (mounted.current && !request.signal.aborted) { setSnapshot(response.data.data); setPreview(null); }
    }).catch(failure => { if (mounted.current && !request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure, 'Could not open the calculation snapshot.')); });
  }
  async function saveCalculation() {
    if (!preview || busy || dirty) return; const saved = preview;
    if (await operation('snapshots', { start: saved.start, end: saved.end, fingerprint: saved.fingerprint, requestId: snapshotRequest.current }) && mounted.current) {
      setSnapshot({ sourceChanged: false, preview: saved }); setMessage('Calculation saved. Gross pay is shown below.');
    }
  }
  async function download(documentId: string, revision: number, filename: string) {
    setError('');
    try {
      const response = await axios.get(base + encodeURIComponent(staffId) + '/documents/' + encodeURIComponent(documentId) + '/' + revision, { responseType: 'blob' });
      if (!mounted.current) return; const url = URL.createObjectURL(response.data); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (mounted.current) setError(authError(failure, 'Could not download this private revision.')); }
  }
  if (!data) return <section>{error ? <p role="alert">{error}</p> : <p role="status">Loading private payroll records…</p>}<button onClick={() => { setError(''); setRevision(n => n + 1); }}>Retry payroll</button></section>;
  const profile = data.profile; const ledger = data.ledger;
  const field = (label: string, name: string, initial = '', type = 'text', required = false) => <label>{label}<input name={name} type={type} defaultValue={initial} required={required} step={type === 'number' ? 'any' : undefined} maxLength={type === 'text' ? 2000 : undefined} /></label>;
  const renderPreview = (result: Preview) => <><p>{result.start}–{result.end} · {result.timeZone} · {result.workedDays} worked days · {hours(result.approvedMillis)} approved hours</p>
    <h3>{result.canFinalize ? 'Gross pay before taxes' : 'Estimated subtotal'}: {money(result.grossCents, result.currency || 'USD')}</h3>
    <p>Gross only. Payment has not been executed. Taxes and withholding are not calculated.</p>
    {result.blockers.length > 0 && <div role="alert"><strong>Resolve before finalizing</strong><ul>{result.blockers.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
    <div className="payroll-calculation-days">{result.rows.map(row => <article className="payroll-calculation-day" key={row.date}><h3>{row.date}</h3><dl className="payroll-grid"><div><dt>Clocked hours</dt><dd>{hours(row.rawMillis)}</dd></div><div><dt>Approved hours</dt><dd>{row.approval?.status === 'approved' ? hours(row.approval.regularMillis + row.approval.overtimeMillis + row.approval.doubleMillis) : 'Not approved'}</dd></div><div><dt>Hourly rate</dt><dd>{row.rate ? money(row.rate.cents, row.rate.currency) : 'Missing'}</dd></div><div><dt>Gross pay</dt><dd>{money(row.grossCents, row.rate?.currency || 'USD')}</dd></div></dl></article>)}</div></>;
  return <><section><h2>{data.staff.name}</h2><p>{data.staff.active ? 'Active employee' : 'Inactive employee — records retained'}</p>
    {data.missingDocuments.length > 0 && <p className="payroll-note">Missing payroll documents: {data.missingDocuments.join(', ')}</p>}
    <nav className="payroll-menu" aria-label="Payroll sections"><button className="payroll-primary" disabled={busy} aria-pressed={tab === 'pay'} onClick={() => choose('pay')}>Calculate pay</button>
      <details open={tab !== 'pay'}><summary>Employee setup &amp; records</summary><div className="payroll-actions">{[['profile','Private profile'],['rates','Hourly rates'],['time','Time & approvals'],['documents','Payroll documents']].map(([id,label]) => <button key={id} disabled={busy} aria-pressed={tab === id} onClick={() => choose(id)}>{label}</button>)}</div></details></nav>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>
  <section key={tab + ':' + (tab === 'pay' ? 'guided' : formTurn)} onChange={() => { if (tab !== 'pay') setDirty(true); }}>
    {tab === 'profile' && <form onSubmit={event => submit(event, fields => {
      const body: Record<string, unknown> = { version: profile.version, reason: value(fields,'reason'), legalName: value(fields,'legalName'), paymentMethod: value(fields,'paymentMethod'), payFrequency: value(fields,'payFrequency'), providerReference: value(fields,'providerReference'), instructions: value(fields,'instructions'), requiredDocuments: value(fields,'requiredDocuments').split('\n').map(s => s.trim()).filter(Boolean), rules: { mode: value(fields,'mode'), workweekStart: Number(value(fields,'workweekStart')), dailyScheduledMinutes: profile.rules.dailyScheduledMinutes, confirmed: fields.has('confirmed'), reference: value(fields,'reference') } };
      for (const key of ['taxId','bankAccount','routingNumber']) { if (fields.has('clear-' + key)) body[key] = null; else if (value(fields,key)) body[key] = value(fields,key); }
      void operation('profile', body);
    })}><fieldset disabled={busy}><h2>Private pay and tax profile</h2>
      {field('Legal employee name','legalName',profile.legalName)}<div className="payroll-grid"><label>Payment method<select name="paymentMethod" defaultValue={profile.paymentMethod}>{['provider','cash','check','direct-deposit'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Pay frequency<select name="payFrequency" defaultValue={profile.payFrequency}>{['weekly','biweekly','semimonthly','monthly'].map(v => <option key={v}>{v}</option>)}</select></label></div>
      {field('Employee ID in payroll service (optional)','providerReference',profile.providerReference)}<p className="ska-muted">The employee ID used by your payroll provider, such as ADP or Gusto. Leave blank if you do not use one.</p>{field('Payday notes (optional)','instructions',profile.instructions)}<p className="ska-muted">For example: Paid every other Friday.</p>
      <p>Private identifiers are masked. Leave replacements blank to keep stored values.</p>
      {(['taxId','bankAccount','routingNumber'] as const).map(key => <div key={key}><label>{key === 'taxId' ? 'Employee SSN (optional)' : key === 'bankAccount' ? 'Bank account' : 'Routing number'}<input name={key} autoComplete="off" type="password" maxLength={100} placeholder={profile[key] || 'Not stored'} /></label><label className="payroll-check"><input name={'clear-' + key} type="checkbox" />Clear stored {key === 'taxId' ? 'tax identifier' : key === 'bankAccount' ? 'bank account' : 'routing number'}</label></div>)}
      <label>Required payroll document names, one per line<textarea name="requiredDocuments" defaultValue={profile.requiredDocuments.join('\n')} /></label>
      <p>Set approved start/end times and review clocked time in <Link to="/staff/work-time" className="ska-link">Work time</Link>.</p><details ref={policyPanel}><summary>Advanced payroll settings</summary><h3>Payroll policy review</h3><p>Scheduled time is a planning reference, never an automatic cap. Workdays run midnight to midnight in the facility time zone; choose Other rules if your defined workday differs. Check-in and checkout times are retained without automatic rounding or deductions. Administrators review actual work, daily/weekly/seventh-day overtime and any premium or adjustment.</p>
      <label>Rule set<select name="mode" defaultValue={profile.rules.mode}><option value="ca-standard">California standard non-exempt review</option><option value="external-review">Other rules — payroll provider review required</option></select></label>
      <div className="payroll-grid"><label>Workweek starts<select name="workweekStart" defaultValue={profile.rules.workweekStart}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,i) => <option key={day} value={i}>{day}</option>)}</select></label></div>
      <label>Payroll policy review notes<textarea name="reference" defaultValue={profile.rules.reference} /></label>
      <label className="payroll-check"><input name="confirmed" type="checkbox" defaultChecked={profile.rules.confirmed} />The applicable classification, workweek, overtime, premiums and adjustments have been reviewed.</label><p className="ska-muted">Set up once with your payroll provider or the person who handles payroll. Note who checked these settings and which policy was used.</p></details>
      {field('Reason for profile change','reason','','text',true)}<button>Save private profile</button>
    </fieldset></form>}
    {tab === 'rates' && <><h2>Effective hourly rates</h2><p>A new rate or correction is appended. Earlier finalized pay snapshots remain unchanged.</p><ul>{profile.rates.map(rate => <li key={rate.id}>{rate.effectiveOn} · {money(rate.cents,rate.currency)}/hour · {rate.reason}</li>)}</ul>
      <form onSubmit={event => submit(event, fields => void operation('rates', { version: profile.version, effectiveOn: value(fields,'effectiveOn'), cents: Math.round(Number(value(fields,'rate')) * 100), currency: value(fields,'currency').toUpperCase(), reason: value(fields,'reason') }))}><fieldset disabled={busy}>
        <div className="payroll-grid">{field('Effective date','effectiveOn',targetDay || today(ledger.timeZone),'date',true)}{field('Hourly rate','rate','','number',true)}</div>{field('Currency','currency','USD','text',true)}{field('Reason / correction explanation','reason','','text',true)}<button>Add effective rate</button>
      </fieldset></form></>}
    {tab === 'time' && <><h2>Work time and daily approvals</h2><p>{ledger.timeZone}. Clocked and approved hours are separate. Missing checkout is unresolved time, never zero pay.</p>
      {ledger.days.map(day => <details key={day.date} className="payroll-workday" data-payroll-date={day.date} ref={node => { if (node) dayPanels.current.set(day.date, node); else dayPanels.current.delete(day.date); }}><summary>{day.date} · {hours(day.rawMillis)} clocked hours · {hours(day.paidMillis)} paid hours · {day.approval?.status || 'Not approved'}{day.incomplete ? ' · INCOMPLETE' : ''}</summary>
        <form onSubmit={event => submit(event, fields => void operation('approvals', { version: ledger.version, date: day.date, status: value(fields,'status'), regularMillis: asMillis(fields,'regular'), overtimeMillis: asMillis(fields,'overtime'), doubleMillis: asMillis(fields,'double'), adjustmentCents: Math.round(Number(value(fields,'adjustment')) * 100), rulesReviewed: fields.has('reviewed'), reason: value(fields,'reason') }))}><fieldset disabled={busy}>
          <div className="payroll-grid">{field('Regular paid hours','regular',String((day.approval?.regularMillis ?? day.paidMillis)/3600000),'number',true)}{field('Overtime hours at 1.5×','overtime',String((day.approval?.overtimeMillis ?? 0)/3600000),'number',true)}{field('Double-time hours','double',String((day.approval?.doubleMillis ?? 0)/3600000),'number',true)}{field('Premium / adjustment amount','adjustment',String((day.approval?.adjustmentCents ?? 0)/100),'number',true)}</div>
          <label>Decision<select name="status"><option value="approved">Approve paid hours</option><option value="returned">Return for correction</option></select></label><label className="payroll-check"><input name="reviewed" type="checkbox" defaultChecked={day.approval?.rulesReviewed} />I reviewed actual work, overtime and adjustments for this date.</label>
          {field('Approval / return reason, including any difference from clocked time','reason',day.approval?.reason || '','text',true)}<button>Save daily decision</button>
        </fieldset></form>
      </details>)}
      <h3>Original sessions and corrections</h3><ul>{[...ledger.sessions].reverse().map(session => <li key={session.id}>{localTime(session.start,ledger.timeZone)} → {localTime(session.end,ledger.timeZone)}{session.voided ? ' · Voided' : ''}<button disabled={busy} onClick={() => setCorrection(session)}>Correct this session</button></li>)}</ul>
      {correction && <form key={correction.id} ref={correctionPanel} onSubmit={event => submit(event, fields => void operation('corrections', { version: ledger.version, sessionId: correction.id, start: value(fields,'start'), end: value(fields,'end') || null, voided: fields.has('voided'), reason: value(fields,'reason') }, () => setCorrection(null)))}><fieldset disabled={busy}><h3>Correct recorded times</h3><p>Use full ISO timestamps with Z or a UTC offset. Original clock values and the reason remain in history. Changed paid time requires renewed approval.</p>{field('Corrected start (ISO timestamp)','start',correction.start,'text',true)}{field('Corrected checkout (blank if open)','end',correction.end || '')}
        <label className="payroll-check"><input type="checkbox" name="voided" defaultChecked={correction.voided} />Void this erroneous session, preserving history</label>{field('Correction reason','reason','','text',true)}<button>Save time correction</button><button type="button" onClick={() => setCorrection(null)}>Cancel correction</button></fieldset></form>}
      <details><summary>Attributed change history</summary><ul>{ledger.history.map((event,i) => <li key={i}>{event.type} · {event.at || ''} · {event.actorId || ''} · {event.reason || ''}<details><summary>Record details</summary><pre>{JSON.stringify(event,null,2)}</pre></details></li>)}</ul></details>
    </>}
    {tab === 'pay' && <>
      <PayCalculation data={data} busy={busy} dirty={dirty} onDirty={next => { setDirty(next); if (next) clearResults(); }} onPeriodChange={clearResults} onSection={choose}
        onSave={(path, body) => operation(path, body)} onCalculate={period => { snapshotRequest.current = payrollRequestId(); clearResults(); void operation('preview', period, result => setPreview(result as Preview), false); }} />
      <div ref={resultPanel} className="payroll-result">{preview && <>{renderPreview(preview)}<button disabled={busy || dirty || !preview.canFinalize} onClick={() => void saveCalculation()}>Save calculation</button></>}
      {snapshot && <>{snapshot.sourceChanged && <p role="alert">Source records changed after this snapshot. This historical calculation is retained unchanged; review a correction with your payroll provider.</p>}{renderPreview(snapshot.preview)}</>}
      </div>
      <h3>Saved calculation snapshots</h3><ul>{data.snapshots.map(row => <li key={row.id}>{row.start}–{row.end} · {money(row.grossCents,row.currency)} · {row.at}<button disabled={busy || dirty} onClick={() => openSnapshot(row.id)}>Open calculation snapshot</button></li>)}</ul>
    </>}
    {tab === 'documents' && <><h2>Private payroll documents</h2><p>PDF, PNG or JPG, up to 5 MB each. Revisions are retained. Downloads are authorized and audited; files stay out of the app’s offline cache.</p>
      <form onSubmit={event => submit(event, fields => {
        const file = fields.get('file') as File; if (!file?.size || file.size > 5*1024*1024) { setError('Choose a file up to 5 MB.'); return; }
        setBusy(true); setError(''); void readFile(file).then(dataBase64 => { if (mounted.current) { setBusy(false); void operation('documents',{ ...(value(fields,'documentId') ? { id: value(fields,'documentId') } : {}), version: data.documents.find(d => d.id === value(fields,'documentId'))?.version || 0, title: value(fields,'title'), category: value(fields,'category'), documentDate: value(fields,'documentDate'), reason: value(fields,'reason'), file: { name: file.name, contentType: file.type, dataBase64 } }); } }).catch(() => { if (mounted.current) { setBusy(false); setError('Could not read this file.'); } });
      })}><fieldset disabled={busy}><label>New document or revision<select name="documentId"><option value="">New document</option>{data.documents.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>{field('Document title','title','','text',true)}{field('Category (for example tax, employment, payment)','category','tax','text',true)}{field('Document date','documentDate',today(ledger.timeZone),'date',true)}<label>Private file<input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required /></label>{field('Upload / revision reason','reason','','text',true)}<button>Upload private payroll document</button></fieldset></form>
      <ul>{data.documents.map(document => <li key={document.id}><h3>{document.title} · {document.category}</h3>{document.revisions.map(r => <p key={r.revision}>Revision {r.revision} · {r.documentDate} · {r.filename} <button onClick={() => void download(document.id,r.revision,r.filename)}>Download revision {r.revision} of {document.title}</button></p>)}</li>)}</ul>
    </>}
  </section></>;
}
export default function Payroll() {
  const { account } = useAuth(); const work = useRef({ dirty: false, busy: false }); const onWork = useCallback((dirty: boolean, busy: boolean) => { work.current = { dirty, busy }; }, []); const [staff, setStaff] = useState<StaffAccountOption[]>([]); const [selected, setSelected] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    if (account?.role !== 'admin') return; const request = new AbortController();
    void axios.get<{ data: StaffAccountOption[] }>(staffAccountOptionsUrl,{ signal: request.signal }).then(response => { if (!request.signal.aborted) setStaff(response.data.data); }).catch(failure => { if (!request.signal.aborted && !axios.isCancel(failure)) setError(authError(failure,'Could not load employees.')); });
    return () => request.abort();
  }, [account?.id, account?.role]);
  if (account?.role !== 'admin') return <p role="alert">Administrator payroll access is required.</p>;
  return <div className="payroll-page ska-core-page"><header><h1>Staff pay & time</h1><p>Calculate gross pay in three steps. Employee setup and detailed records are available below.</p></header>{error && <p role="alert">{error}</p>}
    <section><label>Payroll employee<select aria-label="Payroll employee" value={selected} onChange={event => { if (work.current.busy || work.current.dirty && !window.confirm('Discard the unsaved payroll form changes?')) return; setSelected(event.target.value); }}><option value="">Choose an employee</option>{staff.map(person => <option key={person.id} value={person.id}>{person.name}{person.active ? '' : ' · Inactive'}</option>)}</select></label></section>
    {selected && <StaffPayroll key={account.id + ':' + selected} staffId={selected} onWork={onWork} />}
  </div>;
}
