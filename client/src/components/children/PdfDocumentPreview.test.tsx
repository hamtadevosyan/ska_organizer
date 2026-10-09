import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import PdfDocumentPreview from './PdfDocumentPreview';
import { LocalPdfFontFactory } from './pdfStandardFonts';

const renderer = vi.hoisted(() => ({ getDocument: vi.fn(), worker: { workerSrc: '' }, getPage: vi.fn(), cancel: vi.fn(), cleanup: vi.fn(), destroy: vi.fn(), render: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: renderer.getDocument, GlobalWorkerOptions: renderer.worker, AnnotationMode: { ENABLE: 1 } }));
const blob = () => ({ arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer }) as Blob;
function page(width = 600, height = 800) {
  return { getViewport: ({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale }), render: renderer.render, cleanup: renderer.cleanup };
}
beforeEach(() => {
  vi.clearAllMocks();
  renderer.destroy.mockResolvedValue(undefined);
  renderer.render.mockReturnValue({ promise: Promise.resolve(), cancel: renderer.cancel });
  renderer.getPage.mockResolvedValue(page());
  renderer.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: renderer.getPage }), destroy: renderer.destroy });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
});

test('PDF bytes are rendered locally with bounded pixels, no executable layers, and page navigation', async () => {
  const result = render(<PdfDocumentPreview blob={blob()} />);
  const canvas = await screen.findByRole('img', { name: 'PDF page 1' });
  await waitFor(() => { expect(canvas).toBeVisible(); expect(canvas).toHaveAttribute('width', '320'); });
  expect(renderer.worker.workerSrc).toContain('pdf.worker.min.mjs');
  expect(renderer.getDocument).toHaveBeenCalledWith(expect.objectContaining({ data: new Uint8Array([37, 80, 68, 70]), isEvalSupported: false, disableFontFace: true, useWorkerFetch: false, useSystemFonts: false, BinaryDataFactory: LocalPdfFontFactory, enableXfa: false, maxImageSize: 20000000, canvasMaxAreaInBytes: 16 * 1024 * 1024 }));
  expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({ annotationMode: 1, background: '#ffffff' }));
  expect(result.container.querySelector('input, a, iframe, .annotationLayer')).toBeNull();
  expect(screen.getByText('Page 1 of 2')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Previous PDF page' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Next PDF page' }));
  await screen.findByRole('img', { name: 'PDF page 2' }); expect(renderer.getPage).toHaveBeenCalledWith(2);
  expect(screen.getByRole('button', { name: 'Next PDF page' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous PDF page' })); await screen.findByRole('img', { name: 'PDF page 1' });
  result.unmount(); expect(renderer.destroy).toHaveBeenCalled(); expect(renderer.cancel).toHaveBeenCalled(); expect(canvas).toHaveAttribute('width', '0'); expect(canvas).toHaveAttribute('height', '0');
});

test('extreme page dimensions and device density stay within the canvas pixel limit', async () => {
  renderer.getPage.mockResolvedValue(page(100000, 10000000));
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(8);
  render(<PdfDocumentPreview blob={blob()} />);
  const canvas = await screen.findByRole('img', { name: 'PDF page 1' }) as HTMLCanvasElement;
  await waitFor(() => expect(renderer.render).toHaveBeenCalled());
  expect(canvas.width).toBeGreaterThan(0); expect(canvas.height).toBeGreaterThan(0);
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(4 * 1024 * 1024); expect(canvas.width).toBeLessThanOrEqual(4096); expect(canvas.height).toBeLessThanOrEqual(4096); expect(parseInt(canvas.style.height)).toBeLessThanOrEqual(2400);
});

test('parse and render failures expose only a useful download fallback', async () => {
  renderer.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('Synthetic private parsing detail')), destroy: renderer.destroy }));
  const result = render(<PdfDocumentPreview blob={blob()} />);
  await screen.findByText('This PDF cannot be previewed here. Use Download in the version history.');
  expect(screen.queryByText(/Synthetic private/)).not.toBeInTheDocument(); result.unmount();
  renderer.render.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('Synthetic private render detail')), cancel: renderer.cancel }));
  render(<PdfDocumentPreview blob={blob()} />);
  await screen.findByText('This PDF cannot be previewed here. Use Download in the version history.');
  expect(screen.queryByRole('img', { name: 'PDF page 1' })).not.toBeInTheDocument();
});

test('closing or changing a PDF destroys outstanding work and ignores a late load', async () => {
  let finish: (value: object) => void = () => {};
  const oldDestroy = vi.fn().mockResolvedValue(undefined);
  renderer.getDocument.mockReturnValueOnce({ promise: new Promise(resolve => { finish = resolve; }), destroy: oldDestroy });
  const result = render(<PdfDocumentPreview blob={blob()} />);
  await waitFor(() => expect(renderer.getDocument).toHaveBeenCalledTimes(1));
  result.rerender(<PdfDocumentPreview blob={blob()} />);
  await screen.findByRole('img', { name: 'PDF page 1' });
  expect(oldDestroy).toHaveBeenCalledTimes(1);
  finish({ numPages: 99, getPage: renderer.getPage });
  await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
  result.unmount(); expect(renderer.destroy).toHaveBeenCalledTimes(1);
});
