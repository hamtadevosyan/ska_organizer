import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera, Download, FileCheck2, Plus, RefreshCw, Upload } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../auth/context';
import { authError, onSessionExpired, onWorkAccessRequired } from '../auth/transport';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import { billingMoney, billingRequestId } from '../api/billing';
import { readDocumentFile, validateDocumentFile } from '../api/childDocuments';
import type { DocumentFile } from '../api/childDocuments';
import { cancelCcrcStatement, getCcrcStatement, getCcrcStatementContent, listCcrcStatements, postCcrcStatement, reopenCcrcStatement, saveCcrcReview, uploadCcrcStatement } from '../api/ccrcStatements';
import type { CcrcStatement, CcrcStatementSummary } from '../api/ccrcStatements';
import { signedStatementCents, statementChildSuggestions, statementIncludedCents, statementReviewDraft, statementReviewIssues, statementReviewPayload } from '../components/billing/ccrcStatementReview';
import type { StatementLineDraft, StatementReviewDraft } from '../components/billing/ccrcStatementReview';
import './billing.css';
import './ccrc-statements.css';

const PdfDocumentPreview = lazy(() => import('../components/children/PdfDocumentPreview'));
const cancelled = (failure: unknown) => axios.isCancel(failure) || failure instanceof DOMException && failure.name === 'AbortError';
const definitive = (failure: unknown) => axios.isAxiosError(failure) && failure.response && failure.response.status >= 400 && failure.response.status < 500 && failure.response.status !== 408;
type Mutation = { kind: 'review' | 'post' | 'cancel' | 'reopen'; body: Record<string, unknown> };

export default function CCRCStatements() {
  const { account, serverUnavailable } = useAuth();
  if (!account || account.role !== 'admin' || account.disabled || account.mustChangePassword) return <p role="alert">Administrator access is required to view CCRC statements.</p>;
  return <>{serverUnavailable && <p role="alert" className="billing-note">Connection interrupted. Your statement review is kept here; reconnect before saving.</p>}<StatementWorkspace key={account.id} /></>;
}

function StatementWorkspace() {
  const [params, setParams] = useSearchParams(), selected = params.get('statement') || '';
  const [items, setItems] = useState<CcrcStatementSummary[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [work, setWork] = useState({ dirty: false, busy: false });
  const [pending, setPending] = useState<{ file: DocumentFile; requestId: string } | null>(null);
  const [expired, setExpired] = useState(false);
  const report = useUnsavedChanges(), request = useRef<AbortController | null>(null), upload = useRef<AbortController | null>(null), alive = useRef(true), locked = useRef(false);
  const onWork = useCallback((dirty: boolean, working: boolean) => setWork({ dirty, busy: working }), []);
  const refresh = useCallback(async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try { const result = await listCcrcStatements(controller.signal); if (alive.current && !controller.signal.aborted) setItems(result.items); }
    catch (failure) { if (alive.current && !controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load CCRC statements. Try again.')); }
    finally { if (alive.current && !controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const redact = () => { alive.current = false; request.current?.abort(); upload.current?.abort(); setItems([]); setFile(null); setPending(null); setBusy(false); setWork({ dirty: false, busy: false }); report(false, false); setError(''); setExpired(true); };
    const off = onSessionExpired(redact), offWork = onWorkAccessRequired(redact);
    return () => { alive.current = false; request.current?.abort(); upload.current?.abort(); off(); offWork(); };
  }, [refresh, report]);
  const dirty = !!file || !!pending || work.dirty, working = busy || work.busy;
  useEffect(() => { report(dirty, working); return () => report(false, false); }, [dirty, working, report]);
  useEffect(() => { if (!dirty && !working) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, working]);
  function choose(id: string) {
    if (working || pending || dirty && !window.confirm('Discard the unsaved statement entries?')) return;
    setFile(null); setError(''); setWork({ dirty: false, busy: false });
    // The user has explicitly discarded this page's draft. Clear the shared
    // blocker synchronously before its internal URL change is evaluated.
    report(false, false); setParams(id ? { statement: id } : {});
  }
  function picked(value: File | undefined) {
    if (!value || working || pending) return;
    const issue = validateDocumentFile(value); setError(issue); setFile(issue ? null : value);
  }
  async function readAndUpload(operation?: { file: DocumentFile; requestId: string }) {
    if (locked.current || !alive.current || !operation && !file) return;
    locked.current = true; setBusy(true); setError(''); const controller = new AbortController(); upload.current = controller;
    let supplied = operation;
    try {
      if (!supplied) {
        const original = await readDocumentFile(file!, controller.signal);
        if (!alive.current || controller.signal.aborted) return;
        supplied = { file: original, requestId: billingRequestId() }; setPending(supplied);
      }
      const result = await uploadCcrcStatement(supplied.file, supplied.requestId, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setPending(null); setFile(null); setBusy(false);
      // A confirmed upload has no unsaved work. React state updates settle
      // after this callback, while the router consults its blocker immediately.
      report(false, false); setParams({ statement: result.id }); void refresh();
    } catch (failure) {
      if (!alive.current || controller.signal.aborted || cancelled(failure)) return;
      if (definitive(failure) || !supplied) { setPending(null); setError(authError(failure, failure instanceof Error ? failure.message : 'Could not read the statement. Choose it again.')); }
      else setError('The upload result could not be confirmed. Retry the same upload; its original file cannot create duplicate payments.');
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  if (expired) return null;
  return <div className="billing-page ccrc-page ska-core-page">
    <header className="billing-hero"><div><span className="billing-kicker"><FileCheck2 size={19} aria-hidden="true" />A clear record for every payment</span><h1>CCRC statements</h1><p>Upload, check the original, then register the reviewed payments.</p></div><Link to="/billing"><ArrowLeft size={17} aria-hidden="true" />Tuition &amp; payments</Link></header>
    {error && <p role="alert">{error}</p>}
    <section className="billing-panel"><div className="billing-card-head"><h2>{selected ? 'Saved statements' : 'Import CCRC statement'}</h2><button disabled={loading || working} onClick={() => void refresh()}><RefreshCw size={17} aria-hidden="true" />Refresh statements</button></div>
      <label>Statement<select value={selected} disabled={working || !!pending} onChange={event => choose(event.target.value)}><option value="">Upload a new statement</option>{items.map(item => <option key={item.id} value={item.id}>{item.statementReference || item.filename} · {item.status}</option>)}</select></label>
      {loading && <p role="status">Loading saved statements…</p>}
    </section>
    {!selected ? <section className="billing-panel" aria-label="Upload CCRC statement"><h2>1. Choose the original</h2><p>PDF, JPG or PNG, up to 5 MB. Text PDFs and scanned pages are read on this server. Nothing is sent to an external OCR service.</p><div className="billing-grid"><label><Upload size={18} aria-hidden="true" />Choose statement file<input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" disabled={busy || !!pending} onChange={event => picked(event.target.files?.[0])} /></label><label><Camera size={18} aria-hidden="true" />Take statement photo<input type="file" accept="image/jpeg,image/png" capture="environment" disabled={busy || !!pending} onChange={event => picked(event.target.files?.[0])} /></label></div>
      {file && <p>Selected: <strong>{file.name}</strong></p>}
      <p className="billing-note">The first step creates a private draft. Payments are recorded only after you check all pages, amounts and children and confirm registration.</p>
      {pending && !busy ? <button className="billing-primary" onClick={() => void readAndUpload(pending)}>Retry same upload</button> : <button className="billing-primary" disabled={!file || busy} onClick={() => void readAndUpload()}>{busy ? 'Reading statement…' : 'Read statement'}</button>}
      {busy && <button type="button" onClick={() => { upload.current?.abort(); setError('Reading stopped. Check saved statements or retry this same upload before choosing another file.'); }}>Stop reading</button>}{busy && <p role="status">Reading the statement locally. Scanned pages can take a little longer. No payments are being registered.</p>}
    </section> : <StatementEditor key={selected} id={selected} onWork={onWork} onChange={() => void refresh()} />}
  </div>;
}

function StatementEditor({ id, onWork, onChange }: { id: string; onWork: (dirty: boolean, busy: boolean) => void; onChange: () => void }) {
  const [data, setData] = useState<CcrcStatement | null>(null), [draft, setDraft] = useState<StatementReviewDraft | null>(null), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [pending, setPending] = useState<Mutation | null>(null), [confirmed, setConfirmed] = useState(false), [cancelReason, setCancelReason] = useState('');
  const alive = useRef(true), locked = useRef(false), request = useRef<AbortController | null>(null), write = useRef<AbortController | null>(null);
  const refresh = useCallback(async (keepDraft = false, refreshVersions = false) => {
    if (!alive.current) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; setLoading(true); setError('');
    try {
      const result = await getCcrcStatement(id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setData(result);
      if (refreshVersions) {
        setDraft(previous => {
          const next = keepDraft && previous ? previous : statementReviewDraft(result.review);
          return { ...next, sourceReviewed: false, lines: next.lines.map(line => ({ ...line, reviewed: false, billingVersion: result.children.find(child => child.id === line.childId)?.billingVersion || 0 })) };
        });
        setDirty(true); setMessage('Balances refreshed. Check the payment lines again, then save the review.');
      } else if (!keepDraft) { setDraft(statementReviewDraft(result.review)); setDirty(false); }
      setConfirmed(false);
    } catch (failure) { if (alive.current && !controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load this statement. Try again.')); }
    finally { if (alive.current && !controller.signal.aborted) setLoading(false); }
  }, [id]);
  useEffect(() => {
    alive.current = true; void refresh();
    const redact = () => { alive.current = false; request.current?.abort(); write.current?.abort(); setData(null); setDraft(null); setPending(null); setDirty(false); setBusy(false); onWork(false, false); setError(''); setMessage(''); };
    const off = onSessionExpired(redact), offWork = onWorkAccessRequired(redact);
    return () => { alive.current = false; request.current?.abort(); write.current?.abort(); off(); offWork(); };
  }, [refresh, onWork]);
  useEffect(() => { onWork(dirty || !!pending, busy); return () => onWork(false, false); }, [dirty, pending, busy, onWork]);
  function change<K extends keyof StatementReviewDraft>(key: K, value: StatementReviewDraft[K]) {
    setDraft(previous => previous ? { ...previous, [key]: value, ...(['statementReference', 'paymentReference', 'paymentDate', 'total'].includes(key) ? { sourceReviewed: false } : {}) } : null); setDirty(true); setConfirmed(false); setMessage('');
  }
  function lineChange(index: number, key: keyof StatementLineDraft, value: string | boolean | number) {
    setDraft(previous => previous ? { ...previous, sourceReviewed: false, lines: previous.lines.map((line, offset) => {
      if (offset !== index) return line;
      const next = { ...line, [key]: value, ...(key !== 'reviewed' ? { reviewed: false } : {}) };
      if (key === 'childId') { const child = data?.children.find(child => child.id === value); next.childName = child?.name || ''; next.billingVersion = child?.billingVersion || 0; }
      return next;
    }) } : null); setDirty(true); setConfirmed(false); setMessage('');
  }
  async function mutate(operation: Mutation) {
    if (!data || locked.current || !alive.current) return;
    locked.current = true; setBusy(true); setPending(operation); setError(''); setMessage(''); const controller = new AbortController(); write.current = controller;
    try {
      const method = operation.kind === 'review' ? saveCcrcReview : operation.kind === 'post' ? postCcrcStatement : operation.kind === 'cancel' ? cancelCcrcStatement : reopenCcrcStatement;
      const result = await method(id, operation.body, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setData(result); setDraft(statementReviewDraft(result.review)); setDirty(false); setPending(null); setConfirmed(false); setCancelReason('');
      setMessage(operation.kind === 'post' ? 'Payments registered. The child ledgers are updated.' : operation.kind === 'review' ? 'Review saved. No payments have been registered.' : operation.kind === 'cancel' ? 'Draft cancelled. No payments were registered.' : 'Draft reopened for review.'); onChange();
    } catch (failure) {
      if (!alive.current || controller.signal.aborted || cancelled(failure)) return;
      if (definitive(failure)) { setPending(null); setError(authError(failure, 'Could not save this statement. Check the review and try again.')); }
      else setError('The save result could not be confirmed. Your review is kept. Retry this same save before entering another payment.');
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function save(event: FormEvent) { event.preventDefault(); if (data && draft) void mutate({ kind: 'review', body: { version: data.version, requestId: billingRequestId(), review: statementReviewPayload(draft) } }); }
  if (!alive.current) return null;
  if (!data || !draft) return <section className="billing-panel">{error && <p role="alert">{error}</p>}{loading && <p role="status">Loading private statement…</p>}<button disabled={loading} onClick={() => void refresh()}>Retry statement</button></section>;
  const readOnly = data.status !== 'draft', disabled = busy || !!pending || loading || readOnly;
  const pages = Number(draft.pageCount) >= 1 && Number(draft.pageCount) <= 12 ? Array.from({ length: Number(draft.pageCount) }, (_, index) => index + 1) : [];
  const issues = statementReviewIssues(draft, data), included = statementIncludedCents(draft), includedCount = draft.lines.filter(line => line.action === 'payment').length;
  return <>
    <section className="billing-panel"><div className="billing-card-head"><div><h2>{data.filename}</h2><span className="billing-status">{data.status === 'posted' ? 'Registered' : data.status === 'cancelled' ? 'Cancelled draft' : 'Private draft'}</span></div><button disabled={busy || !!pending || loading} onClick={() => void refresh(dirty, data.status === 'draft')}>{data.status === 'draft' ? 'Refresh balances for review' : 'Refresh statement'}</button></div><p className="billing-muted">Version {data.version} · {data.timeZone}</p><StatementSource id={id} filename={data.filename} contentType={data.contentType} disabled={busy} />
      {!!data.extraction.warnings.length && <div className="billing-note"><strong>Check the original carefully</strong><ul>{data.extraction.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul><p>You can correct or enter payment lines manually below. An unreadable field is never assumed to be a payment.</p></div>}
    </section>
    {error && <p role="alert">{error}</p>}{message && <p role="status" className="billing-success">{message}</p>}
    {pending && !busy && <div className="billing-note"><p>This save needs confirmation. Retry reuses the same request, so payments cannot be registered twice.</p><button className="billing-primary" onClick={() => void mutate(pending)}>Retry same save</button></div>}
    {!!data.duplicateWarnings.length && <section className="billing-panel" aria-label="Duplicate payment checks"><h2>Check for duplicate payments</h2>{data.duplicateWarnings.map((warning, index) => <p className="billing-note" key={index}>{warning.message} {warning.statementId ? <Link to={'/billing/ccrc-statements?statement=' + encodeURIComponent(warning.statementId)}>Open earlier statement</Link> : <Link to="/billing">Review existing child payments</Link>}</p>)}</section>}
    <form aria-label="Review CCRC statement" onSubmit={save}>
      <fieldset disabled={disabled}>
        <section className="billing-panel"><h2>2. Check the statement</h2><div className="billing-grid">
          <label>Statement reference<input value={draft.statementReference} maxLength={160} onChange={event => change('statementReference', event.target.value)} /></label><label>Payment reference<input value={draft.paymentReference} maxLength={160} onChange={event => change('paymentReference', event.target.value)} /></label>
          <label>Payment date<input type="date" value={draft.paymentDate} max={data.today} onChange={event => change('paymentDate', event.target.value)} /></label><label>Statement total ($)<input inputMode="decimal" value={draft.total} maxLength={14} onChange={event => change('total', event.target.value)} /></label>
          <label>Number of pages<input type="number" min="1" max="12" step="1" readOnly={data.extraction.pageCount !== null} value={draft.pageCount} onChange={event => { change('pageCount', event.target.value); change('pagesReviewed', []); }} /></label>
        </div><p className="billing-muted">Use the payment date printed on the statement. Choose each child’s month of care separately below.</p>
          <div className="ccrc-source-pages">{pages.map(page => {
            const source = data.extraction.pages.find(value => value.number === page);
            return <section className="ccrc-source-page" key={page}><details><summary>Recognized text · page {page}{source?.method === 'unreadable' ? ' · Needs manual review' : ''}</summary><pre>{source?.text || 'No readable text was extracted. Compare this page in the original file and enter its payment lines manually.'}</pre>{source?.warnings.map((warning, index) => <p className="billing-note" key={index}>{warning}</p>)}</details><label className="billing-check"><input type="checkbox" checked={draft.pagesReviewed.includes(page)} onChange={event => change('pagesReviewed', event.target.checked ? [...draft.pagesReviewed, page] : draft.pagesReviewed.filter(value => value !== page))} />I checked page {page} of the original statement.</label></section>;
          })}</div>
        </section>
        <section className="billing-panel"><h2>3. Review the payment lines</h2><p>Match every line to the original. Child-name matches are suggestions; select the correct child yourself.</p>
          {!draft.lines.length && <p className="billing-note">No payment rows were recognized. Add each payment from the original and explain the manual entry in the reconciliation note.</p>}
          <div className="billing-list">{draft.lines.map((line, index) => {
            const candidate = data.extraction.lines.find(value => value.id === line.id), suggestions = statementChildSuggestions(candidate, data.children), child = data.children.find(value => value.id === line.childId), noCharge = !!child && !child.charges.some(charge => charge.month === line.serviceMonth && charge.settlementMode === 'ccrc_actual');
            return <article className="ccrc-payment-line" key={line.id} aria-label={'Statement payment line ' + (index + 1)}><div className="billing-card-head"><h3>Line {index + 1}</h3><span className="billing-status">{line.action === 'exclude' ? 'Excluded from registration' : 'Payment to review'}</span></div>
              {candidate && <><p className="billing-muted">Recognized child: {candidate.childName || 'Not recognized'}{candidate.childReference ? ' · ' + candidate.childReference : ''}</p>{suggestions.length === 1 && <p className="ccrc-match-hint">Suggested match: <strong>{suggestions[0].name}</strong>. Check the child before selecting.</p>}{suggestions.length > 1 && <p className="billing-note">{suggestions.length} children match this name. Check the source and child ID before selecting.</p>}{candidate.warnings.map((warning, offset) => <p className="billing-note" key={offset}>{warning}</p>)}</>}
              <div className="billing-grid"><label>Line {index + 1} action<select value={line.action} onChange={event => lineChange(index, 'action', event.target.value)}><option value="payment">Register payment</option><option value="exclude">Exclude this line</option></select></label><label>Line {index + 1} source page<select value={line.page} onChange={event => lineChange(index, 'page', Number(event.target.value))}>{pages.map(page => <option key={page} value={page}>Page {page}</option>)}</select></label></div>
              <label>Line {index + 1} source excerpt<textarea value={line.excerpt} maxLength={1000} onChange={event => lineChange(index, 'excerpt', event.target.value)} /></label>
              {line.action === 'payment' && <><div className="billing-grid"><label>Line {index + 1} child<select value={line.childId} onChange={event => lineChange(index, 'childId', event.target.value)}><option value="">Choose the correct child</option>{data.children.map(child => <option key={child.id} value={child.id}>{suggestions.some(match => match.id === child.id) ? 'Suggested · ' : ''}{child.name}{child.active ? '' : ' (inactive)'}{data.children.some(other => other.id !== child.id && other.name === child.name) ? ' · ID ' + child.id : ''}</option>)}</select></label><label>Line {index + 1} service month<input type="month" value={line.serviceMonth} onChange={event => lineChange(index, 'serviceMonth', event.target.value)} /></label><label>Line {index + 1} amount paid ($)<input inputMode="decimal" value={line.amount} maxLength={14} onChange={event => lineChange(index, 'amount', event.target.value)} /></label><label>Line {index + 1} voucher or line reference (optional)<input value={line.entryReference || ''} maxLength={160} onChange={event => lineChange(index, 'entryReference', event.target.value)} /></label></div>
                {(!!line.paymentDate && line.paymentDate !== draft.paymentDate || !!line.paymentReference && line.paymentReference !== draft.paymentReference) && <p className="billing-note">Different receipt for this line: {line.paymentDate || draft.paymentDate || 'Date not entered'} · {line.paymentReference || draft.paymentReference || 'Reference not entered'}</p>}<details><summary>Different payment date or reference for this line</summary><div className="billing-grid"><label>Line {index + 1} payment date (optional)<input type="date" max={data.today} value={line.paymentDate || ''} onChange={event => lineChange(index, 'paymentDate', event.target.value)} /></label><label>Line {index + 1} payment reference (optional)<input value={line.paymentReference || ''} maxLength={160} onChange={event => lineChange(index, 'paymentReference', event.target.value)} /></label></div><p className="billing-muted">Leave blank to use the statement’s payment date and reference above. Keep separate checks or vouchers distinct.</p></details>{noCharge && <div className="billing-note"><p>No CCRC tuition charge is saved for this child and service month. <Link to={'/billing?child=' + encodeURIComponent(line.childId)}>Open child tuition</Link> to set it up, or keep this receipt as unapplied credit.</p><label className="billing-check"><input type="checkbox" checked={line.allowUnappliedCredit} onChange={event => lineChange(index, 'allowUnappliedCredit', event.target.checked)} />Record line {index + 1} as unapplied CCRC credit.</label><p>The parent balance cannot be calculated until this credit is applied to a tuition charge.</p></div>}
                {signedStatementCents(line.amount) !== null && signedStatementCents(line.amount)! <= 0 && <p className="billing-note">A negative adjustment is not a new payment. Reconcile it against the original or exclude it with a note.</p>}
              </>}
              <label>Line {index + 1} note{line.action === 'exclude' || line.allowUnappliedCredit ? ' (required)' : ' (optional)'}<textarea value={line.note} maxLength={1000} onChange={event => lineChange(index, 'note', event.target.value)} /></label><label className="billing-check"><input type="checkbox" checked={line.reviewed} onChange={event => lineChange(index, 'reviewed', event.target.checked)} />I checked line {index + 1} against the original.</label>
            </article>;
          })}</div>
          <button type="button" onClick={() => { change('lines', [...draft.lines, { id: billingRequestId(), page: 1, excerpt: '', childId: '', childName: '', serviceMonth: '', amount: '', action: 'payment', note: '', reviewed: false, billingVersion: 0, allowUnappliedCredit: false, entryReference: '', paymentDate: '', paymentReference: '' }]); }}><Plus size={17} aria-hidden="true" />Add payment line</button>
        </section>
        <section className="billing-panel"><h2>4. Save your review</h2><dl className="billing-settlement"><div><dt>Included payment lines ({includedCount})</dt><dd>{billingMoney(included)}</dd></div><div><dt>Statement total</dt><dd>{draft.total ? billingMoney(signedStatementCents(draft.total) || 0) : 'Not entered'}</dd></div></dl>
          <label>Reconciliation note<textarea value={draft.reconciliationReason} maxLength={2000} onChange={event => change('reconciliationReason', event.target.value)} /></label><p className="billing-muted">Explain manual entries, amount corrections, adjustments, excluded lines or missing text. Excluded lines stay in this record.</p>
          {data.duplicateWarnings.some(warning => warning.kind === 'possible') && <label>Why this is a separate payment<textarea value={draft.duplicateReason} maxLength={2000} onChange={event => change('duplicateReason', event.target.value)} /></label>}
          <label className="billing-check"><input type="checkbox" checked={draft.sourceReviewed} onChange={event => change('sourceReviewed', event.target.checked)} />I compared all payment lines and totals with the original statement.</label>
          <button className="billing-primary" disabled={!dirty}>Save review</button><p className="billing-muted">You can save an incomplete review and return later. Saving does not register payments.</p>
        </section>
      </fieldset>
    </form>
    {data.status === 'draft' && <section className="billing-panel" aria-label="Register reviewed payments"><h2>5. Register payments</h2>
      {dirty ? <p className="billing-note">Save your latest review before registering payments.</p> : issues.length ? <details className="ccrc-issues" open><summary>{issues.length} {issues.length === 1 ? 'item needs' : 'items need'} review</summary><ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details> : <p className="billing-success">Ready to register {includedCount} reviewed {includedCount === 1 ? 'payment' : 'payments'} totaling {billingMoney(included)}.</p>}
      <label className="billing-check"><input type="checkbox" checked={confirmed} disabled={dirty || !!issues.length || busy || !!pending} onChange={event => setConfirmed(event.target.checked)} />I want to register these reviewed payments.</label><button className="billing-primary" disabled={dirty || !!issues.length || !confirmed || busy || !!pending || loading} onClick={() => void mutate({ kind: 'post', body: { version: data.version, requestId: billingRequestId() } })}>Confirm and register payments</button>
      <p className="billing-muted">This records the statement-reported payments, not bank settlement. Each month remains awaiting CCRC review until you decide all receipts for that month are complete in Tuition.</p>
      <details><summary>Cancel this draft</summary><label>Cancellation reason<input value={cancelReason} maxLength={1000} disabled={busy || !!pending} onChange={event => setCancelReason(event.target.value)} /></label><button disabled={!cancelReason.trim() || busy || !!pending} onClick={() => void mutate({ kind: 'cancel', body: { version: data.version, requestId: billingRequestId(), reason: cancelReason } })}>Cancel draft without payments</button></details>
    </section>}
    {data.status === 'cancelled' && <section className="billing-panel"><p>This draft is cancelled. Its original is retained and no payments were registered.</p><button disabled={busy || !!pending} onClick={() => void mutate({ kind: 'reopen', body: { version: data.version, requestId: billingRequestId() } })}>Reopen draft</button></section>}
    {data.status === 'posted' && <section className="billing-panel" aria-label="Registered statement payments"><h2>Registered payments</h2><p>The original statement and reviewed rows are retained. Correct an incorrectly recorded payment through its child’s payment history.</p><div className="billing-list">{data.postedPayments.map(payment => <article className="ccrc-payment-line" key={payment.paymentId}><h3>{payment.childName}</h3><p>Service month {payment.serviceMonth} · {billingMoney(payment.amountCents)}</p><p>{payment.remainingCents === null ? 'Unapplied CCRC credit. Set up tuition and apply it before reviewing the parent balance.' : 'Remaining tuition after this import: ' + billingMoney(payment.remainingCents) + (payment.awaitingCcrc ? ' · Awaiting CCRC review' : '')}</p><Link to={'/billing?child=' + encodeURIComponent(payment.childId)}>Review tuition for {payment.childName}</Link></article>)}</div></section>}
    {busy && <p role="status">{pending?.kind === 'post' ? 'Registering the reviewed payments…' : 'Saving statement review…'}</p>}
  </>;
}

function StatementSource({ id, filename, contentType, disabled }: { id: string; filename: string; contentType: string; disabled: boolean }) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), requests = useRef(new Set<AbortController>()), urls = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    const clear = () => { alive.current = false; requests.current.forEach(controller => controller.abort()); urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear(); setPreview(null); setError(''); };
    const off = onSessionExpired(clear), offWork = onWorkAccessRequired(clear);
    return () => { clear(); off(); offWork(); };
  }, [id]);
  async function open(download: boolean) {
    if (!alive.current || busy || disabled) return;
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError('');
    try {
      const response = await getCcrcStatementContent(id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      const blob = new Blob([response], { type: contentType });
      if (download) {
        const url = URL.createObjectURL(blob); urls.current.add(url); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => { if (urls.current.delete(url)) URL.revokeObjectURL(url); }, 1000);
      } else {
        if (preview?.url && urls.current.delete(preview.url)) URL.revokeObjectURL(preview.url);
        const url = contentType === 'application/pdf' ? '' : URL.createObjectURL(blob); if (url) urls.current.add(url); setPreview({ blob, url });
      }
    } catch (failure) { if (alive.current && !controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not open the private statement. Try again.')); }
    finally { requests.current.delete(controller); if (alive.current) setBusy(false); }
  }
  return <div className="ccrc-original"><div className="billing-actions"><button type="button" disabled={disabled || busy} onClick={() => void open(false)}>Preview original statement</button><button type="button" disabled={disabled || busy} onClick={() => void open(true)}><Download size={17} aria-hidden="true" />Download original</button>{preview && <button type="button" onClick={() => { if (preview.url && urls.current.delete(preview.url)) URL.revokeObjectURL(preview.url); setPreview(null); }}>Close original preview</button>}</div>{error && <p role="alert">{error}</p>}{busy && <p role="status">Opening the private original…</p>}{preview && <div className="ccrc-preview">{contentType === 'application/pdf' ? <Suspense fallback={<p>Loading PDF viewer…</p>}><PdfDocumentPreview blob={preview.blob} /></Suspense> : <img src={preview.url} alt="Original CCRC payment statement" />}<p className="billing-muted">Use Download original if the preview is incomplete or to open it in your device’s PDF viewer.</p></div>}</div>;
}
