import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Camera, ClipboardCheck, Download, FileText, History, Plus, Upload } from 'lucide-react';
import { useAuth } from '../../auth/context';
import { authError, onSessionExpired } from '../../auth/transport';
import { documentCategories, documentRequestId, readDocumentFile, validateDocumentFile } from '../../api/childDocuments';
import type { DocumentCategory } from '../../api/childDocuments';
import {
  addStaffDocument, getStaffChecklist, getStaffCompliance, getStaffComplianceSettings, getStaffDocument, getStaffDocumentContent,
  listStaffDocuments, reviewStaffDocument, reviseStaffDocument, staffComplianceLabels, updateStaffComplianceSettings, updateStaffDocument,
} from '../../api/staffDocuments';
import type {
  DocumentWork, StaffChecklist, StaffCompliance, StaffComplianceSettings, StaffDocument, StaffDocumentDetails,
  StaffDocumentMetadata, StaffDocumentRevision, StaffRequirement,
} from '../../api/staffDocuments';
import { useUnsavedChanges } from '../UnsavedChangesContext';
import { BlankFormActions } from '../registration/BlankFormActions';
import { analyzeStaffDocumentExpiration } from './staffDocumentExpiration';

const PdfDocumentPreview = lazy(() => import('../children/PdfDocumentPreview'));
const inputClass = 'mt-1 block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const cancelled = (failure: unknown) => axios.isCancel(failure) || failure instanceof DOMException && failure.name === 'AbortError';
const dateTime = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; };
const emptyMetadata = (): StaffDocumentMetadata => ({ title: '', category: 'other', documentDate: null, notes: '', issuer: '', reference: '',
  issuedOn: null, expiresOn: null, nonExpiring: false, warningDays: null, registrationFormId: null, registrationFormRevisionId: null });
const metadataOf = (document: StaffDocument): StaffDocumentMetadata => ({ ...emptyMetadata(), ...Object.fromEntries(Object.keys(emptyMetadata()).map(key => [key, document[key as keyof StaffDocumentMetadata]])) }) as StaffDocumentMetadata;
type Draft = { mode: 'new' | 'edit' | 'revise'; original: StaffDocument | null; metadata: StaffDocumentMetadata; changeNote: string };
type ExpirationReading = { status: 'idle' | 'reading' | 'ready' | 'unavailable'; candidates: { date: string; label: string }[]; incomplete: boolean };
const emptyReading = (): ExpirationReading => ({ status: 'idle', candidates: [], incomplete: false });
const reminderChoices = [7, 14, 30, 40, 60, 90];
function validDate(value: string | null) {
  if (!value) return true;
  const parsed = new Date(value + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '9999-12-31';
}

export function StaffDocuments({ staffId, employeeName, onWorkChange }: { staffId: string; employeeName: string; onWorkChange?: (work: DocumentWork) => void }) {
  const { account } = useAuth();
  if (!account || account.disabled || account.mustChangePassword || account.role === 'viewer') return null;
  return <StaffDocumentArea key={staffId + ':' + account.id + ':' + account.role} staffId={staffId} employeeName={employeeName} admin={account.role === 'admin'} onWorkChange={onWorkChange} />;
}

function StaffDocumentArea({ staffId, employeeName, admin, onWorkChange }: { staffId: string; employeeName: string; admin: boolean; onWorkChange?: (work: DocumentWork) => void }) {
  const [checklist, setChecklist] = useState<StaffChecklist | null>(null);
  const [alerts, setAlerts] = useState<StaffCompliance | null>(null);
  const [settings, setSettings] = useState<StaffComplianceSettings | null>(null);
  const [warningInput, setWarningInput] = useState('');
  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [total, setTotal] = useState(0); const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(''); const [details, setDetails] = useState<StaffDocumentDetails | null>(null);
  const [historyPage, setHistoryPage] = useState(1); const [detailLoading, setDetailLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null); const [file, setFile] = useState<File | null>(null);
  const [expirationReading, setExpirationReading] = useState<ExpirationReading>(emptyReading);
  const [fileSelection, setFileSelection] = useState(0); const [customReminder, setCustomReminder] = useState(false);
  const [cameraFile, setCameraFile] = useState(false); const [photoConfirmed, setPhotoConfirmed] = useState(false);
  const [filePreview, setFilePreview] = useState('');
  const [preview, setPreview] = useState<{ url: string; blob: Blob; revision: StaffDocumentRevision } | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false); const [versionConflict, setVersionConflict] = useState(false);
  const [busy, setBusy] = useState(false); const [contentBusy, setContentBusy] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [expired, setExpired] = useState(false);
  const alive = useRef(true); const requests = useRef(new Set<AbortController>()); const requestId = useRef('');
  const previewSequence = useRef(0); const downloads = useRef(new Set<string>()); const reportUnsaved = useUnsavedChanges();
  const expirationSequence = useRef(0); const expirationRequest = useRef<AbortController | null>(null);
  const acceptedExpiration = useRef<string | null>(null);
  const fileId = useId(); const photoId = useId(); const reminderId = useId(); const heading = useRef<HTMLHeadingElement>(null);
  const workCallback = useRef(onWorkChange); workCallback.current = onWorkChange;
  const warningDirty = !!settings && warningInput !== String(settings.warningDays);
  const warningDirtyRef = useRef(false); warningDirtyRef.current = warningDirty;
  const dirty = !!draft && (draft.mode === 'new' ? !!file || JSON.stringify(draft.metadata) !== JSON.stringify(emptyMetadata())
    : draft.mode === 'revise' ? !!file || !!draft.changeNote || JSON.stringify(draft.metadata) !== JSON.stringify(metadataOf(draft.original!))
      : JSON.stringify(draft.metadata) !== JSON.stringify(metadataOf(draft.original!))) || warningDirty;
  const requirements = checklist?.items.map(item => item.form) || [];
  const cameraAvailable = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { reportUnsaved(dirty, busy); workCallback.current?.({ dirty, busy }); }, [dirty, busy, reportUnsaved]);
  useEffect(() => () => { reportUnsaved(false, false); workCallback.current?.({ dirty: false, busy: false }); }, [reportUnsaved]);
  useEffect(() => {
    alive.current = true;
    const stop = () => { requests.current.forEach(controller => controller.abort()); requests.current.clear(); previewSequence.current++; expirationSequence.current++; expirationRequest.current = null; acceptedExpiration.current = null;
      downloads.current.forEach(url => URL.revokeObjectURL(url)); downloads.current.clear(); };
    const unsubscribe = onSessionExpired(() => { stop(); setExpired(true); setChecklist(null); setAlerts(null); setDocuments([]); setDetails(null); setDraft(null); setFile(null); setExpirationReading(emptyReading()); setPreview(null); setSettings(null); setWarningInput(''); setError(''); setMessage(''); setBusy(false); setContentBusy(false); });
    return () => { alive.current = false; stop(); unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!file) { setFilePreview(''); return; }
    const url = URL.createObjectURL(file); setFilePreview(url); return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!admin || !file || !photoConfirmed || expired) return;
    const controller = new AbortController(); const pending = requests.current; pending.add(controller); expirationRequest.current = controller;
    const sequence = ++expirationSequence.current; setExpirationReading({ ...emptyReading(), status: 'reading' });
    void analyzeStaffDocumentExpiration(staffId, file, controller.signal).then(result => {
      if (!controller.signal.aborted && alive.current && sequence === expirationSequence.current) setExpirationReading({ ...result, status: 'ready' });
    }).catch(failure => {
      if (!controller.signal.aborted && alive.current && sequence === expirationSequence.current && !cancelled(failure)) setExpirationReading({ ...emptyReading(), status: 'unavailable' });
    }).finally(() => { pending.delete(controller); if (expirationRequest.current === controller) expirationRequest.current = null; });
    return () => { controller.abort(); pending.delete(controller); if (expirationRequest.current === controller) expirationRequest.current = null; };
  }, [staffId, admin, file, fileSelection, photoConfirmed, expired]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => {
    if (expired || busy) return;
    const controller = new AbortController(); const pending = requests.current; pending.add(controller);
    setLoading(true); setChecklist(null); setAlerts(null);
    void (async () => {
      if (admin) {
        const [packet, list, configuration] = await Promise.all([getStaffChecklist(staffId, controller.signal), listStaffDocuments(staffId, page, controller.signal), getStaffComplianceSettings(controller.signal)]);
        if (controller.signal.aborted) return;
        setChecklist(packet); setDocuments(list.items); setTotal(list.total); setSettings(configuration);
        if (!warningDirtyRef.current) setWarningInput(String(configuration.warningDays));
        if (page > 1 && (page - 1) * 10 >= list.total) setPage(Math.max(1, Math.ceil(list.total / 10)));
      } else {
        const result = await getStaffCompliance(controller.signal);
        if (!controller.signal.aborted) setAlerts(result);
      }
    })().catch(failure => { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not check staff documents. Refresh to try again.')); })
      .finally(() => { pending.delete(controller); if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); pending.delete(controller); };
  }, [staffId, admin, page, refresh, expired, busy]);
  useEffect(() => {
    setDetails(null); setPreview(null); setReviewConfirmed(false); previewSequence.current++;
    if (!admin || !selectedId || expired || busy) return;
    const controller = new AbortController(); const pending = requests.current; pending.add(controller); setDetailLoading(true);
    void getStaffDocument(staffId, selectedId, historyPage, controller.signal).then(result => { if (!controller.signal.aborted) setDetails(result); })
      .catch(failure => { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load this document.')); })
      .finally(() => { pending.delete(controller); if (!controller.signal.aborted) setDetailLoading(false); });
    return () => { controller.abort(); pending.delete(controller); };
  }, [staffId, admin, selectedId, historyPage, refresh, expired, busy]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, busy]);
  function leaveDraft() { return !busy && (!dirty || window.confirm('Discard the unsaved staff document changes?')); }
  function stopExpirationReading() {
    expirationSequence.current++; expirationRequest.current?.abort();
    if (expirationRequest.current) requests.current.delete(expirationRequest.current);
    expirationRequest.current = null; setExpirationReading(emptyReading());
  }
  function clearFileExpiration() {
    const accepted = acceptedExpiration.current; acceptedExpiration.current = null;
    if (accepted) setDraft(previous => previous && previous.metadata.expiresOn === accepted ? { ...previous, metadata: { ...previous.metadata, expiresOn: null } } : previous);
  }
  function clearDraft() { stopExpirationReading(); acceptedExpiration.current = null; setDraft(null); setFile(null); setCameraFile(false); setPhotoConfirmed(false); setCustomReminder(false); setVersionConflict(false); requestId.current = ''; }
  function openDraft(mode: Draft['mode'], requirement?: StaffRequirement) {
    if (!leaveDraft() || mode !== 'new' && !details) return;
    clearDraft(); setError(''); setMessage(''); setPreview(null);
    const metadata = mode === 'new' ? emptyMetadata() : metadataOf(details!.document);
    if (mode === 'revise') { metadata.issuedOn = null; metadata.expiresOn = null; metadata.nonExpiring = false; }
    if (requirement) Object.assign(metadata, { title: requirement.title, category: requirement.category, registrationFormId: requirement.id, registrationFormRevisionId: requirement.currentRevisionId });
    setDraft({ mode, original: mode === 'new' ? null : details!.document, metadata, changeNote: '' });
  }
  function change<K extends keyof StaffDocumentMetadata>(key: K, value: StaffDocumentMetadata[K]) {
    if (key === 'expiresOn') acceptedExpiration.current = null;
    setDraft(previous => previous && ({ ...previous, metadata: { ...previous.metadata, [key]: value } })); requestId.current = ''; setError(''); setMessage('');
  }
  function chooseFile(selected: File | undefined, camera: boolean) {
    if (!selected) return;
    const invalid = validateDocumentFile(selected) || (camera && !/\.(png|jpe?g)$/i.test(selected.name) ? 'Choose a JPG or PNG photo.' : '');
    if (invalid) { setError(invalid); return; }
    stopExpirationReading(); clearFileExpiration(); setFile(selected); setFileSelection(value => value + 1); setCameraFile(camera); setPhotoConfirmed(!camera); requestId.current = ''; setError(''); setMessage('');
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!admin || !draft || busy || expired) return;
    const metadata = { ...draft.metadata, title: draft.metadata.title.trim(), notes: draft.metadata.notes.trim(), issuer: draft.metadata.issuer.trim(), reference: draft.metadata.reference.trim() };
    if (!metadata.title || metadata.title.length > 160) { setError('Enter a document title between 1 and 160 characters.'); return; }
    if (!validDate(metadata.issuedOn) || !validDate(metadata.expiresOn) || !validDate(metadata.documentDate)) { setError('Enter real dates from 1900 onward, or leave them empty.'); return; }
    if (metadata.issuedOn && metadata.expiresOn && metadata.expiresOn < metadata.issuedOn) { setError('Expiration date must be on or after the issued date.'); return; }
    if (metadata.nonExpiring && metadata.expiresOn) { setError('Clear the expiration date or turn off Does not expire.'); return; }
    if (metadata.nonExpiring && requirements.some(form => form.id === metadata.registrationFormId && form.expirationRequired)) { setError('This requirement needs an expiration date. Turn off Does not expire and enter its date.'); return; }
    if (metadata.warningDays !== null && (!Number.isInteger(metadata.warningDays) || metadata.warningDays < 1 || metadata.warningDays > 365)) { setError('Enter a reminder between 1 and 365 days, or leave it empty to use the default.'); return; }
    if (draft.mode !== 'edit' && !file) { setError('Choose a PDF, JPG or PNG file first.'); return; }
    if (cameraFile && !photoConfirmed) { setError('Check the photo and choose Confirm photo before saving.'); return; }
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    try {
      if (!requestId.current) requestId.current = documentRequestId();
      const result = draft.mode === 'edit' ? await updateStaffDocument(staffId, draft.original!, metadata, controller.signal)
        : draft.mode === 'new' ? await addStaffDocument(staffId, metadata, await readDocumentFile(file!, controller.signal), requestId.current, controller.signal)
          : await reviseStaffDocument(staffId, draft.original!, metadata, await readDocumentFile(file!, controller.signal), draft.changeNote.trim(), requestId.current, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setSelectedId(result.document.id); setHistoryPage(1); setPage(1); clearDraft(); setRefresh(value => value + 1);
      setMessage(draft.mode === 'new' ? 'Staff document saved. Check its dates and mark it reviewed.' : draft.mode === 'edit' ? 'Document details saved. Check this version and review it again.' : 'New version saved. Previous files and dates are kept. Review the renewed copy.');
    } catch (failure) {
      if (!controller.signal.aborted && !cancelled(failure)) { setError(authError(failure, 'Could not save this document. Your changes are still here.')); setVersionConflict(axios.isAxiosError(failure) && failure.response?.status === 409 && draft.mode !== 'new'); }
    } finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function loadLatest() {
    if (!draft?.original || busy || expired) return;
    const controller = new AbortController(); requests.current.add(controller); setBusy(true);
    try {
      const latest = await getStaffDocument(staffId, draft.original.id, 1, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setDraft(previous => previous && ({ ...previous, original: latest.document })); setDetails(latest); setVersionConflict(false); requestId.current = ''; setError(''); setMessage('Latest version loaded. Your draft is still here; check it before saving.');
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load the latest version.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function review(reviewed: boolean) {
    if (!admin || !details || busy || expired || reviewed && !reviewConfirmed) return;
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    try {
      await reviewStaffDocument(staffId, details.document, reviewed, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setReviewConfirmed(false); setRefresh(value => value + 1); setMessage(reviewed ? 'Staff document reviewed.' : 'Review cleared. This document needs review again.');
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure)) { setError(authError(failure, 'Could not save the review. Refresh and check the current copy.')); setRefresh(value => value + 1); } }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function content(revision: StaffDocumentRevision, download: boolean) {
    if (!admin || !details || contentBusy || expired) return;
    const id = details.document.id; const sequence = ++previewSequence.current;
    const controller = new AbortController(); requests.current.add(controller); setContentBusy(true); setError('');
    try {
      const blob = await getStaffDocumentContent(staffId, id, revision.id, download, controller.signal);
      if (controller.signal.aborted || !alive.current || sequence !== previewSequence.current) return;
      if (!download && revision.contentType === 'application/pdf') { setPreview({ url: '', blob, revision }); return; }
      const localUrl = URL.createObjectURL(new Blob([blob], { type: revision.contentType }));
      if (download) {
        const link = document.createElement('a'); link.href = localUrl; link.download = revision.filename; document.body.appendChild(link); link.click(); link.remove();
        downloads.current.add(localUrl); window.setTimeout(() => { if (downloads.current.delete(localUrl)) URL.revokeObjectURL(localUrl); }, 1000);
      } else setPreview({ url: localUrl, blob, revision });
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not open this file. Try again.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setContentBusy(false); }
  }
  async function saveReminder(event: FormEvent) {
    event.preventDefault(); if (!admin || !settings || busy || expired) return;
    const days = Number(warningInput);
    if (!Number.isInteger(days) || days < 1 || days > 365) { setError('Enter a default reminder between 1 and 365 days.'); return; }
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    try {
      const result = await updateStaffComplianceSettings(settings, days, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setSettings(result); setWarningInput(String(result.warningDays)); setRefresh(value => value + 1); setMessage('Reminder timing saved for all staff.');
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not save reminder timing. Refresh to load the current setting.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  if (expired) return null;
  const currentRequirement = requirements.find(item => item.id === draft?.metadata.registrationFormId);
  const reminderDays = draft?.metadata.warningDays ?? settings?.warningDays ?? 40;
  const reminderDate = draft?.metadata.expiresOn && !draft.metadata.nonExpiring && validDate(draft.metadata.expiresOn) && Number.isInteger(reminderDays) && reminderDays >= 1 && reminderDays <= 365
    ? new Date(Date.parse(draft.metadata.expiresOn + 'T00:00:00Z') - reminderDays * 86400000).toISOString().slice(0, 10) : null;
  const safeAlerts = alerts?.items.filter(item => item.staffId === staffId) || [];
  const required = checklist?.items.filter(item => item.form.required) || [];
  const complete = !!checklist && checklist.requiredTotal > 0 && checklist.complete && checklist.requiredTotal === required.length && checklist.requiredComplete === required.length && required.every(item => item.status === 'complete' || item.status === 'expiring');
  return <section aria-label="Staff documents and training" className="min-w-0 space-y-5 rounded-2xl border border-violet-100 bg-violet-50/40 p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 ref={heading} tabIndex={-1} className="break-words text-xl font-bold">{employeeName} · Documents &amp; training</h2><p className="mt-2 text-sm text-slate-600">Keep required forms, training and certificates current. Request a renewal before a document expires.</p></div>
      <button type="button" disabled={busy || loading} className="ska-button" onClick={() => { if (leaveDraft()) { clearDraft(); setWarningInput(settings ? String(settings.warningDays) : ''); setError(''); setPreview(null); setRefresh(value => value + 1); } }}>Refresh staff documents</button></header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-800">{message}</p>}
    {loading && <p role="status">Checking staff requirements…</p>}
    {!admin && alerts && <section aria-label="Employee requirements" className="min-w-0 space-y-3 rounded-2xl border border-blue-100 bg-blue-50 p-4">
      <h3 className="font-bold">Documents needing attention</h3><p className="text-sm text-slate-600">An administrator manages the confidential files. Use these reminders to request missing documents or renewed training.</p>
      {!alerts.configured ? <p>No required employee forms have been configured. An administrator needs to set up the requirements.</p> : !safeAlerts.length ? <p>No actionable document reminders for this staff member. Confidential files are available to administrators.</p> : safeAlerts.map(item => <article aria-label={item.requirementTitle} key={item.requirementId} className="min-w-0 rounded-xl border bg-white p-3"><h4 className="break-words font-bold">{item.requirementTitle}</h4><p className="mt-1 font-semibold text-amber-900">{staffComplianceLabels[item.status]}</p>{item.expiresOn && <p className="mt-1 text-sm">Expires {item.expiresOn}{item.daysRemaining !== null && item.daysRemaining >= 0 ? ' · ' + item.daysRemaining + ' days remaining' : ''}</p>}<p className="mt-2 text-sm text-slate-600">{item.status === 'expired' || item.status === 'expiring' ? 'Request renewed training or a current certificate from this staff member.' : 'Ask the administrator to complete this requirement.'}</p></article>)}
    </section>}
    {admin && <>
      {settings && <form aria-label="Staff reminder timing" onSubmit={event => void saveReminder(event)} className="min-w-0 space-y-3 rounded-xl border border-blue-100 bg-white p-4"><h3 className="font-bold">Renewal reminders</h3><p className="text-sm text-slate-600">Reminders appear here and on Home for administrators and editors. Individual certificates can use their own reminder period.</p><div className="flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1">Default reminder days<input type="number" min={1} max={365} step={1} value={warningInput} disabled={busy} onChange={event => { setWarningInput(event.target.value); setError(''); }} className={inputClass} /></label><button disabled={busy || warningInput === String(settings.warningDays)} className="ska-button">Save reminder timing</button></div></form>}
      {checklist && <section aria-label="Employee requirements" className="min-w-0 space-y-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-4"><h3 className="flex items-center gap-2 text-lg font-bold"><ClipboardCheck size={21} aria-hidden="true" />Employee requirements</h3>
        {!checklist.requiredTotal ? <div className="space-y-2 rounded-xl bg-white p-3"><p>No required employee forms have been configured. Completion cannot be verified.</p><a href="/registration-forms" className="font-semibold text-blue-800 underline">Set up employee document templates</a></div> : <p role="status" className={'rounded-xl p-3 font-semibold ' + (complete ? 'bg-emerald-50 text-emerald-800' : 'bg-white text-slate-800')}>{checklist.percentage}% complete · {checklist.requiredComplete} of {checklist.requiredTotal} required documents current{complete ? ' · Requirements satisfied' : ' · Needs attention'}</p>}
        {checklist.items.map(item => <article aria-label={item.form.title} key={item.form.id} className="min-w-0 space-y-3 rounded-xl border bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h4 className="break-words font-bold">{item.form.title}</h4><p className="mt-1 text-sm text-slate-600">{item.form.required ? 'Required' : 'Optional'}{item.form.expirationRequired ? ' · Expiration date required' : ''}</p></div><span className={'rounded-full px-3 py-1 text-sm font-semibold ' + (item.status === 'complete' ? 'bg-emerald-50 text-emerald-800' : item.status === 'expired' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900')}>{staffComplianceLabels[item.status]}</span></div>
          {item.form.instructions && <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{item.form.instructions}</p>}
          {item.expiresOn && <p className="text-sm">Expires {item.expiresOn}{item.daysRemaining !== null && item.daysRemaining >= 0 ? ' · ' + item.daysRemaining + ' days remaining' : ''}</p>}
          {(item.status === 'expired' || item.status === 'expiring') && <p className="text-sm text-amber-900">Request renewed training or a current certificate from this staff member.</p>}
          {item.status === 'expiry_missing' && <p className="text-sm text-amber-900">Enter the expiration date, or explicitly mark a document that does not expire.</p>}
          {item.status === 'outdated' && <p className="text-sm text-amber-900">The template changed. Attach a completed copy using the current blank version.</p>}
          {item.form.currentRevisionId && <BlankFormActions form={item.form} disabled={busy} />}
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} aria-label={'Attach completed ' + item.form.title} className="ska-button is-primary" onClick={() => openDraft('new', item.form)}><Upload size={17} aria-hidden="true" />Attach completed copy</button>{item.document && <button type="button" disabled={busy} aria-label={'Review completed ' + item.form.title} className="ska-button" onClick={() => { if (leaveDraft()) { clearDraft(); setSelectedId(item.document!.id); setHistoryPage(1); setError(''); } }}>Open completed copy</button>}</div>
        </article>)}
      </section>}
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 text-lg font-bold"><FileText size={21} className="text-violet-600" aria-hidden="true" />Saved documents</h3><button type="button" disabled={busy} className="ska-button is-primary" onClick={() => openDraft('new')}><Plus size={18} aria-hidden="true" />Add staff document</button></div>
      {versionConflict && draft && <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><p>This document changed elsewhere. Load its latest version and check your draft before saving.</p><button type="button" disabled={busy} className="ska-button" onClick={() => void loadLatest()}>Load latest document version</button></div>}
      {draft && <form aria-label={draft.mode === 'new' ? 'Add staff document' : draft.mode === 'edit' ? 'Edit staff document details' : 'Renew staff document'} onSubmit={event => void save(event)} noValidate className="min-w-0 space-y-4 rounded-2xl border bg-white p-4"><fieldset disabled={busy} className="min-w-0 space-y-4"><h4 className="break-words font-bold">{draft.mode === 'new' ? 'Add a staff document' : draft.mode === 'edit' ? 'Edit document details' : 'Upload a new version of ' + draft.original?.title}</h4>
        {draft.mode !== 'edit' && <><div className="space-y-3"><label htmlFor={fileId} className="block font-medium">Upload a staff document</label><input id={fileId} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={event => { chooseFile(event.target.files?.[0], false); event.target.value = ''; }} className="block w-full min-w-0 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-3 file:font-semibold file:text-blue-800" /><p className="text-sm text-slate-500">PDF, JPG or PNG · Up to 5 MB. Files stay on your local server.</p>
          {cameraAvailable && <label htmlFor={photoId} className="ska-button inline-flex cursor-pointer"><Camera size={18} aria-hidden="true" />{cameraFile ? 'Retake photo' : 'Take a photo'}<input id={photoId} type="file" accept="image/jpeg,image/png" capture="environment" onChange={event => { chooseFile(event.target.files?.[0], true); event.target.value = ''; }} className="sr-only" /></label>}</div>
          {file && <div className="min-w-0 space-y-3 rounded-xl border border-blue-100 bg-blue-50 p-3"><p className="break-words font-semibold">{file.name}</p>{filePreview && /\.(png|jpe?g)$/i.test(file.name) && <img src={filePreview} alt={cameraFile ? 'Captured staff document preview' : 'Selected staff document preview'} className="max-h-80 w-full rounded-xl object-contain" />}{cameraFile && !photoConfirmed && <button type="button" className="ska-button is-primary" onClick={() => { setPhotoConfirmed(true); setError(''); }}>Confirm photo</button>}<button type="button" className="ska-button" onClick={() => { stopExpirationReading(); clearFileExpiration(); setFile(null); setCameraFile(false); setPhotoConfirmed(false); requestId.current = ''; }}>Remove selected file</button></div>}
        </>}
        {draft.mode !== 'revise' && <><label className="block">Document title<input value={draft.metadata.title} maxLength={160} onChange={event => change('title', event.target.value)} className={inputClass} required /></label>
          <label className="block">Document category<select value={draft.metadata.category} onChange={event => change('category', event.target.value as DocumentCategory)} className={inputClass}>{Object.entries(documentCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {!draft.original?.registrationFormId && <label className="block">Employee requirement (optional)<select value={draft.metadata.registrationFormId || ''} onChange={event => { const requirement = requirements.find(item => item.id === event.target.value); setDraft({ ...draft, metadata: { ...draft.metadata, registrationFormId: requirement?.id || null, registrationFormRevisionId: requirement?.currentRevisionId || null } }); requestId.current = ''; }} className={inputClass}><option value="">Not linked to a requirement</option>{requirements.map(item => <option key={item.id} value={item.id}>{item.title} · Blank version {item.templateRevision}</option>)}</select></label>}
          {draft.original?.registrationFormId && <p className="text-sm text-slate-600">Linked to its original template version. Use Attach completed copy to use an updated blank form.</p>}
          <label className="block">Document notes (optional)<textarea rows={3} value={draft.metadata.notes} maxLength={2000} onChange={event => change('notes', event.target.value)} className={inputClass} /></label></>}
        {file && photoConfirmed && <section aria-label="Expiration date suggestions" className="min-w-0 space-y-3 rounded-xl border border-blue-100 bg-blue-50 p-4">
          <h5 className="font-bold">Check the expiration date</h5>
          {expirationReading.status === 'reading' && <p role="status" className="text-sm">Checking for an expiration date… You can enter its date below while it is being checked.</p>}
          {expirationReading.status === 'ready' && (expirationReading.candidates.length ? <>
            <p className="text-sm">Possible expiration {expirationReading.candidates.length === 1 ? 'date found' : 'dates found'}. Check the document and choose the correct date. Your entered date stays unchanged until you choose.</p>
            <ul className="space-y-2">{expirationReading.candidates.map(candidate => <li key={candidate.date} className="min-w-0 rounded-lg bg-white p-3"><p className="break-words text-sm">{candidate.label}</p><button type="button" className="ska-button mt-2" aria-label={'Use expiration date ' + candidate.date} onClick={() => { acceptedExpiration.current = candidate.date; setDraft(previous => previous && ({ ...previous, metadata: { ...previous.metadata, expiresOn: candidate.date, nonExpiring: false } })); requestId.current = ''; setError(''); setMessage(''); }}>Use {candidate.date}</button></li>)}</ul>
          </> : <p className="text-sm">No clear expiration date was found. Enter it below{currentRequirement?.expirationRequired ? '.' : ', or choose Does not expire if that is correct for this document.'}</p>)}
          {expirationReading.status === 'unavailable' && <p className="text-sm">The expiration date could not be read. Enter it below{currentRequirement?.expirationRequired ? '.' : ', or choose Does not expire if that is correct for this document.'} You can still save the document.</p>}
          {expirationReading.incomplete && <p className="text-sm text-amber-900">Only part of the document could be checked. Verify the full document and its expiration date before review.</p>}
        </section>}
        {draft.mode === 'revise' && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Enter the new copy’s expiration date, or confirm that it does not expire when allowed. The earlier copy’s date is kept in its history.</p>}
        <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="block min-w-0">Issued date (optional)<input type="date" min="1900-01-01" max="9999-12-31" value={draft.metadata.issuedOn || ''} onChange={event => change('issuedOn', event.target.value || null)} className={inputClass} /></label><label className="block min-w-0">Expiration date<input type="date" min="1900-01-01" max="9999-12-31" disabled={draft.metadata.nonExpiring} value={draft.metadata.expiresOn || ''} onChange={event => change('expiresOn', event.target.value || null)} className={inputClass} /></label></div>
        <label className="flex items-start gap-3"><input type="checkbox" checked={draft.metadata.nonExpiring} disabled={!!currentRequirement?.expirationRequired && !draft.metadata.nonExpiring} onChange={event => { acceptedExpiration.current = null; setDraft({ ...draft, metadata: { ...draft.metadata, nonExpiring: event.target.checked, expiresOn: event.target.checked ? null : draft.metadata.expiresOn } }); requestId.current = ''; }} className="mt-1" />Does not expire</label>
        <p className="text-sm text-slate-600">{currentRequirement?.expirationRequired ? 'This requirement must have an expiration date before it can be reviewed.' : 'Before review, enter an expiration date or confirm that this document does not expire.'} Renewals keep the earlier file and its dates.</p>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="block min-w-0">Issuer (optional)<input maxLength={160} value={draft.metadata.issuer} onChange={event => change('issuer', event.target.value)} className={inputClass} /></label><label className="block min-w-0">Certificate reference (optional)<input maxLength={100} value={draft.metadata.reference} onChange={event => change('reference', event.target.value)} className={inputClass} /></label></div>
        <section aria-label="Document reminder" className="min-w-0 space-y-3 rounded-xl border border-violet-100 bg-violet-50/50 p-4"><h5 className="font-bold">When should we remind you?</h5>
          <div className="min-w-0"><label htmlFor={reminderId} className="block">Remind me</label><select id={reminderId} disabled={draft.metadata.nonExpiring} value={customReminder ? 'custom' : draft.metadata.warningDays === null ? 'default' : reminderChoices.includes(draft.metadata.warningDays) ? String(draft.metadata.warningDays) : 'custom'} onChange={event => { const selected = event.target.value; setCustomReminder(selected === 'custom'); if (selected !== 'custom') change('warningDays', selected === 'default' ? null : Number(selected)); }} className={inputClass}><option value="default">Use facility default ({settings?.warningDays ?? 40} days before expiration)</option>{reminderChoices.map(days => <option key={days} value={days}>{days} days before expiration</option>)}<option value="custom">Choose a different number of days</option></select></div>
          <label className="block">Reminder days (optional)<input type="number" min={1} max={365} step={1} disabled={draft.metadata.nonExpiring} value={draft.metadata.warningDays ?? ''} placeholder={String(settings?.warningDays ?? 40) + ' days by default'} onChange={event => { setCustomReminder(event.target.value !== ''); change('warningDays', event.target.value === '' ? null : Number(event.target.value)); }} className={inputClass} /></label>
          {draft.metadata.nonExpiring ? <p className="text-sm text-slate-600">No expiration reminder for a document marked Does not expire.</p> : <>
            {reminderDate ? <p role="status" className="text-sm font-semibold text-violet-900">Reminders start {reminderDate} · {reminderDays} days before expiration.{checklist?.today && reminderDate <= checklist.today ? ' This reminder is already due.' : ''}</p> : <p className="text-sm text-slate-600">Enter an expiration date to see when the reminder starts.</p>}
            <p className="text-sm text-slate-600">{currentRequirement?.required ? 'For active staff, renewal reminders appear on Home and Staff after this required document is reviewed.' : draft.original?.registrationFormId ? 'This optional requirement is not included in renewal reminders on Home and Staff.' : 'Choose a required employee requirement to include this document in renewal reminders on Home and Staff.'}</p>
          </>}
        </section>
        {draft.mode === 'revise' && <label className="block">Change note (optional)<textarea rows={2} maxLength={500} value={draft.changeNote} onChange={event => { setDraft({ ...draft, changeNote: event.target.value }); requestId.current = ''; }} className={inputClass} /></label>}
        <div className="flex flex-wrap gap-3"><button disabled={busy || versionConflict || cameraFile && !photoConfirmed} className="ska-button is-primary"><Upload size={18} aria-hidden="true" />{busy ? 'Saving document…' : draft.mode === 'edit' ? 'Save document details' : draft.mode === 'revise' ? 'Save new version' : 'Save staff document'}</button><button type="button" className="ska-button" onClick={() => { if (leaveDraft()) { clearDraft(); setError(''); } }}>Cancel document changes</button></div>
      </fieldset></form>}
      {!loading && (!documents.length ? <p className="rounded-xl bg-white p-4 text-sm text-slate-600">No staff documents saved yet.</p> : <><ul className="space-y-2">{documents.map(item => <li key={item.id}><button type="button" disabled={busy} aria-pressed={selectedId === item.id} className={'w-full min-w-0 rounded-xl border p-4 text-left ' + (selectedId === item.id ? 'border-violet-400 bg-violet-100' : 'bg-white')} onClick={() => { if (leaveDraft()) { clearDraft(); setSelectedId(item.id); setHistoryPage(1); setError(''); } }}><span className="block break-words font-bold">{item.title}</span><span className="mt-1 block text-sm text-slate-600">{item.expiresOn ? 'Expires ' + item.expiresOn : item.nonExpiring ? 'Does not expire' : 'Expiration not recorded'} · Updated {dateTime(item.updatedAt)}</span></button></li>)}</ul>{total > 10 && <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={page === 1 || busy} className="ska-button" onClick={() => setPage(value => value - 1)}>Previous staff documents</button><span>Page {page} of {Math.ceil(total / 10)}</span><button type="button" disabled={page * 10 >= total || busy} className="ska-button" onClick={() => setPage(value => value + 1)}>Next staff documents</button></div>}</>)}
      {detailLoading && <p role="status">Loading document history…</p>}
      {details && <section aria-label="Selected staff document" className="min-w-0 space-y-4 rounded-2xl border bg-white p-4"><h4 className="break-words text-lg font-bold">{details.document.title}</h4><p className="text-sm text-slate-600">{details.document.issuedOn && 'Issued ' + details.document.issuedOn + ' · '}{details.document.expiresOn ? 'Expires ' + details.document.expiresOn : details.document.nonExpiring ? 'Does not expire' : 'Expiration date not recorded'}</p>{details.document.issuer && <p className="break-words text-sm">Issuer: {details.document.issuer}</p>}{details.document.reference && <p className="break-words text-sm">Certificate reference: {details.document.reference}</p>}{details.document.notes && <p className="whitespace-pre-wrap break-words text-sm">{details.document.notes}</p>}
        <div className="flex flex-wrap gap-3"><button type="button" disabled={busy} className="ska-button" onClick={() => openDraft('edit')}>Edit document details</button><button type="button" disabled={busy} className="ska-button" onClick={() => openDraft('revise')}>Upload new version</button><button type="button" disabled={busy} className="ska-button" onClick={() => { if (leaveDraft()) { clearDraft(); setSelectedId(''); } }}>Close selected document</button></div>
        <div className="space-y-3 rounded-xl bg-blue-50 p-3"><h5 className="font-bold">Review current version</h5>{details.document.reviewedRevisionId === details.document.currentRevisionId ? <><p className="text-sm text-emerald-800">Current copy reviewed{details.document.reviewedAt ? ' · ' + dateTime(details.document.reviewedAt) : ''}.</p><button type="button" disabled={busy || !!draft} className="ska-button" onClick={() => void review(false)}>Clear review</button></> : <><p className="text-sm">Open the current file and verify its completed information, signatures and expiration date.</p><label className="flex items-start gap-3"><input type="checkbox" checked={reviewConfirmed} disabled={busy || !!draft} onChange={event => setReviewConfirmed(event.target.checked)} className="mt-1" />I checked this document and its dates</label><button type="button" disabled={busy || !reviewConfirmed || !!draft} className="ska-button is-primary" onClick={() => void review(true)}>Mark reviewed</button></>}</div>
        <h5 className="flex items-center gap-2 font-bold"><History size={18} aria-hidden="true" />Version history</h5><ol className="space-y-3">{details.revisions.map(item => <li key={item.id} className="min-w-0 rounded-xl border p-3"><div className="flex flex-wrap items-center gap-2"><span className="font-bold">Version {item.revision}</span>{item.current && <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800">Current version</span>}</div><p className="mt-1 break-words text-sm">{item.filename}</p><p className="mt-1 text-sm text-slate-600">{item.expiresOn ? 'Expires ' + item.expiresOn + ' · ' : item.nonExpiring ? 'Does not expire · ' : ''}{dateTime(item.uploadedAt)}</p>{item.changeNote && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.changeNote}</p>}<div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={contentBusy} aria-label={'Preview staff document version ' + item.revision} className="ska-button" onClick={() => void content(item, false)}><FileText size={17} aria-hidden="true" />Preview</button><button type="button" disabled={contentBusy} aria-label={'Download staff document version ' + item.revision} className="ska-button" onClick={() => void content(item, true)}><Download size={17} aria-hidden="true" />Download</button></div></li>)}</ol>
        {details.total > 10 && <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={historyPage === 1 || busy} className="ska-button" onClick={() => setHistoryPage(value => value - 1)}>Previous document versions</button><span>Page {historyPage} of {Math.ceil(details.total / 10)}</span><button type="button" disabled={historyPage * 10 >= details.total || busy} className="ska-button" onClick={() => setHistoryPage(value => value + 1)}>Next document versions</button></div>}
      </section>}
      {contentBusy && <p role="status">Opening file…</p>}
      {preview && <section aria-label="Staff document preview" className="min-w-0 space-y-3 rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-bold">Preview · Version {preview.revision.revision}</h4><button type="button" className="ska-button" onClick={() => { previewSequence.current++; setPreview(null); }}>Close preview</button></div>{preview.revision.contentType === 'application/pdf' ? <Suspense fallback={<p role="status">Loading PDF preview…</p>}><PdfDocumentPreview blob={preview.blob} /></Suspense> : <img src={preview.url} alt={'Staff document version ' + preview.revision.revision + ' preview'} className="max-h-[36rem] w-full rounded-xl object-contain" />}</section>}
    </>}
  </section>;
}
