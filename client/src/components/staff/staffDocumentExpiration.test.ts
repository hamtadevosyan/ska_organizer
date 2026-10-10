import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { analyzeStaffDocumentExpiration, expirationCandidates } from './staffDocumentExpiration';
import { LocalPdfFontFactory } from '../children/pdfStandardFonts';

const fixture = vi.hoisted(() => ({ getDocument: vi.fn(), getPage: vi.fn(), text: vi.fn(), destroy: vi.fn(), cleanup: vi.fn(),
  render: vi.fn(), cancel: vi.fn(), ocr: vi.fn(), worker: { workerSrc: '' }, revoke: vi.fn(), createUrl: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: fixture.getDocument, GlobalWorkerOptions: fixture.worker, AnnotationMode: { ENABLE: 1 } }));
vi.mock('../../api/staffDocumentOcr', () => ({ readStaffDocumentImage: fixture.ocr }));

function pdfPage(width = 600, height = 800) {
  return { getTextContent: fixture.text, cleanup: fixture.cleanup, render: fixture.render,
    getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }) };
}
function file(type = 'application/pdf', name = 'private-certificate.pdf') {
  const value = new File(['%PDF private bytes'], name, { type });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => new Uint8Array([37, 80, 68, 70]).buffer });
  return value;
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.destroy.mockResolvedValue(undefined);
  fixture.text.mockResolvedValue({ items: [{ str: 'Issued January 1, 2025', hasEOL: true }, { str: 'Expiration date: March 15, 2027', hasEOL: true }] });
  fixture.getPage.mockResolvedValue(pdfPage());
  fixture.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: fixture.getPage }), destroy: fixture.destroy });
  fixture.render.mockReturnValue({ promise: Promise.resolve(), cancel: fixture.cancel });
  fixture.ocr.mockResolvedValue('Expiration date: March 15, 2027');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG5n');
  fixture.createUrl.mockReturnValue('blob:local-private-file');
  const OriginalUrl = URL;
  vi.stubGlobal('URL', class extends OriginalUrl { static createObjectURL = fixture.createUrl; static revokeObjectURL = fixture.revoke; });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each([
  ['Expiration date: 2028-02-29', '2028-02-29'], ['Expiry: 2027/12/31', '2027-12-31'],
  ['Expires on March 15, 2027', '2027-03-15'], ['Valid until 15 March 2027', '2027-03-15'],
  ['Valid through Sept. 21st, 2027', '2027-09-21'], ['Expires 12/31/2027', '2027-12-31'],
  ['Expires 31/12/2027', '2027-12-31'], ['Expiration date\n09/09/2027', '2027-09-09'],
])('suggests a calendar date only beside an expiration label: %s', (text, date) => {
  expect(expirationCandidates(text)).toEqual([{ date, label: text.replace(/\s+/g, ' ').trim() }]);
});

test.each([
  'Issued March 15, 2027', 'Date of birth March 15, 2027', 'Expiration date: 03/04/2027',
  'Expires 2027-02-29', 'Expires February 30, 2028', 'Expires 12/31/27', 'Expires 1899-12-31',
  'Expires 2 years after completion on March 15, 2027', 'Expiration date:\nIssued March 15, 2027',
  'Expires as of 2027-03-15',
])('leaves ambiguous, invalid, unrelated or inferred dates for manual entry: %s', text => {
  expect(expirationCandidates(text)).toEqual([]);
});

test('keeps distinct labelled dates as choices, deduplicates and limits snippets and output', () => {
  const text = 'Issued 2025-01-01\nExpires March 15, 2027\nExpiration date 2027-03-15\nValid until June 18, 2027';
  expect(expirationCandidates(text).map(item => item.date)).toEqual(['2027-03-15', '2027-06-18']);
  expect(expirationCandidates(Array.from({ length: 12 }, (_, index) => `Expires 2027-01-${String(index + 1).padStart(2, '0')}`).join('\n'))).toHaveLength(8);
  expect(expirationCandidates('x'.repeat(80000) + '\nExpires 2027-03-15')).toEqual([]);
});

test('PDF text stays local, uses a safe parser, releases its worker and offers dates without OCR or saving', async () => {
  const result = await analyzeStaffDocumentExpiration('staff 1', file(), new AbortController().signal);
  expect(result).toEqual({ candidates: [{ date: '2027-03-15', label: 'Expiration date: March 15, 2027' }], incomplete: false });
  expect(fixture.getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: new Uint8Array([37, 80, 68, 70]),
    isEvalSupported: false, disableFontFace: true, useWorkerFetch: false, useSystemFonts: false, enableXfa: false,
    maxImageSize: 20000000, canvasMaxAreaInBytes: 16 * 1024 * 1024, disableAutoFetch: true, useWasm: false }));
  const Factory = fixture.getDocument.mock.calls[0][0].BinaryDataFactory;
  expect(new Factory()).toBeInstanceOf(LocalPdfFontFactory);
  expect(fixture.worker.workerSrc).toContain('pdf.worker.min.mjs');
  expect(fixture.destroy).toHaveBeenCalled(); expect(fixture.cleanup).toHaveBeenCalled(); expect(fixture.ocr).not.toHaveBeenCalled();
});

test('a longer PDF checks only five pages and clearly reports partial analysis', async () => {
  fixture.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1000, getPage: fixture.getPage }), destroy: fixture.destroy });
  const result = await analyzeStaffDocumentExpiration('staff', file(), new AbortController().signal);
  expect(result.incomplete).toBe(true); expect(result.candidates).toHaveLength(1);
  expect(fixture.getPage.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4, 5]);
});

test('scanned PDF pages are rendered as bounded pixels and OCR runs only on the selected facility endpoint', async () => {
  fixture.text.mockResolvedValue({ items: [] }); fixture.getPage.mockResolvedValue(pdfPage(100000, 10000000));
  const result = await analyzeStaffDocumentExpiration('employee', file(), new AbortController().signal);
  expect(result.candidates[0].date).toBe('2027-03-15'); expect(result.incomplete).toBe(false);
  expect(fixture.ocr).toHaveBeenCalledWith('employee', 'cG5n', expect.any(AbortSignal));
  const { canvas, viewport, annotationMode, background } = fixture.render.mock.calls[0][0];
  expect(viewport.width * viewport.height).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(viewport.width).toBeLessThanOrEqual(2200); expect(viewport.height).toBeLessThanOrEqual(2200);
  expect(annotationMode).toBe(1); expect(background).toBe('#ffffff');
  expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
});

test('an image uses a local Blob URL, bounds its canvas and revokes the URL after OCR', async () => {
  vi.stubGlobal('Image', class {
    naturalWidth = 4000; naturalHeight = 3000; onload: (() => void) | null = null; onerror = null;
    set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
  });
  const result = await analyzeStaffDocumentExpiration('employee', file('image/jpeg', 'certificate.jpg'), new AbortController().signal);
  expect(result.incomplete).toBe(false); expect(result.candidates[0].date).toBe('2027-03-15');
  const canvas = vi.mocked(HTMLCanvasElement.prototype.toDataURL).mock.instances[0] as unknown as HTMLCanvasElement;
  expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  expect(fixture.revoke).toHaveBeenCalledWith('blob:local-private-file'); expect(fixture.getDocument).not.toHaveBeenCalled();
});

test('unavailable OCR or PDF parsing returns a manual-entry result without private error details', async () => {
  fixture.text.mockResolvedValue({ items: [] }); fixture.ocr.mockRejectedValue(new Error('Sensitive private document detail'));
  expect(await analyzeStaffDocumentExpiration('employee', file(), new AbortController().signal)).toEqual({ candidates: [], incomplete: true });
  fixture.getDocument.mockReturnValue({ promise: Promise.reject(new Error('Private parsing detail')), destroy: fixture.destroy });
  expect(await analyzeStaffDocumentExpiration('employee', file(), new AbortController().signal)).toEqual({ candidates: [], incomplete: true });
});

test('cancelling an in-flight PDF render aborts OCR work, destroys the worker and clears canvases', async () => {
  fixture.text.mockResolvedValue({ items: [] }); fixture.render.mockReturnValue({ promise: new Promise(() => {}), cancel: fixture.cancel });
  const controller = new AbortController(); const request = analyzeStaffDocumentExpiration('employee', file(), controller.signal);
  await vi.waitFor(() => expect(fixture.render).toHaveBeenCalled());
  controller.abort(); await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(fixture.cancel).toHaveBeenCalled(); expect(fixture.destroy).toHaveBeenCalled(); expect(fixture.ocr).not.toHaveBeenCalled();
  expect(fixture.render.mock.calls[0][0].canvas.width).toBe(0);
});

test('a stalled parser times out and releases its worker instead of blocking the upload flow', async () => {
  vi.useFakeTimers(); fixture.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: fixture.destroy });
  const request = analyzeStaffDocumentExpiration('employee', file(), new AbortController().signal);
  await vi.advanceTimersByTimeAsync(60001);
  expect(await request).toEqual({ candidates: [], incomplete: true }); expect(fixture.destroy).toHaveBeenCalled();
});

test('invalid file sizes and unsupported types never reach document parsing or OCR', async () => {
  const large = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'certificate.png', { type: 'image/png' });
  for (const selected of [large, new File([], 'empty.pdf', { type: 'application/pdf' }), new File(['text'], 'file.txt', { type: 'text/plain' })]) {
    expect(await analyzeStaffDocumentExpiration('employee', selected, new AbortController().signal)).toEqual({ candidates: [], incomplete: true });
  }
  expect(fixture.ocr).not.toHaveBeenCalled(); expect(fixture.getDocument).not.toHaveBeenCalled();
});
