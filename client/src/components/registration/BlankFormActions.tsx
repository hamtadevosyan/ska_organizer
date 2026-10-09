import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Download, FileText, Share2 } from 'lucide-react';
import { authError, onSessionExpired } from '../../auth/transport';
import { getRegistrationForm, getRegistrationFormContent } from '../../api/registrationForms';
import type { RegistrationForm } from '../../api/registrationForms';
import type { DocumentRevision } from '../../api/childDocuments';

const PdfDocumentPreview = lazy(() => import('../children/PdfDocumentPreview'));
const cancelled = (failure: unknown) => axios.isCancel(failure) || failure instanceof DOMException && failure.name === 'AbortError';
type PreparedShare = { file: File; title: string; native: boolean; generation: number };
const shareFailure = 'Could not open the share menu. Try again, or download the blank form to share or print it.';

export function BlankFormActions({ form, revision, disabled = false }: { form: RegistrationForm; revision?: DocumentRevision; disabled?: boolean }) {
  const [preview, setPreview] = useState<{ blob: Blob; revision: DocumentRevision; url: string } | null>(null);
  const [preparedShare, setPreparedShare] = useState<PreparedShare | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [expired, setExpired] = useState(false);
  const requests = useRef(new Set<AbortController>()); const urls = useRef(new Set<string>()); const alive = useRef(true);
  const generation = useRef(0);
  const suffix = form.title + (revision && !revision.current ? ' version ' + revision.revision : '');
  useEffect(() => {
    alive.current = true;
    const stop = () => { requests.current.forEach(request => request.abort()); requests.current.clear(); urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear(); };
    const unsubscribe = onSessionExpired(() => { generation.current++; stop(); setPreview(null); setPreparedShare(null); setBusy(false); setError(''); setMessage(''); setExpired(true); });
    return () => { alive.current = false; stop(); unsubscribe(); };
  }, []);
  useEffect(() => {
    generation.current++; requests.current.forEach(request => request.abort()); requests.current.clear();
    urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear();
    setPreview(null); setPreparedShare(null); setBusy(false); setError(''); setMessage('');
  }, [form.id, form.title, form.currentRevisionId, revision?.id]);
  useEffect(() => () => { if (preview?.url && urls.current.delete(preview.url)) URL.revokeObjectURL(preview.url); }, [preview]);
  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob); urls.current.add(url);
    const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => { if (urls.current.delete(url)) URL.revokeObjectURL(url); }, 1000);
  }
  async function open(action: 'preview' | 'download' | 'share') {
    if (busy || disabled || expired) return;
    setPreparedShare(null);
    const controller = new AbortController(); requests.current.add(controller); setBusy(true); setError(''); setMessage('');
    const epoch = generation.current;
    try {
      let selected = revision;
      if (!selected) {
        const latest = await getRegistrationForm(form.id, controller.signal);
        if (latest.form.currentRevisionId !== form.currentRevisionId) throw new Error('The blank form changed. Refresh the checklist and try again.');
        selected = latest.revisions.find(item => item.id === form.currentRevisionId);
      }
      if (!selected) throw new Error('The blank form changed. Refresh the checklist and try again.');
      const response = await getRegistrationFormContent(form.id, selected.id, action === 'download' || action === 'share', controller.signal);
      if (controller.signal.aborted || !alive.current || epoch !== generation.current) return;
      const blob = new Blob([response], { type: selected.contentType });
      // Export only the chosen blank template, with a name from the catalog.
      // Never share a child's completed copy, private URL or profile details.
      const name = 'blank-' + (form.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100) || 'registration-form') + (selected.contentType === 'application/pdf' ? '.pdf' : selected.contentType === 'image/png' ? '.png' : '.jpg');
      if (action === 'download') download(blob, name);
      else if (action === 'share') {
        const file = new File([blob], name, { type: selected.contentType });
        let native = false;
        try { native = typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); } catch { /* Download remains available for this file. */ }
        setPreparedShare({ file, title: form.title, native, generation: epoch });
      } else {
        const url = selected.contentType === 'application/pdf' ? '' : URL.createObjectURL(blob); if (url) urls.current.add(url);
        setPreview({ blob, revision: selected, url });
      }
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure) && alive.current && epoch === generation.current) setError(authError(failure, failure instanceof Error ? failure.message : 'Could not open the blank form. Try again.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current && epoch === generation.current) setBusy(false); }
  }
  async function sharePrepared() {
    if (!preparedShare || busy || disabled || expired || preparedShare.generation !== generation.current) return;
    const selected = preparedShare;
    setError(''); setMessage('');
    if (!selected.native) {
      download(selected.file, selected.file.name);
      setMessage('The blank form was downloaded. Open the file to share or print it.');
      return;
    }
    setBusy(true);
    try {
      // The file is already fetched. Call the native menu directly in this tap,
      // before awaiting anything, so slow fetching cannot consume activation.
      await navigator.share({ files: [selected.file], title: 'Blank ' + selected.title });
    } catch (failure) {
      if (alive.current && selected.generation === generation.current && !cancelled(failure)) setError(shareFailure);
    } finally { if (alive.current && selected.generation === generation.current) setBusy(false); }
  }
  if (expired) return null;
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2">
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Preview blank ' + suffix} onClick={() => void open('preview')}><FileText size={17} aria-hidden="true" />Preview blank form</button>
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Download blank ' + suffix} onClick={() => void open('download')}><Download size={17} aria-hidden="true" />Download blank form</button>
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Share / Print blank ' + suffix} onClick={() => void open('share')}><Share2 size={17} aria-hidden="true" />Share / Print</button>
    </div>
    {busy && <p role="status" className="text-sm">Opening blank form…</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="text-sm text-blue-800">{message}</p>}
    {preparedShare && <section aria-label="Share or print blank form" className="min-w-0 space-y-3 rounded-xl border bg-white p-3">
      <h5 className="break-words font-bold">Blank {preparedShare.title}</h5>
      <p className="text-sm">{preparedShare.native ? "Use your device's menu to share or print this blank form." : 'Download this blank form, then open it to share or print.'}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="ska-button is-primary" disabled={busy || disabled} onClick={() => void sharePrepared()}><Share2 size={17} aria-hidden="true" />{preparedShare.native ? 'Open share menu' : 'Download to share or print'}</button>
        <button type="button" className="ska-button" disabled={busy} onClick={() => { setPreparedShare(null); setError(''); setMessage(''); }}>Close share options</button></div>
    </section>}
    {preview && <section aria-label={'Blank form preview · ' + suffix} className="min-w-0 space-y-3 rounded-xl border bg-white p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="break-words font-bold">Blank {form.title} · Version {preview.revision.revision}</h5><button type="button" className="ska-button" onClick={() => setPreview(null)}>Close blank preview</button></div>
      {preview.revision.contentType === 'application/pdf' ? <Suspense fallback={<p role="status">Loading PDF preview…</p>}><PdfDocumentPreview blob={preview.blob} /></Suspense> : <img src={preview.url} alt={'Blank ' + form.title + ' preview'} className="max-h-[36rem] w-full rounded-xl object-contain" />}
    </section>}
  </div>;
}
