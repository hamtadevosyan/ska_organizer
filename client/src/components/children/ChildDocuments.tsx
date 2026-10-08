import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import axios from 'axios';
import { Camera, Download, FileText, History, Plus, Upload, X } from 'lucide-react';
import { useAuth } from '../../auth/context';
import { authError, onSessionExpired } from '../../auth/transport';
import { useUnsavedChanges } from '../UnsavedChangesContext';
import {
  addChildDocument, documentAccess, documentCategories, documentRequestId, getChildDocument, getDocumentContent,
  listChildDocuments, readDocumentFile, reviseChildDocument, updateChildDocument, validateDocumentFile,
} from '../../api/childDocuments';
import type { ChildDocument, DocumentCategory, DocumentDetails, DocumentMetadata, DocumentRevision, DocumentWork } from '../../api/childDocuments';

const PdfDocumentPreview = lazy(() => import('./PdfDocumentPreview'));

type Form = { mode: 'new' | 'edit' | 'revise'; original: ChildDocument | null; metadata: DocumentMetadata; changeNote: string };
const emptyMetadata = (): DocumentMetadata => ({ title: '', category: 'other', documentDate: null, notes: '' });
const metadataOf = (document: ChildDocument): DocumentMetadata => ({ title: document.title, category: document.category, documentDate: document.documentDate, notes: document.notes || '' });
const inputClass = 'mt-1 block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3';
const dateTime = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; };
const cancelled = (failure: unknown) => axios.isCancel(failure) || failure instanceof DOMException && failure.name === 'AbortError';

export function ChildDocuments({ childId, openAdd = false, onWorkChange }: { childId: string; openAdd?: boolean; onWorkChange?: (work: DocumentWork) => void }) {
  const { account } = useAuth();
  const access = documentAccess(account);
  if (access === 'none') return <section aria-label="Documents" className="rounded-2xl border border-violet-100 bg-violet-50/50 p-4"><h3 className="flex items-center gap-2 font-bold"><FileText size={20} aria-hidden="true" />Documents</h3><p className="mt-2 text-sm text-slate-600">Document access is managed separately. Ask an administrator if you need it.</p></section>;
  return <DocumentArea key={[childId, account?.id, access].join(':')} childId={childId} canEdit={access === 'edit'} openAdd={openAdd} onWorkChange={onWorkChange} />;
}

function DocumentArea({ childId, canEdit, openAdd, onWorkChange }: { childId: string; canEdit: boolean; openAdd: boolean; onWorkChange?: (work: DocumentWork) => void }) {
  const [documents, setDocuments] = useState<ChildDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [details, setDetails] = useState<DocumentDetails | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState<Form | null>(() => openAdd && canEdit ? { mode: 'new', original: null, metadata: emptyMetadata(), changeNote: '' } : null);
  const [file, setFile] = useState<File | null>(null);
  const [cameraFile, setCameraFile] = useState(false);
  const [photoConfirmed, setPhotoConfirmed] = useState(false);
  const [filePreview, setFilePreview] = useState('');
  const [preview, setPreview] = useState<{ url: string; blob?: Blob; revision: DocumentRevision } | null>(null);
  const [busy, setBusy] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [expired, setExpired] = useState(false);
  const requestId = useRef('');
  const requests = useRef(new Set<AbortController>());
  const alive = useRef(true);
  const previewSequence = useRef(0);
  const downloadUrls = useRef(new Set<string>());
  const reportUnsaved = useUnsavedChanges();
  const fileId = useId();
  const photoId = useId();
  const cameraAvailable = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const dirty = !!form && (form.mode === 'new' ? !!(form.metadata.title || form.metadata.documentDate || form.metadata.notes || form.metadata.category !== 'other' || file)
    : form.mode === 'revise' ? !!(file || form.changeNote)
      : JSON.stringify(form.metadata) !== JSON.stringify(metadataOf(form.original!)));

  useEffect(() => {
    reportUnsaved(dirty, busy);
    onWorkChange?.({ dirty, busy });
  }, [dirty, busy, reportUnsaved, onWorkChange]);
  useEffect(() => () => { reportUnsaved(false, false); onWorkChange?.({ dirty: false, busy: false }); }, [reportUnsaved, onWorkChange]);
  useEffect(() => {
    alive.current = true;
    const stop = () => {
      for (const controller of requests.current) controller.abort();
      requests.current.clear(); previewSequence.current++;
      for (const url of downloadUrls.current) URL.revokeObjectURL(url);
      downloadUrls.current.clear();
    };
    const unsubscribe = onSessionExpired(() => {
      stop(); setExpired(true); setDocuments([]); setDetails(null); setPreview(null); setFile(null); setForm(null); setError(''); setMessage(''); setBusy(false); setContentBusy(false);
    });
    return () => { alive.current = false; stop(); unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!file) { setFilePreview(''); return; }
    const localUrl = URL.createObjectURL(file);
    setFilePreview(localUrl);
    return () => URL.revokeObjectURL(localUrl);
  }, [file]);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => {
    if (expired) return;
    const controller = new AbortController(); const requestSet = requests.current; requestSet.add(controller);
    setLoading(true);
    void listChildDocuments(childId, page, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (page > 1 && (page - 1) * 10 >= result.total) { setPage(Math.max(1, Math.ceil(result.total / 10))); return; }
      setDocuments(result.items); setTotal(result.total);
    }).catch(failure => { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load documents.')); })
      .finally(() => { requests.current.delete(controller); if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); requestSet.delete(controller); };
  }, [childId, page, refresh, expired]);
  useEffect(() => {
    setDetails(null); setPreview(null); previewSequence.current++;
    if (!selectedId || expired) return;
    const controller = new AbortController(); const requestSet = requests.current; requestSet.add(controller); setDetailLoading(true);
    void getChildDocument(childId, selectedId, historyPage, controller.signal).then(result => { if (!controller.signal.aborted) setDetails(result); })
      .catch(failure => { if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not load this document.')); })
      .finally(() => { requests.current.delete(controller); if (!controller.signal.aborted) setDetailLoading(false); });
    return () => { controller.abort(); requestSet.delete(controller); };
  }, [childId, selectedId, historyPage, refresh, expired]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);

  function leaveDraft() { return !busy && (!dirty || window.confirm('Discard the unsaved document changes?')); }
  function clearForm() { setForm(null); setFile(null); setCameraFile(false); setPhotoConfirmed(false); requestId.current = ''; }
  function openForm(mode: Form['mode']) {
    if (!leaveDraft() || mode !== 'new' && !details) return;
    clearForm(); setError(''); setMessage(''); setPreview(null);
    setForm({ mode, original: mode === 'new' ? null : details!.document, metadata: mode === 'new' ? emptyMetadata() : metadataOf(details!.document), changeNote: '' });
  }
  function changedMetadata<K extends keyof DocumentMetadata>(key: K, value: DocumentMetadata[K]) {
    setForm(previous => previous && ({ ...previous, metadata: { ...previous.metadata, [key]: value } }));
    requestId.current = ''; setError(''); setMessage('');
  }
  function chooseFile(selected: File | undefined, camera: boolean) {
    if (!selected) return;
    const invalid = validateDocumentFile(selected) || (camera && !/\.(png|jpe?g)$/i.test(selected.name) ? 'Choose a JPG or PNG photo.' : '');
    if (invalid) { setError(invalid); return; }
    setFile(selected); setCameraFile(camera); setPhotoConfirmed(!camera); requestId.current = ''; setError(''); setMessage('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || busy || expired) return;
    const metadata = { ...form.metadata, title: form.metadata.title.trim(), notes: form.metadata.notes.trim() };
    if (form.mode !== 'revise') {
      if (!metadata.title || metadata.title.length > 160) { setError('Enter a document title between 1 and 160 characters.'); return; }
      if (metadata.notes.length > 2000) { setError('Use at most 2000 characters for notes.'); return; }
      if (metadata.documentDate) {
        const value = new Date(metadata.documentDate + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.documentDate) || !Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== metadata.documentDate || metadata.documentDate < '1900-01-01' || metadata.documentDate > '9999-12-31') { setError('Enter a real document date from 1900 onward, or leave it empty.'); return; }
      }
    }
    if (form.mode !== 'edit' && !file) { setError('Choose a PDF, JPG or PNG file first.'); return; }
    if (cameraFile && !photoConfirmed) { setError('Check the photo preview and choose Confirm photo before saving.'); return; }
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    try {
      if (!requestId.current) requestId.current = documentRequestId();
      const result = form.mode === 'edit' ? await updateChildDocument(childId, form.original!, metadata, controller.signal)
        : form.mode === 'new' ? await addChildDocument(childId, metadata, await readDocumentFile(file!, controller.signal), requestId.current, controller.signal)
          : await reviseChildDocument(childId, form.original!, await readDocumentFile(file!, controller.signal), form.changeNote.trim(), requestId.current, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      setSelectedId(result.document.id); setHistoryPage(1); setPage(1); clearForm(); setRefresh(value => value + 1);
      setMessage(form.mode === 'new' ? 'Document saved.' : form.mode === 'edit' ? 'Document details saved.' : 'New version saved. Previous versions are kept.');
    } catch (failure) {
      if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not save this document. Your changes are still here; try again.'));
    } finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setBusy(false); }
  }
  async function content(revision: DocumentRevision, download: boolean) {
    if (!details || contentBusy || expired) return;
    const id = details.document.id;
    const sequence = ++previewSequence.current;
    const controller = new AbortController(); requests.current.add(controller); setContentBusy(true); setError('');
    try {
      const blob = await getDocumentContent(childId, id, revision.id, download, controller.signal);
      if (controller.signal.aborted || !alive.current || sequence !== previewSequence.current) return;
      if (!download && revision.contentType === 'application/pdf') { setPreview({ url: '', blob, revision }); return; }
      const localUrl = URL.createObjectURL(new Blob([blob], { type: revision.contentType }));
      if (download) {
        const link = document.createElement('a'); link.href = localUrl; link.download = revision.filename; document.body.appendChild(link); link.click(); link.remove();
        // The click has started the download before the temporary URL is released.
        downloadUrls.current.add(localUrl);
        window.setTimeout(() => { if (downloadUrls.current.delete(localUrl)) URL.revokeObjectURL(localUrl); }, 1000);
      } else setPreview({ url: localUrl, revision });
    } catch (failure) {
      if (!controller.signal.aborted && !cancelled(failure)) setError(authError(failure, 'Could not open this file. Try again.'));
    } finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current) setContentBusy(false); }
  }
  if (expired) return null;
  return <section aria-label="Documents" className="min-w-0 space-y-4 rounded-2xl border border-violet-100 bg-violet-50/40 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-lg font-bold text-slate-800"><FileText size={21} className="text-violet-600" aria-hidden="true" />Documents</h3><p className="mt-1 text-sm text-slate-600">Keep forms and records together, including earlier versions.</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || loading} onClick={() => { if (leaveDraft()) { clearForm(); setError(''); setPreview(null); setRefresh(value => value + 1); } }} className="ska-button">Refresh documents</button>{canEdit && <button type="button" disabled={busy} onClick={() => openForm('new')} className="ska-button is-primary"><Plus size={18} aria-hidden="true" />Add document</button>}</div>
    </div>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-800">{message}</p>}
    {form && <form aria-label={form.mode === 'new' ? 'Add document' : form.mode === 'edit' ? 'Edit document details' : 'Add document version'} onSubmit={event => void save(event)} className="min-w-0 space-y-4 rounded-2xl border bg-white p-4" noValidate>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <h4 className="font-bold">{form.mode === 'new' ? 'Add a document' : form.mode === 'edit' ? 'Edit document details' : 'Upload a new version of ' + form.original?.title}</h4>
        {form.mode !== 'revise' && <>
          <label className="block">Document title<input value={form.metadata.title} maxLength={160} onChange={event => changedMetadata('title', event.target.value)} className={inputClass} required /></label>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="block min-w-0">Document category<select value={form.metadata.category} onChange={event => changedMetadata('category', event.target.value as DocumentCategory)} className={inputClass}>{Object.entries(documentCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="block min-w-0">Document date (optional)<input type="date" min="1900-01-01" max="9999-12-31" value={form.metadata.documentDate || ''} onChange={event => changedMetadata('documentDate', event.target.value || null)} className={inputClass} /></label></div>
          <label className="block">Document notes (optional)<textarea value={form.metadata.notes} rows={3} maxLength={2000} onChange={event => changedMetadata('notes', event.target.value)} className={inputClass} /></label>
        </>}
        {form.mode !== 'edit' && <>
          <div className="space-y-3"><label htmlFor={fileId} className="block font-medium">Upload a document</label><input id={fileId} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={event => { chooseFile(event.target.files?.[0], false); event.target.value = ''; }} className="block w-full min-w-0 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-3 file:font-semibold file:text-blue-800" />
            <p className="text-sm text-slate-500">PDF, JPG or PNG · Up to 5 MB per file. Scanner files work here too.</p>
            {cameraAvailable && <label htmlFor={photoId} className="ska-button inline-flex cursor-pointer"><Camera size={18} aria-hidden="true" />{cameraFile ? 'Retake photo' : 'Take a photo'}<input id={photoId} type="file" accept="image/jpeg,image/png" capture="environment" onChange={event => { chooseFile(event.target.files?.[0], true); event.target.value = ''; }} className="sr-only" /></label>}
          </div>
          {file && <div className="min-w-0 space-y-3 rounded-xl border border-blue-100 bg-blue-50/50 p-3"><p className="break-words font-semibold">{file.name}</p><p className="text-sm text-slate-600">{(file.size / 1024 / 1024).toFixed(2)} MB · Review this file before saving.</p>
            {filePreview && (file.type.startsWith('image/') || /\.(png|jpe?g)$/i.test(file.name)) && <img src={filePreview} alt={cameraFile ? 'Captured document preview' : 'Selected document preview'} className="max-h-80 w-full rounded-lg object-contain" />}
            {cameraFile && !photoConfirmed && <button type="button" onClick={() => { setPhotoConfirmed(true); setError(''); }} className="ska-button is-primary">Confirm photo</button>}
            {cameraFile && photoConfirmed && <p role="status" className="text-sm font-semibold text-blue-800">Photo confirmed. Save when the details are ready.</p>}
            <button type="button" onClick={() => { setFile(null); setCameraFile(false); setPhotoConfirmed(false); requestId.current = ''; }} className="ska-button">Remove selected file</button>
          </div>}
          {form.mode === 'revise' && <label className="block">Change note (optional)<textarea rows={2} maxLength={500} value={form.changeNote} onChange={event => { setForm({ ...form, changeNote: event.target.value }); requestId.current = ''; setError(''); }} className={inputClass} /></label>}
        </>}
        <div className="flex flex-wrap gap-3"><button disabled={busy || cameraFile && !photoConfirmed} className="ska-button is-primary"><Upload size={18} aria-hidden="true" />{busy ? 'Saving document…' : form.mode === 'edit' ? 'Save document details' : form.mode === 'revise' ? 'Save new version' : 'Save document'}</button>
          <button type="button" onClick={() => { if (leaveDraft()) { clearForm(); setError(''); } }} className="ska-button">Cancel document changes</button></div>
      </fieldset>
    </form>}
    {loading ? <p role="status">Loading documents…</p> : !documents.length ? <p className="rounded-xl bg-white p-4 text-sm text-slate-600">No documents saved yet.</p> : <>
      <ul className="space-y-2">{documents.map(item => <li key={item.id}><button type="button" disabled={busy} aria-pressed={selectedId === item.id} onClick={() => { if (leaveDraft()) { clearForm(); setError(''); setSelectedId(item.id); setHistoryPage(1); } }} className={'w-full min-w-0 rounded-xl border p-4 text-left disabled:opacity-50 ' + (selectedId === item.id ? 'border-violet-400 bg-violet-100/70' : 'border-slate-200 bg-white')}>
        <span className="block break-words font-bold">{item.title}</span><span className="mt-1 block text-sm text-slate-600">{documentCategories[item.category]} · Updated {dateTime(item.updatedAt)}</span></button></li>)}</ul>
      {total > 10 && <div className="flex flex-wrap items-center gap-3"><button disabled={page === 1 || busy} type="button" onClick={() => setPage(value => value - 1)} className="ska-button">Previous documents</button><span className="text-sm">Page {page} of {Math.ceil(total / 10)}</span><button disabled={page * 10 >= total || busy} type="button" onClick={() => setPage(value => value + 1)} className="ska-button">Next documents</button></div>}
    </>}
    {detailLoading && <p role="status">Loading document history…</p>}
    {details && <section aria-label="Selected document" className="min-w-0 space-y-4 rounded-2xl border bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-lg font-bold">{details.document.title}</h4><p className="mt-1 text-sm text-slate-600">{documentCategories[details.document.category]}{details.document.documentDate ? ' · Document date ' + details.document.documentDate : ''}</p></div>
        <button type="button" disabled={busy} aria-label="Close selected document" onClick={() => { if (leaveDraft()) { clearForm(); setSelectedId(''); } }} className="ska-button"><X size={18} aria-hidden="true" />Close</button></div>
      {details.document.notes && <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{details.document.notes}</p>}
      {canEdit && <div className="flex flex-wrap gap-3"><button disabled={busy} type="button" onClick={() => openForm('edit')} className="ska-button">Edit document details</button><button disabled={busy} type="button" onClick={() => openForm('revise')} className="ska-button"><Upload size={18} aria-hidden="true" />Upload new version</button></div>}
      <h5 className="flex items-center gap-2 font-bold"><History size={18} className="text-violet-600" aria-hidden="true" />Version history</h5>
      <ol className="space-y-3">{details.revisions.map(item => <li key={item.id} className="min-w-0 rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center gap-2"><span className="font-bold">Version {item.revision}</span>{item.current && <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800">Current version</span>}</div><p className="mt-1 break-words text-sm">{item.filename}</p><p className="mt-1 break-words text-sm text-slate-600">Uploaded by {item.uploadedBy} · {dateTime(item.uploadedAt)}</p>{item.changeNote && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.changeNote}</p>}
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={contentBusy} onClick={() => void content(item, false)} aria-label={'Preview version ' + item.revision} className="ska-button"><FileText size={17} aria-hidden="true" />Preview</button><button type="button" disabled={contentBusy} onClick={() => void content(item, true)} aria-label={'Download version ' + item.revision} className="ska-button"><Download size={17} aria-hidden="true" />Download</button></div></li>)}</ol>
      {contentBusy && <p role="status">Opening file…</p>}
      {details.total > 10 && <div className="flex flex-wrap items-center gap-3"><button disabled={historyPage === 1 || busy} type="button" onClick={() => setHistoryPage(value => value - 1)} className="ska-button">Previous versions</button><span className="text-sm">Page {historyPage} of {Math.ceil(details.total / 10)}</span><button disabled={historyPage * 10 >= details.total || busy} type="button" onClick={() => setHistoryPage(value => value + 1)} className="ska-button">Next versions</button></div>}
    </section>}
    {preview && <section aria-label="Document preview" className="min-w-0 space-y-3 rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="break-words font-bold">Preview · Version {preview.revision.revision}</h4><button type="button" onClick={() => { previewSequence.current++; setPreview(null); }} className="ska-button">Close preview</button></div>
      {preview.revision.contentType === 'application/pdf' ? <Suspense fallback={<p role="status">Loading PDF preview…</p>}><PdfDocumentPreview blob={preview.blob!} /></Suspense> : <img src={preview.url} alt={'Document version ' + preview.revision.revision + ' preview'} className="max-h-[36rem] w-full rounded-xl object-contain" />}
    </section>}
  </section>;
}
