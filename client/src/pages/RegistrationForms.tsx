import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import axios from 'axios';
import { Archive, FileText, History, Plus, Upload, X } from 'lucide-react';
import { useAuth } from '../auth/context';
import { authError, onSessionExpired } from '../auth/transport';
import { useUnsavedChanges } from '../components/UnsavedChangesContext';
import { BlankFormActions } from '../components/registration/BlankFormActions';
import { documentCategories, documentRequestId, readDocumentFile, validateDocumentFile } from '../api/childDocuments';
import type { DocumentCategory, DocumentRevision } from '../api/childDocuments';
import {
  addRegistrationForm, getRegistrationForm, listRegistrationForms, reviseRegistrationForm, updateRegistrationForm,
} from '../api/registrationForms';
import { templateAudiences } from '../api/registrationForms';
import type { TemplateAudience } from '../api/registrationForms';
import type { RegistrationForm, RegistrationFormDetails } from '../api/registrationForms';

type Metadata = Pick<RegistrationForm, 'title' | 'instructions' | 'category' | 'audience' | 'required' | 'expirationRequired' | 'active'>;
type Draft = { mode: 'new' | 'edit' | 'revise'; original: RegistrationForm | null; metadata: Metadata; initialMetadata: Metadata; changeNote: string };
const emptyMetadata = (): Metadata => ({ title: '', instructions: '', category: 'other', audience: 'child', required: false, expirationRequired: false, active: true });
const newDraft = (employeeRequirement = false): Draft => {
  const metadata = { ...emptyMetadata(), ...(employeeRequirement ? { audience: 'employee' as const, required: true } : {}) };
  return { mode: 'new', original: null, metadata, initialMetadata: metadata, changeNote: '' };
};
const metadataOf = (form: RegistrationForm): Metadata => ({ title: form.title, instructions: form.instructions || '', category: form.category, audience: form.audience || 'child', required: form.required, expirationRequired: form.expirationRequired === true, active: form.active });
const inputClass = 'mt-1 block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const dateTime = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; };
const cancelled = (failure: unknown) => axios.isCancel(failure) || failure instanceof DOMException && failure.name === 'AbortError';

export default function RegistrationForms() {
  const { account } = useAuth();
  if (!account || account.role !== 'admin' || account.disabled || account.mustChangePassword) return <p role="alert" className="p-4">Administrator access is required to manage registration forms.</p>;
  return <RegistrationFormManager key={account.id} />;
}

function RegistrationFormManager() {
  const location = useLocation();
  const startEmployeeRequirement = new URLSearchParams(location.search).get('employee-requirement') === 'new';
  const [forms, setForms] = useState<RegistrationForm[]>([]);
  const [audienceFilter, setAudienceFilter] = useState(startEmployeeRequirement ? 'employee' : 'all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [details, setDetails] = useState<RegistrationFormDetails | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(() => startEmployeeRequirement ? newDraft(true) : null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [expired, setExpired] = useState(false);
  const requests = useRef(new Set<AbortController>());
  const alive = useRef(true);
  const requestId = useRef('');
  const fileId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const reportUnsaved = useUnsavedChanges();
  const dirty = !!draft && (draft.mode === 'new'
    ? JSON.stringify(draft.metadata) !== JSON.stringify(draft.initialMetadata) || !!file
    : draft.mode === 'revise' ? !!file || !!draft.changeNote
      : JSON.stringify(draft.metadata) !== JSON.stringify(metadataOf(draft.original!)));

  useEffect(() => { reportUnsaved(dirty, busy); }, [dirty, busy, reportUnsaved]);
  useEffect(() => () => reportUnsaved(false, false), [reportUnsaved]);
  useEffect(() => {
    alive.current = true;
    const stop = () => { for (const controller of requests.current) controller.abort(); requests.current.clear(); };
    const unsubscribe = onSessionExpired(() => {
      stop(); setExpired(true); setForms([]); setDetails(null); setDraft(null); setFile(null); setError(''); setMessage(''); setBusy(false); setConflict(false); requestId.current = '';
    });
    return () => { alive.current = false; stop(); unsubscribe(); };
  }, []);
  useEffect(() => {
    if (expired) return;
    const controller = new AbortController(); const requestSet = requests.current; requestSet.add(controller);
    setLoading(true);
    void listRegistrationForms(includeArchived, controller.signal).then(result => { if (!controller.signal.aborted) setForms(result.items); })
      .catch(failure => { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load registration forms. Use Refresh templates to try again.')); })
      .finally(() => { requestSet.delete(controller); if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); requestSet.delete(controller); };
  }, [includeArchived, refresh, expired]);
  useEffect(() => {
    setDetails(null); setDetailLoading(false);
    if (!selectedId || expired) return;
    const controller = new AbortController(); const requestSet = requests.current; requestSet.add(controller); setDetailLoading(true);
    void getRegistrationForm(selectedId, controller.signal, historyPage).then(result => {
      if (controller.signal.aborted) return;
      if (historyPage > 1 && (historyPage - 1) * 10 >= result.total) { setHistoryPage(Math.max(1, Math.ceil(result.total / 10))); return; }
      setDetails(result);
    })
      .catch(failure => { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load this template and its version history.')); })
      .finally(() => { requestSet.delete(controller); if (!controller.signal.aborted) setDetailLoading(false); });
    return () => { controller.abort(); requestSet.delete(controller); };
  }, [selectedId, historyPage, refresh, expired]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);

  function leaveDraft() { return !busy && (!dirty || window.confirm('Discard the unsaved registration form changes?')); }
  function clearDraft() { setDraft(null); setFile(null); setConflict(false); requestId.current = ''; }
  function openDraft(mode: Draft['mode'], employeeRequirement = false) {
    if (!leaveDraft() || mode !== 'new' && !details) return;
    clearDraft(); setError(''); setMessage('');
    if (mode === 'new') setHistoryPage(1);
    if (mode === 'new') {
      setDraft(newDraft(employeeRequirement));
      if (employeeRequirement) setAudienceFilter('employee');
    } else {
      const metadata = metadataOf(details!.form);
      setDraft({ mode, original: details!.form, metadata, initialMetadata: metadata, changeNote: '' });
    }
  }
  function changeMetadata<K extends keyof Metadata>(key: K, value: Metadata[K]) {
    setDraft(previous => previous && ({ ...previous, metadata: { ...previous.metadata, [key]: value,
      ...(key === 'audience' && value !== 'employee' ? { expirationRequired: false } : {}) } }));
    requestId.current = ''; setError(''); setMessage('');
  }
  function chooseFile(selected: File | undefined) {
    if (!selected) return;
    const invalid = validateDocumentFile(selected);
    if (invalid) { setError(invalid); return; }
    setFile(selected); requestId.current = ''; setError(''); setMessage('');
  }
  function failureMessage(failure: unknown, fallback: string) {
    const stale = axios.isAxiosError(failure) && failure.response?.status === 409;
    setConflict(stale && !!draft?.original);
    setError(stale ? 'This template changed since you opened it. Your draft is still here. Load the latest template, review your changes, then save again.' : authError(failure, fallback));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || expired) return;
    const metadata = { ...draft.metadata, title: draft.metadata.title.trim(), instructions: draft.metadata.instructions.trim() };
    if (draft.mode !== 'revise') {
      if (!metadata.title || metadata.title.length > 160) { setError(metadata.audience === 'employee' ? 'Enter a certificate or document name between 1 and 160 characters.' : 'Enter a form title between 1 and 160 characters.'); return; }
      if (metadata.instructions.length > 2000) { setError('Use at most 2000 characters for instructions.'); return; }
    }
    if (draft.changeNote.trim().length > 500) { setError('Use at most 500 characters for the change note.'); return; }
    if ((draft.mode === 'revise' || draft.mode === 'new' && metadata.audience !== 'employee') && !file) { setError('Choose a PDF, JPG or PNG blank form first.'); return; }
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    try {
      if (!requestId.current) requestId.current = documentRequestId();
      const newMetadata = { title: metadata.title, instructions: metadata.instructions, category: metadata.category, audience: metadata.audience || 'child', required: metadata.required, expirationRequired: metadata.expirationRequired === true };
      const result = draft.mode === 'edit' ? await updateRegistrationForm(draft.original!, metadata, controller.signal)
        : draft.mode === 'new' ? await addRegistrationForm(newMetadata, file ? await readDocumentFile(file, controller.signal) : undefined, requestId.current, controller.signal)
          : await reviseRegistrationForm(draft.original!, await readDocumentFile(file!, controller.signal), draft.changeNote.trim(), requestId.current, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setSelectedId(result.form.id); setHistoryPage(1); clearDraft(); setRefresh(value => value + 1);
      setMessage(draft.mode === 'new' ? metadata.audience === 'employee' ? 'Employee requirement added.' : 'Blank form template added.' : draft.mode === 'edit' ? 'Template details saved.' : 'New blank form version saved. Earlier versions are kept.');
    } catch (failure) {
      if (!controller.signal.aborted && !cancelled(failure)) failureMessage(failure, 'Could not save this template. Your draft and file are still here; try again.');
    } finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function loadLatest() {
    if (!draft?.original || busy || expired) return;
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError('');
    try {
      const latest = await getRegistrationForm(draft.original.id, controller.signal, 1);
      if (controller.signal.aborted || !alive.current) return;
      setDetails(latest); setHistoryPage(1); setDraft(previous => previous && ({ ...previous, original: latest.form }));
      setConflict(false); requestId.current = ''; setMessage('Latest template loaded. Your draft and file are kept. Review them before saving.');
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load the latest template. Your draft is still here.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function toggleArchive() {
    if (!details || expired || !leaveDraft()) return;
    const current = details.form;
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    try {
      await updateRegistrationForm(current, { ...metadataOf(current), active: !current.active }, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      clearDraft(); setRefresh(value => value + 1);
      setMessage(current.active ? 'Template archived. Earlier versions and submitted documents are kept.' : 'Template restored to the active registration forms.');
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not change the template status. Refresh templates and try again.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  function revisionCard(revision: DocumentRevision) {
    return <li key={revision.id} className="min-w-0 space-y-3 rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2"><span className="font-bold">Version {revision.revision}</span>{revision.current && <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800">Current blank template</span>}</div>
      <p className="break-words text-sm">{revision.filename}</p>
      <p className="break-words text-sm text-slate-600">Uploaded by {revision.uploadedBy} · {dateTime(revision.uploadedAt)}</p>
      {revision.changeNote && <p className="whitespace-pre-wrap break-words text-sm">{revision.changeNote}</p>}
      <BlankFormActions form={details!.form} revision={revision} disabled={busy} />
    </li>;
  }
  if (expired) return null;
  const visibleForms = forms.filter(form => audienceFilter === 'all' || (form.audience || 'child') === audienceFilter);
  const currentRevisions = details?.revisions.filter(revision => revision.current || revision.id === details.form.currentRevisionId) || [];
  const oldRevisions = details?.revisions.filter(revision => !revision.current && revision.id !== details.form.currentRevisionId) || [];
  const draftTitle = draft?.mode === 'new' ? draft.metadata.audience === 'employee' ? 'Add employee requirement' : 'Add blank form template' : draft?.mode === 'edit' ? 'Edit template details' : 'Upload a new blank version';
  return <div className="mx-auto min-w-0 max-w-5xl space-y-5 p-3 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-800"><FileText size={25} className="shrink-0 text-violet-600" aria-hidden="true" />Registration forms</h1><p className="mt-2 max-w-2xl text-sm text-slate-600">Manage blank templates and document requirements for children, employees and the facility. Upload blank forms only. Required child templates appear in each child's enrollment checklist. Employee certificates can be required by name, without a template.</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || loading} className="ska-button" onClick={() => { if (leaveDraft()) { clearDraft(); setError(''); setRefresh(value => value + 1); } }}>Refresh templates</button><button type="button" disabled={busy} className="ska-button" onClick={() => openDraft('new')}><Plus size={18} aria-hidden="true" />Add blank form</button><button type="button" disabled={busy} className="ska-button is-primary" onClick={() => openDraft('new', true)}><Plus size={18} aria-hidden="true" />Add employee requirement</button></div></div>
    {error && <p role="alert" className="break-words rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="break-words rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
    {conflict && draft && <button type="button" disabled={busy} onClick={() => void loadLatest()} className="ska-button">Load latest template and keep draft</button>}
    {draft && <form aria-label={draft.mode === 'revise' ? 'Upload blank form version' : draftTitle} onSubmit={save} className="min-w-0 rounded-2xl border border-violet-200 bg-violet-50/50 p-4 sm:p-5"><fieldset disabled={busy} className="min-w-0 space-y-4">
      <h2 className="text-lg font-bold">{draftTitle}</h2>
      {draft.mode !== 'revise' && <>
        {draft.mode === 'new' && draft.metadata.audience === 'employee' && <p className="text-sm text-slate-700">Enter a certificate, training or document name, such as CPR certification. No blank template is needed. A required item appears in every active employee's checklist until their document is uploaded and reviewed.</p>}
        <label className="block text-sm font-semibold">{draft.metadata.audience === 'employee' ? 'Certificate or document name' : 'Form title'}<input required autoFocus maxLength={160} value={draft.metadata.title} onChange={event => changeMetadata('title', event.target.value)} className={inputClass} /></label>
        <label className="block text-sm font-semibold">Template for<select disabled={draft.mode !== 'new'} value={draft.metadata.audience || 'child'} onChange={event => changeMetadata('audience', event.target.value as TemplateAudience)} className={inputClass}>{Object.entries(templateAudiences).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span className="mt-1 block text-xs text-slate-500">Choose the group when uploading. It stays with this template and its history.</span></label>
        <label className="block text-sm font-semibold">Document category<select value={draft.metadata.category} onChange={event => changeMetadata('category', event.target.value as DocumentCategory)} className={inputClass}>{Object.entries(documentCategories).map(([category, label]) => <option key={category} value={category}>{label}</option>)}</select></label>
        <label className="block text-sm font-semibold">Instructions (optional)<textarea rows={3} maxLength={2000} value={draft.metadata.instructions} onChange={event => changeMetadata('instructions', event.target.value)} className={inputClass} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.metadata.required} onChange={event => changeMetadata('required', event.target.checked)} className="mt-1" /><span>{draft.metadata.audience === 'employee' ? 'Required for every active employee' : 'Required for this group'}</span></label>
        {draft.metadata.audience === 'employee' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.metadata.expirationRequired === true} onChange={event => changeMetadata('expirationRequired', event.target.checked)} className="mt-1" /><span>Expiration date required</span></label>}
        {draft.mode === 'edit' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.metadata.active} onChange={event => changeMetadata('active', event.target.checked)} className="mt-1" /><span>Active template</span></label>}
      </>}
      {draft.mode !== 'edit' && <>
        <p className="text-sm text-slate-600">{draft.mode === 'new' && draft.metadata.audience === 'employee' ? 'A blank file is optional for an employee training or certificate requirement. If available, choose a blank PDF, JPG or PNG of 5 MB or less.' : 'Choose a blank PDF, JPG or PNG of 5 MB or less. Earlier versions stay available after a replacement.'}</p>
        <label htmlFor={fileId} className="block text-sm font-semibold">{draft.mode === 'new' && draft.metadata.audience === 'employee' ? 'Upload a blank form (optional)' : 'Upload a blank form'}<input id={fileId} ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={event => chooseFile(event.target.files?.[0])} className="mt-2 block w-full min-w-0 max-w-full text-sm file:mr-2 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-2" /></label>
        {file && <p className="break-words text-sm text-slate-700">Selected blank file: {file.name}</p>}
        {file && draft.mode === 'new' && draft.metadata.audience === 'employee' && <button type="button" className="ska-button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; requestId.current = ''; setError(''); }}>Remove selected blank file</button>}
        {draft.mode === 'revise' && <label className="block text-sm font-semibold">Change note (optional)<textarea rows={2} maxLength={500} value={draft.changeNote} onChange={event => { setDraft({ ...draft, changeNote: event.target.value }); requestId.current = ''; setError(''); setMessage(''); }} className={inputClass} /></label>}
      </>}
      <div className="flex flex-wrap gap-2"><button type="submit" className="ska-button is-primary">{busy ? 'Saving…' : draft.mode === 'new' ? draft.metadata.audience === 'employee' ? 'Save employee requirement' : 'Save blank form' : draft.mode === 'edit' ? 'Save template details' : 'Save new blank version'}</button><button type="button" className="ska-button" onClick={() => { if (leaveDraft()) { clearDraft(); setError(''); } }}>Cancel template changes</button></div>
    </fieldset></form>}
    <section aria-label="Template list" className="min-w-0 space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold">Templates and requirements</h2><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeArchived} disabled={busy} onChange={event => { if (leaveDraft()) { clearDraft(); setIncludeArchived(event.target.checked); setError(''); } }} />Include archived templates</label></div>
      <label className="block text-sm font-semibold">Filter templates<select className={inputClass} value={audienceFilter} onChange={event => setAudienceFilter(event.target.value)}><option value="all">All groups</option>{Object.entries(templateAudiences).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {loading ? <p role="status">Loading registration forms…</p> : !visibleForms.length ? <p className="rounded-xl border bg-white p-4 text-sm text-slate-600">{includeArchived ? 'No templates or requirements saved in this group yet.' : 'No active templates or requirements in this group. Add a blank form or employee requirement, choose another group or include archived templates.'}</p> : <ul className="grid min-w-0 gap-3 sm:grid-cols-2">{visibleForms.map(form => <li key={form.id} className="min-w-0"><button type="button" disabled={busy} aria-pressed={selectedId === form.id} onClick={() => { if (leaveDraft()) { clearDraft(); setError(''); setMessage(''); setSelectedId(form.id); setHistoryPage(1); } }} className={'w-full min-w-0 rounded-xl border p-4 text-left disabled:opacity-50 ' + (selectedId === form.id ? 'border-violet-400 bg-violet-100/70' : 'border-slate-200 bg-white')}><span className="block break-words font-bold">{form.title}</span><span className="mt-1 block break-words text-sm text-slate-600">{templateAudiences[form.audience || 'child']} · {documentCategories[form.category]} · {form.required ? 'Required' : 'Optional'} · {form.active ? 'Active' : 'Archived'}</span><span className="mt-1 block text-xs text-slate-500">{form.currentRevisionId ? 'Blank version ' + form.templateRevision : 'No blank file'}{form.audience === 'employee' && form.expirationRequired ? ' · Expiration date required' : ''} · Updated {dateTime(form.updatedAt)}</span></button></li>)}</ul>}
    </section>
    {detailLoading && <p role="status">Loading template history…</p>}
    {details && <section aria-label="Selected registration template" className="min-w-0 space-y-4 rounded-2xl border bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-xl font-bold">{details.form.title}</h2><p className="mt-1 text-sm text-slate-600">{templateAudiences[details.form.audience || 'child']} · {documentCategories[details.form.category]} · {details.form.required ? 'Required for this group' : 'Optional for this group'} · {details.form.active ? 'Active' : 'Archived'}</p></div><button type="button" disabled={busy} className="ska-button" aria-label="Close selected template" onClick={() => { if (leaveDraft()) { clearDraft(); setSelectedId(''); setError(''); } }}><X size={18} aria-hidden="true" />Close</button></div>
      {details.form.instructions && <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{details.form.instructions}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => openDraft('edit')} className="ska-button">Edit template details</button><button type="button" disabled={busy} onClick={() => openDraft('revise')} className="ska-button"><Upload size={18} aria-hidden="true" />Upload new blank version</button><button type="button" disabled={busy} onClick={() => void toggleArchive()} className="ska-button"><Archive size={18} aria-hidden="true" />{details.form.active ? 'Archive template' : 'Restore template'}</button></div>
      <h3 className="flex items-center gap-2 font-bold"><History size={18} className="text-violet-600" aria-hidden="true" />Blank template version history</h3>
      {!!currentRevisions.length && <ol className="space-y-3" aria-label="Current blank template version">{currentRevisions.map(revisionCard)}</ol>}
      {!!oldRevisions.length && <><h4 className="font-semibold">Earlier blank versions</h4><ol className="space-y-3" aria-label="Earlier blank template versions">{oldRevisions.map(revisionCard)}</ol></>}
      {details.form.audience === 'employee' && <p className="text-sm text-slate-600">{details.form.expirationRequired ? 'An expiration date is required on employee documents for this requirement.' : 'An expiration date is optional on employee documents for this requirement.'}</p>}
      {!details.revisions.length && <p className="text-sm text-slate-600">This employee requirement has no blank file. Upload a blank version if one becomes available.</p>}
      {details.total > 10 && <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={historyPage === 1 || busy || detailLoading} onClick={() => setHistoryPage(value => value - 1)} className="ska-button">Previous blank versions</button><span className="text-sm">Page {historyPage} of {Math.ceil(details.total / 10)} · {details.total} blank versions</span><button type="button" disabled={historyPage * 10 >= details.total || busy || detailLoading} onClick={() => setHistoryPage(value => value + 1)} className="ska-button">Next blank versions</button></div>}
    </section>}
  </div>;
}
