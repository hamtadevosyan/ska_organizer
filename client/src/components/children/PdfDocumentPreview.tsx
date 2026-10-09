import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { LocalPdfFontFactory } from './pdfStandardFonts';

type RenderTask = ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>;
const maximumCanvasPixels = 4 * 1024 * 1024;
const failureMessage = 'This PDF cannot be previewed here. Use Download in the version history.';

// Only document pixels are displayed. No PDF JavaScript, forms, links or
// annotation layers are mounted into the application's DOM. Saved annotation
// appearances (signatures, checks and stamps) are painted as document pixels.
export default function PdfDocumentPreview({ blob }: { blob: Blob }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(320);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const annotationMode = useRef(1);

  useEffect(() => {
    const target = container.current;
    const resize = () => { const available = target?.clientWidth || 320; setWidth(Math.max(1, Math.min(available, 1000))); };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (target) observer?.observe(target);
    window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, []);

  useEffect(() => {
    const target = canvas.current;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(null); setPageNumber(1); setLoading(true); setError('');
    void (async () => {
      try {
        const library = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        library.GlobalWorkerOptions.workerSrc = workerUrl;
        annotationMode.current = library.AnnotationMode.ENABLE;
        task = library.getDocument({ data, isEvalSupported: false, disableFontFace: true,
          useWorkerFetch: false, useSystemFonts: false, BinaryDataFactory: LocalPdfFontFactory, maxImageSize: 20 * 1000 * 1000,
          canvasMaxAreaInBytes: 16 * 1024 * 1024, enableXfa: false, useWasm: false, verbosity: 0,
          disableRange: true, disableStream: true, disableAutoFetch: true });
        const document = await task.promise;
        if (cancelled) return;
        if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > 100000) throw new Error('Unsupported page count.');
        setPdf(document); setLoading(false);
      } catch {
        if (!cancelled) { setError(failureMessage); setLoading(false); }
      }
    })();
    return () => {
      cancelled = true;
      if (task) void task.destroy().catch(() => {});
      if (target) { target.width = 0; target.height = 0; }
    };
  }, [blob]);

  useEffect(() => {
    const target = canvas.current;
    if (!pdf || !target) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined;
    setRendering(true); setError('');
    void (async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const original = page.getViewport({ scale: 1 });
        if (![original.width, original.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Unsupported page size.');
        const displayScale = Math.min(width / original.width, 2400 / original.height);
        const density = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
        const scale = Math.min(displayScale * density,
          Math.sqrt(maximumCanvasPixels / (original.width * original.height)),
          4096 / original.width, 4096 / original.height);
        if (!Number.isFinite(scale) || scale <= 0) throw new Error('Unsupported page size.');
        const viewport = page.getViewport({ scale });
        target.width = Math.max(1, Math.floor(viewport.width)); target.height = Math.max(1, Math.floor(viewport.height));
        target.style.width = Math.max(1, Math.floor(original.width * displayScale)) + 'px';
        target.style.height = Math.max(1, Math.floor(original.height * displayScale)) + 'px';
        const context = target.getContext('2d');
        if (!context) throw new Error('Canvas unavailable.');
        task = page.render({ canvas: target, viewport, annotationMode: annotationMode.current, background: '#ffffff' });
        await task.promise;
        if (!cancelled) setRendering(false);
      } catch {
        if (!cancelled) { target.width = 0; target.height = 0; setError(failureMessage); setRendering(false); }
      }
    })();
    return () => { cancelled = true; task?.cancel(); page?.cleanup(); target.width = 0; target.height = 0; };
  }, [pdf, pageNumber, width]);

  return <div ref={container} className="min-w-0 space-y-3">
    {loading && <p role="status">Loading PDF preview…</p>}
    {error && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error}</p>}
    {pdf && !error && <>
      <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={pageNumber <= 1 || rendering} onClick={() => setPageNumber(value => value - 1)} className="ska-button">Previous PDF page</button><span className="text-sm">Page {pageNumber} of {pdf.numPages}</span><button type="button" disabled={pageNumber >= pdf.numPages || rendering} onClick={() => setPageNumber(value => value + 1)} className="ska-button">Next PDF page</button></div>
      {rendering && <p role="status">Rendering PDF page…</p>}
    </>}
    <canvas ref={canvas} role="img" aria-label={'PDF page ' + pageNumber} hidden={loading || rendering || !!error} style={{ display: loading || rendering || error ? 'none' : 'block' }} className="mx-auto max-w-full rounded-xl border bg-white" />
  </div>;
}
