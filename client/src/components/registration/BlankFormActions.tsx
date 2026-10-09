import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Download, FileText, Printer, Share2 } from 'lucide-react';
import { authError, onSessionExpired } from '../../auth/transport';
import { getRegistrationForm, getRegistrationFormContent } from '../../api/registrationForms';
import type { RegistrationForm } from '../../api/registrationForms';
import type { DocumentRevision } from '../../api/childDocuments';
import { LocalPdfFontFactory } from '../children/pdfStandardFonts';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

const PdfDocumentPreview = lazy(() => import('../children/PdfDocumentPreview'));
const cancelled = (failure: unknown) => axios.isCancel(failure) || failure instanceof DOMException && failure.name === 'AbortError';
const maximumPrintPixels = 32 * 1024 * 1024;
const maximumPrintDataCharacters = 32 * 1024 * 1024;
const printLimitMessage = 'This blank form is too large to print here. Download the blank form to print all its pages.';

// Print only rasterized blank template pages. Never mount a PDF's scripts,
// links or active annotation layers, or include the surrounding child profile.
type PreparedPrint = { frame: HTMLIFrameElement; pages: number };
async function prepareBlankPrint(blob: Blob, revision: DocumentRevision, title: string, signal: AbortSignal, holder: HTMLDivElement, register: (cleanup: () => void) => void): Promise<PreparedPrint | undefined> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.title = 'Blank form print'; frame.style.cssText = 'display:block;width:100%;height:360px;border:0;background:white';
  const cleanup = () => frame.remove(); register(cleanup);
  // Wait for the frame's own document before adding pixels. Otherwise its
  // initial navigation can replace a document populated too early.
  await new Promise<void>((resolve, reject) => {
    const stop = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const done = () => { signal.removeEventListener('abort', stop); resolve(); };
    frame.addEventListener('load', done, { once: true });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) { stop(); return; }
    holder.appendChild(frame);
  });
  if (signal.aborted) { cleanup(); return; }
  const target = frame.contentDocument;
  if (!target || !frame.contentWindow) { cleanup(); throw new Error('Print is unavailable. Download the blank form to print it.'); }
  target.title = 'Blank form · ' + title;
  const style = target.createElement('style');
  style.textContent = '@page{margin:12mm}body{margin:0}img{display:block;max-width:100%;height:auto;margin:auto;break-after:page}img:last-child{break-after:auto}';
  target.head.appendChild(style);
  let totalDataCharacters = 0; let totalPixels = 0;
  const append = (source: string) => {
    totalDataCharacters += source.length;
    if (totalDataCharacters > maximumPrintDataCharacters) throw new Error(printLimitMessage);
    const image = target.createElement('img'); image.src = source; image.alt = 'Blank form page'; target.body.appendChild(image);
  };
  try {
    if (revision.contentType === 'application/pdf') {
      const library = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (signal.aborted) return;
      library.GlobalWorkerOptions.workerSrc = workerUrl;
      const task = library.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false,
        disableFontFace: true, useWorkerFetch: false, useSystemFonts: false, BinaryDataFactory: LocalPdfFontFactory,
        maxImageSize: 20 * 1000 * 1000, canvasMaxAreaInBytes: 16 * 1024 * 1024,
        enableXfa: false, useWasm: false, verbosity: 0, disableRange: true, disableStream: true, disableAutoFetch: true });
      const stop = () => { void task.destroy().catch(() => {}); }; signal.addEventListener('abort', stop, { once: true });
      try {
        const pdf = await task.promise;
        if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 100) throw new Error(printLimitMessage);
        for (let number = 1; number <= pdf.numPages; number++) {
          if (signal.aborted) return;
          const page = await pdf.getPage(number); const original = page.getViewport({ scale: 1 });
          const scale = Math.min(2, Math.sqrt(4 * 1024 * 1024 / (original.width * original.height)), 4096 / original.width, 4096 / original.height);
          if (![original.width, original.height, scale].every(value => Number.isFinite(value) && value > 0)) throw new Error('Download this blank form to print it.');
          const viewport = page.getViewport({ scale }); const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
          try {
            totalPixels += canvas.width * canvas.height;
            if (totalPixels > maximumPrintPixels) throw new Error(printLimitMessage);
            await page.render({ canvas, viewport, annotationMode: library.AnnotationMode.ENABLE, background: '#ffffff' }).promise;
            if (signal.aborted) return; append(canvas.toDataURL('image/png'));
          } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
        }
      } finally { signal.removeEventListener('abort', stop); await task.destroy().catch(() => {}); }
    } else {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); const stop = () => { reader.abort(); reject(new DOMException('Cancelled', 'AbortError')); };
        signal.addEventListener('abort', stop, { once: true });
        reader.onload = () => { signal.removeEventListener('abort', stop); resolve(String(reader.result)); };
        reader.onerror = () => { signal.removeEventListener('abort', stop); reject(new Error('Could not open the blank form for printing.')); };
        reader.readAsDataURL(new Blob([blob], { type: revision.contentType }));
      });
      if (signal.aborted) return; append(source);
    }
    await Promise.all(Array.from(target.images).map(image => image.decode()));
    if (signal.aborted) return;
    // The caller exposes a ready button. Printing happens directly in that
    // click handler, rather than after asynchronous fetch/render/decode work.
    return { frame, pages: target.images.length };
  } catch (failure) { cleanup(); throw failure; }
}

export function BlankFormActions({ form, revision, disabled = false }: { form: RegistrationForm; revision?: DocumentRevision; disabled?: boolean }) {
  const [preview, setPreview] = useState<{ blob: Blob; revision: DocumentRevision; url: string } | null>(null);
  const [preparedPrint, setPreparedPrint] = useState<PreparedPrint | null>(null);
  const printHolder = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [expired, setExpired] = useState(false);
  const requests = useRef(new Set<AbortController>()); const urls = useRef(new Set<string>()); const printCleanup = useRef(new Set<() => void>()); const alive = useRef(true);
  const generation = useRef(0);
  const suffix = form.title + (revision && !revision.current ? ' version ' + revision.revision : '');
  useEffect(() => {
    alive.current = true;
    const stop = () => { requests.current.forEach(request => request.abort()); requests.current.clear(); urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear(); printCleanup.current.forEach(cleanup => cleanup()); printCleanup.current.clear(); };
    const unsubscribe = onSessionExpired(() => { generation.current++; stop(); setPreview(null); setPreparedPrint(null); setBusy(false); setError(''); setMessage(''); setExpired(true); });
    return () => { alive.current = false; stop(); unsubscribe(); };
  }, []);
  useEffect(() => {
    generation.current++; requests.current.forEach(request => request.abort()); requests.current.clear();
    urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear(); printCleanup.current.forEach(cleanup => cleanup()); printCleanup.current.clear();
    setPreview(null); setPreparedPrint(null); setBusy(false); setError(''); setMessage('');
  }, [form.id, form.currentRevisionId, revision?.id]);
  useEffect(() => () => { if (preview?.url && urls.current.delete(preview.url)) URL.revokeObjectURL(preview.url); }, [preview]);
  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob); urls.current.add(url);
    const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => { if (urls.current.delete(url)) URL.revokeObjectURL(url); }, 1000);
  }
  async function open(action: 'preview' | 'download' | 'share' | 'print') {
    if (busy || disabled || expired) return;
    printCleanup.current.forEach(cleanup => cleanup()); printCleanup.current.clear(); setPreparedPrint(null);
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
      // Shared names use only the catalog title; never any child's personal data.
      const name = 'blank-' + (form.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100) || 'registration-form') + (selected.contentType === 'application/pdf' ? '.pdf' : selected.contentType === 'image/png' ? '.png' : '.jpg');
      if (action === 'download') download(blob, name);
      else if (action === 'share') {
        const file = new File([blob], name, { type: selected.contentType });
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          try { await navigator.share({ files: [file], title: 'Blank ' + form.title }); }
          catch (failure) { if (controller.signal.aborted || !alive.current || epoch !== generation.current || failure instanceof DOMException && failure.name === 'AbortError') return; download(blob, name); setMessage('Sharing is unavailable here. The blank form was downloaded for you to share.'); }
        } else { download(blob, name); setMessage('The blank form was downloaded for you to share.'); }
      } else if (action === 'print') {
        if (!printHolder.current) throw new Error('Print is unavailable. Download the blank form to print it.');
        const prepared = await prepareBlankPrint(blob, selected, form.title, controller.signal, printHolder.current, cleanup => printCleanup.current.add(cleanup));
        if (prepared && !controller.signal.aborted && alive.current && epoch === generation.current) setPreparedPrint(prepared);
      } else {
        const url = selected.contentType === 'application/pdf' ? '' : URL.createObjectURL(blob); if (url) urls.current.add(url);
        setPreview({ blob, revision: selected, url });
      }
    } catch (failure) { if (!controller.signal.aborted && !cancelled(failure) && alive.current && epoch === generation.current) setError(authError(failure, failure instanceof Error ? failure.message : 'Could not open the blank form. Try again.')); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted && alive.current && epoch === generation.current) setBusy(false); }
  }
  function closePrint() {
    printCleanup.current.forEach(cleanup => cleanup()); printCleanup.current.clear(); setPreparedPrint(null); setMessage('');
  }
  function printPrepared() {
    if (!preparedPrint || !preparedPrint.frame.isConnected || busy || expired || disabled) return;
    try {
      const target = preparedPrint.frame.contentWindow;
      if (!target) throw new Error('Print is unavailable. Download the blank form to print it.');
      // No awaits: retain the user's activation for the browser print dialog.
      target.focus(); target.print();
      setMessage('Choose your printer in the print dialog. If it did not open, use Download blank form and print the downloaded file.');
    } catch { setError('Print is unavailable here. Download the blank form to print it.'); }
  }
  if (expired) return null;
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2">
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Preview blank ' + suffix} onClick={() => void open('preview')}><FileText size={17} aria-hidden="true" />Preview blank form</button>
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Download blank ' + suffix} onClick={() => void open('download')}><Download size={17} aria-hidden="true" />Download blank form</button>
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Print blank ' + suffix} onClick={() => void open('print')}><Printer size={17} aria-hidden="true" />Print blank form</button>
      <button type="button" className="ska-button" disabled={disabled || busy} aria-label={'Share blank ' + suffix} onClick={() => void open('share')}><Share2 size={17} aria-hidden="true" />Share blank form</button>
    </div>
    {busy && <p role="status" className="text-sm">Opening blank form…</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="text-sm text-blue-800">{message}</p>}
    <section hidden={!preparedPrint} aria-label="Blank form ready to print" className="min-w-0 space-y-3 rounded-xl border bg-white p-3">
      <h5 className="break-words font-bold">Blank {form.title} · Ready to print</h5>
      <p>{preparedPrint?.pages} {preparedPrint?.pages === 1 ? 'page' : 'pages'} · Only this blank form will be printed.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="ska-button is-primary" disabled={!preparedPrint || busy || disabled} onClick={printPrepared}><Printer size={17} aria-hidden="true" />Open print dialog</button>
        <button type="button" className="ska-button" onClick={closePrint}>Close print preview</button></div>
      <div ref={printHolder} className="overflow-hidden rounded-lg border" />
    </section>
    {preview && <section aria-label={'Blank form preview · ' + suffix} className="min-w-0 space-y-3 rounded-xl border bg-white p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="break-words font-bold">Blank {form.title} · Version {preview.revision.revision}</h5><button type="button" className="ska-button" onClick={() => setPreview(null)}>Close blank preview</button></div>
      {preview.revision.contentType === 'application/pdf' ? <Suspense fallback={<p role="status">Loading PDF preview…</p>}><PdfDocumentPreview blob={preview.blob} /></Suspense> : <img src={preview.url} alt={'Blank ' + form.title + ' preview'} className="max-h-[36rem] w-full rounded-xl object-contain" />}
    </section>}
  </div>;
}
