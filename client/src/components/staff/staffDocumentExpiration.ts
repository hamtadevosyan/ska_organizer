import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { LocalPdfFontFactory } from '../children/pdfStandardFonts';
import { readStaffDocumentImage } from '../../api/staffDocumentOcr';

export type ExpirationCandidate = { date: string; label: string };
export type ExpirationAnalysis = { candidates: ExpirationCandidate[]; incomplete: boolean };
const maximumFileBytes = 5 * 1024 * 1024;
const maximumText = 80000;
const maximumPages = 5;
const maximumPixels = 4 * 1024 * 1024;
const maximumDimension = 2200;
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const labelPattern = /\b(?:expiration(?:\s+date)?|expiry(?:\s+date)?|expires(?:\s+on)?|valid\s+(?:until|through))\b\s*[:-]?\s*/gi;
const monthPattern = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?';
const datePattern = new RegExp(`\\b(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|${monthPattern}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${monthPattern}[,]?\\s+\\d{4})\\b`, 'gi');

function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDate(value: string): string | null {
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (numeric) {
    const first = Number(numeric[1]); const second = Number(numeric[2]);
    // A date such as 03/04/2027 can mean March 4 or April 3. Ask the user
    // instead of applying a locale assumption to a private certificate.
    if (first <= 12 && second <= 12 && first !== second) return null;
    return first > 12 ? calendarDate(Number(numeric[3]), second, first) : calendarDate(Number(numeric[3]), first, second);
  }
  const named = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})$/i.exec(value)
    || /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?[,]?\s+(\d{4})$/i.exec(value);
  if (!named) return null;
  const monthFirst = Number.isNaN(Number(named[1]));
  const month = months.indexOf((monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase()) + 1;
  return calendarDate(Number(named[3]), month, Number(monthFirst ? named[2] : named[1]));
}

// Read only dates adjacent to an explicit expiration label. Never infer an
// expiration from an issue date, birth date or a certificate's duration.
export function expirationCandidates(text: string): ExpirationCandidate[] {
  const source = text.slice(0, maximumText).replace(/\r/g, '');
  const candidates = new Map<string, ExpirationCandidate>();
  const labels = source.matchAll(labelPattern);
  for (const match of labels) {
    const after = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 120);
    const section = after.split(/\n\s*\n|\b(?:issued|issue\s+date|date\s+of\s+birth|born|effective|completed|expiration|expiry|expires|valid\s+(?:until|through))\b/i)[0];
    const dateToken = Array.from(section.matchAll(datePattern))[0];
    if (!dateToken || (dateToken.index ?? 0) > 40) continue;
    // Prefixes must be punctuation/whitespace or the ordinary word "on".
    // This prevents "expires 2 years after completion on ..." becoming a date.
    const prefix = section.slice(0, dateToken.index).trim();
    if (!/^(?:on\s*)?[:=\-–—()\s]*$/i.test(prefix)) continue;
    const date = parseDate(dateToken[0]);
    if (!date) continue;
    const label = (match[0] + section.slice(0, (dateToken.index ?? 0) + dateToken[0].length)).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!candidates.has(date)) candidates.set(date, { date, label });
    if (candidates.size === 8) break;
  }
  return [...candidates.values()];
}

function aborted(): DOMException { return new DOMException('Document analysis cancelled.', 'AbortError'); }
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const stop = () => { reject(aborted()); };
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); if (signal.aborted) reject(aborted()); else resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
  });
}

function size(width: number, height: number) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid document dimensions.');
  const scale = Math.min(1, maximumDimension / width, maximumDimension / height, Math.sqrt(maximumPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}
function imageData(canvas: HTMLCanvasElement): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = canvas.toDataURL('image/png');
    const image = data.startsWith('data:image/png;base64,') ? data.slice('data:image/png;base64,'.length) : '';
    if (!image) throw new Error('Document image is unavailable.');
    if (image.length <= Math.ceil(maximumFileBytes / 3) * 4) return image;
    const smaller = document.createElement('canvas');
    try {
      smaller.width = Math.max(1, Math.floor(canvas.width * 0.7)); smaller.height = Math.max(1, Math.floor(canvas.height * 0.7));
      const smallerContext = smaller.getContext('2d'); const context = canvas.getContext('2d');
      if (!smallerContext || !context) throw new Error('Document image is unavailable.');
      smallerContext.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      canvas.width = smaller.width; canvas.height = smaller.height;
      context.drawImage(smaller, 0, 0);
    } finally { smaller.width = 0; smaller.height = 0; }
  }
  throw new Error('Document image is too large to analyze.');
}

async function imageText(staffId: string, file: File, signal: AbortSignal): Promise<string> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  try {
    await waitFor(new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('Document image is unavailable.')); image.src = url;
    }), signal);
    if (image.naturalWidth * image.naturalHeight > 20 * 1000 * 1000) throw new Error('Document image dimensions are too large.');
    const dimensions = size(image.naturalWidth, image.naturalHeight);
    canvas.width = dimensions.width; canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Document image is unavailable.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await readStaffDocumentImage(staffId, imageData(canvas), signal);
  } finally {
    image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0;
  }
}

async function pdfText(staffId: string, file: File, signal: AbortSignal): Promise<{ text: string; incomplete: boolean }> {
  let loading: PDFDocumentLoadingTask | undefined;
  let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined;
  let rendering: ReturnType<NonNullable<typeof page>['render']> | undefined;
  let canvas: HTMLCanvasElement | undefined;
  const cleanup = () => { rendering?.cancel(); page?.cleanup(); if (canvas) { canvas.width = 0; canvas.height = 0; } };
  const stop = () => { cleanup(); if (loading) void loading.destroy().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const library = await waitFor(import('pdfjs-dist/legacy/build/pdf.mjs'), signal);
    const data = new Uint8Array(await waitFor(file.arrayBuffer(), signal));
    library.GlobalWorkerOptions.workerSrc = workerUrl;
    class ScopedPdfFontFactory extends LocalPdfFontFactory { constructor() { super(signal); } }
    loading = library.getDocument({ data, isEvalSupported: false, disableFontFace: true, useWorkerFetch: false,
      useSystemFonts: false, BinaryDataFactory: ScopedPdfFontFactory, maxImageSize: 20 * 1000 * 1000,
      canvasMaxAreaInBytes: 16 * 1024 * 1024, enableXfa: false, useWasm: false, verbosity: 0,
      disableRange: true, disableStream: true, disableAutoFetch: true });
    const pdf = await waitFor(loading.promise, signal);
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 100000) throw new Error('Unsupported PDF page count.');
    let text = ''; let incomplete = pdf.numPages > maximumPages;
    for (let number = 1; number <= Math.min(pdf.numPages, maximumPages); number++) {
      try {
        page = await waitFor(pdf.getPage(number), signal);
        const content = await waitFor(page.getTextContent(), signal);
        let pageText = '';
        for (const item of content.items.slice(0, 10000)) {
          if ('str' in item) pageText += item.str.slice(0, maximumText - pageText.length) + (item.hasEOL ? '\n' : ' ');
          if (pageText.length >= maximumText) { incomplete = true; break; }
        }
        if (content.items.length > 10000) incomplete = true;
        text += '\n' + pageText;
        if (pageText.trim().length < 20) {
          const original = page.getViewport({ scale: 1 }); size(original.width, original.height);
          // Render a scan at useful OCR resolution without exceeding the same
          // canvas bounds as a photo. No links, scripts or form DOM is mounted.
          const scale = Math.min(maximumDimension / original.width, maximumDimension / original.height,
            Math.sqrt(maximumPixels / (original.width * original.height)));
          if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid PDF dimensions.');
          const viewport = page.getViewport({ scale });
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
          if (!canvas.getContext('2d')) throw new Error('Document image is unavailable.');
          rendering = page.render({ canvas, viewport, annotationMode: library.AnnotationMode.ENABLE, background: '#ffffff' });
          await waitFor(rendering.promise, signal);
          text += '\n' + await readStaffDocumentImage(staffId, imageData(canvas), signal);
        }
        if (text.length > maximumText) { text = text.slice(0, maximumText); incomplete = true; break; }
      } catch (error) {
        if (signal.aborted) throw error;
        incomplete = true;
      } finally { cleanup(); page = undefined; rendering = undefined; canvas = undefined; }
    }
    return { text, incomplete };
  } finally { signal.removeEventListener('abort', stop); cleanup(); if (loading) void loading.destroy().catch(() => {}); }
}

export async function analyzeStaffDocumentExpiration(staffId: string, file: File, signal: AbortSignal): Promise<ExpirationAnalysis> {
  if (signal.aborted) throw aborted();
  if (file.size <= 0 || file.size > maximumFileBytes) return { candidates: [], incomplete: true };
  const controller = new AbortController();
  const stop = () => controller.abort(); signal.addEventListener('abort', stop, { once: true });
  const timeout = window.setTimeout(stop, 60000);
  try {
    let text: string; let incomplete = false;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const result = await pdfText(staffId, file, controller.signal); text = result.text; incomplete = result.incomplete;
    } else if (['image/jpeg', 'image/png'].includes(file.type)) text = await imageText(staffId, file, controller.signal);
    else return { candidates: [], incomplete: true };
    return { candidates: expirationCandidates(text), incomplete };
  } catch (error) {
    if (signal.aborted) throw error;
    return { candidates: [], incomplete: true };
  } finally { window.clearTimeout(timeout); signal.removeEventListener('abort', stop); controller.abort(); }
}
