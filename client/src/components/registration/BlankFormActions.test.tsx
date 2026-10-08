import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BlankFormActions } from './BlankFormActions';
import * as api from '../../api/registrationForms';
import type { RegistrationForm } from '../../api/registrationForms';
import type { DocumentRevision } from '../../api/childDocuments';

const sessionExpired = vi.hoisted(() => new Set<() => void>());
const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: '' }, AnnotationMode: { ENABLE: 1 } }));
vi.mock('../../auth/transport', () => ({ authError: (_error: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { sessionExpired.add(callback); return () => sessionExpired.delete(callback); } }));
vi.mock('../children/PdfDocumentPreview', () => ({ default: ({ blob }: { blob: Blob }) => <canvas role="img" aria-label="Local PDF blank page" data-blob-type={blob.type} /> }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjs);
vi.mock('../../api/registrationForms', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/registrationForms')>();
  return { ...actual, getRegistrationForm: vi.fn(), getRegistrationFormContent: vi.fn() };
});
const form: RegistrationForm = { id: 'form-1', title: 'Consent / permission', instructions: 'Complete the blank form.', category: 'consent', required: true, active: true, version: 2, currentRevisionId: 'revision-2', templateRevision: 2, updatedAt: '2026-10-01T10:00:00Z' };
const revision: DocumentRevision = { id: 'revision-2', revision: 2, filename: 'uploaded-parent-file.pdf', contentType: 'application/pdf', byteLength: 21, sha256: 'synthetic', uploadedAt: '2026-10-01T10:00:00Z', uploadedBy: 'test-admin', changeNote: null, current: true };
const imageRevision = { ...revision, filename: 'blank-consent.png', contentType: 'image/png' };
const originalURL = URL;
let downloadClicks: { href: string; name: string }[] = [];
let savedShare: PropertyDescriptor | undefined;
let savedCanShare: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks(); sessionExpired.clear(); downloadClicks = [];
  savedShare = Object.getOwnPropertyDescriptor(navigator, 'share');
  savedCanShare = Object.getOwnPropertyDescriptor(navigator, 'canShare');
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  let objectUrl = 0;
  vi.stubGlobal('URL', Object.assign(class extends originalURL {}, { createObjectURL: vi.fn(() => 'blob:blank-' + ++objectUrl), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadClicks.push({ href: this.href, name: this.download }); });
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form, revisions: [revision], total: 1 });
  vi.mocked(api.getRegistrationFormContent).mockResolvedValue(new Blob(['%PDF-1.7 synthetic'], { type: 'application/pdf' }));
});
afterEach(() => {
  cleanup();
  if (savedShare) Object.defineProperty(navigator, 'share', savedShare); else Reflect.deleteProperty(navigator, 'share');
  if (savedCanShare) Object.defineProperty(navigator, 'canShare', savedCanShare); else Reflect.deleteProperty(navigator, 'canShare');
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function click(action: 'Preview' | 'Download' | 'Print' | 'Share', title = form.title) { fireEvent.click(screen.getByRole('button', { name: action + ' blank ' + title })); }

test('current blank downloads use only the catalog title and release the temporary URL', async () => {
  vi.useFakeTimers();
  const shown = render(<><p>Child Synthetic Private Name</p><BlankFormActions form={form} /></>);
  click('Download'); await act(async () => {});
  expect(api.getRegistrationForm).toHaveBeenCalledWith(form.id, expect.any(AbortSignal));
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, revision.id, true, expect.any(AbortSignal));
  expect(downloadClicks).toEqual([{ href: 'blob:blank-1', name: 'blank-Consent  permission.pdf' }]);
  expect(downloadClicks[0].name).not.toContain('Synthetic'); expect(downloadClicks[0].name).not.toContain('uploaded-parent-file');
  expect(document.querySelector('a[download]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:blank-1'); shown.unmount();
});

test('native sharing includes a blank File and catalog title without child profile metadata', async () => {
  const share = vi.fn().mockResolvedValue(undefined); const canShare = vi.fn().mockReturnValue(true);
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
  render(<><p>Child Synthetic Private Name</p><BlankFormActions form={form} revision={revision} /></>);
  click('Share'); await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
  const payload = share.mock.calls[0][0] as { files: File[]; title: string };
  expect(Object.keys(payload).sort()).toEqual(['files', 'title']);
  expect(payload.title).toBe('Blank ' + form.title);
  expect(payload.files).toHaveLength(1); expect(payload.files[0]).toBeInstanceOf(File);
  expect(payload.files[0].name).toBe('blank-Consent  permission.pdf'); expect(payload.files[0].type).toBe('application/pdf');
  expect(payload.files[0].size).toBeGreaterThan(0);
  expect(canShare).toHaveBeenCalledWith({ files: payload.files });
  expect(downloadClicks).toHaveLength(0); expect(api.getRegistrationForm).not.toHaveBeenCalled();
});

test('unavailable sharing downloads the same blank file for manual sharing', async () => {
  const shown = render(<BlankFormActions form={form} revision={imageRevision} />);
  click('Share'); await screen.findByText('The blank form was downloaded for you to share.');
  expect(downloadClicks).toEqual([{ href: 'blob:blank-1', name: 'blank-Consent  permission.png' }]);
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, imageRevision.id, true, expect.any(AbortSignal));
  shown.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:blank-1');
});

test('rejected native sharing falls back to download while cancellation creates no download', async () => {
  const share = vi.fn().mockRejectedValueOnce(new Error('Unsupported'));
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: vi.fn().mockReturnValue(true) });
  const shown = render(<BlankFormActions form={form} revision={revision} />);
  click('Share'); await screen.findByText('Sharing is unavailable here. The blank form was downloaded for you to share.');
  expect(downloadClicks).toHaveLength(1); shown.unmount(); downloadClicks = [];
  share.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
  render(<BlankFormActions form={form} revision={revision} />);
  click('Share'); await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Share blank ' + form.title })).toBeEnabled());
  expect(downloadClicks).toHaveLength(0); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('PDF previews use a local renderer without mounting a private file URL', async () => {
  render(<BlankFormActions form={form} revision={revision} />);
  click('Preview');
  expect(await screen.findByRole('img', { name: 'Local PDF blank page' })).toHaveAttribute('data-blob-type', 'application/pdf');
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, revision.id, false, expect.any(AbortSignal));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(document.querySelector('iframe, object, embed')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close blank preview' }));
  expect(screen.queryByRole('img', { name: 'Local PDF blank page' })).not.toBeInTheDocument();
});

test('image preview URLs are revoked on close, unmount and session expiry', async () => {
  const first = render(<BlankFormActions form={form} revision={imageRevision} />);
  click('Preview'); expect(await screen.findByAltText('Blank ' + form.title + ' preview')).toHaveAttribute('src', 'blob:blank-1');
  fireEvent.click(screen.getByRole('button', { name: 'Close blank preview' }));
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:blank-1'));
  click('Preview'); await screen.findByAltText('Blank ' + form.title + ' preview');
  first.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:blank-2');
  render(<BlankFormActions form={form} revision={imageRevision} />);
  click('Preview'); await screen.findByAltText('Blank ' + form.title + ' preview');
  act(() => { for (const callback of sessionExpired) callback(); });
  expect(screen.queryByAltText('Blank ' + form.title + ' preview')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preview blank ' + form.title })).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:blank-3');
});

test('historical blank actions fetch the chosen revision without loading current details', async () => {
  const old = { ...revision, id: 'revision-1', revision: 1, current: false };
  render(<BlankFormActions form={form} revision={old} />);
  click('Preview', form.title + ' version 1'); await screen.findByRole('img', { name: 'Local PDF blank page' });
  expect(api.getRegistrationForm).not.toHaveBeenCalled();
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, old.id, false, expect.any(AbortSignal));
  expect(screen.getByText('Blank ' + form.title + ' · Version 1')).toBeInTheDocument();
});

test('current actions require a refreshed catalog when the latest revision changed', async () => {
  const latestRevision = { ...revision, id: 'revision-3', revision: 3 };
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form: { ...form, currentRevisionId: latestRevision.id, templateRevision: 3 }, revisions: [latestRevision, revision], total: 2 });
  render(<BlankFormActions form={form} />);
  click('Download');
  await screen.findByText('The blank form changed. Refresh the checklist and try again.');
  expect(api.getRegistrationFormContent).not.toHaveBeenCalled();
  expect(downloadClicks).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('printing a blank image uses an isolated frame containing only its pixels', async () => {
  const print = vi.fn(); const focus = vi.fn();
  const realAppend = document.body.appendChild.bind(document.body);
  let frame: HTMLIFrameElement | null = null;
  vi.spyOn(document.body, 'appendChild').mockImplementation(function <T extends Node>(node: T): T {
    const appended = realAppend(node);
    if (node instanceof HTMLIFrameElement) {
      frame = node;
      const target = node.contentDocument!;
      Object.defineProperty(Object.getPrototypeOf(target.createElement('img')), 'decode', { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
      Object.defineProperty(node.contentWindow!, 'print', { configurable: true, value: print });
      Object.defineProperty(node.contentWindow!, 'focus', { configurable: true, value: focus });
    }
    return appended;
  });
  vi.mocked(api.getRegistrationFormContent).mockResolvedValue(new Blob(['synthetic image pixels'], { type: 'image/png' }));
  render(<><p>Child Synthetic Private Name</p><BlankFormActions form={form} revision={imageRevision} /></>);
  click('Print'); await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  const printedFrame = frame as HTMLIFrameElement | null;
  expect(printedFrame).not.toBeNull();
  expect(printedFrame!.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
  const printBody = printedFrame!.contentDocument!.body;
  expect(printBody.children).toHaveLength(1); expect(printBody.firstElementChild!.tagName).toBe('IMG');
  expect(printBody.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
  expect(printBody.textContent).not.toContain('Synthetic Private Name');
  expect(printBody.querySelector('script, input, object, embed')).toBeNull();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, imageRevision.id, false, expect.any(AbortSignal));
  printedFrame!.contentWindow!.dispatchEvent(new Event('afterprint'));
  expect(document.querySelector('iframe')).toBeNull();
});

test('a cumulative PDF print limit stops before rendering excessive pages and keeps download available', async () => {
  const originalBlob = Blob;
  vi.stubGlobal('Blob', class extends originalBlob { async arrayBuffer() { return new ArrayBuffer(1); } });
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cGl4ZWxz');
  const draw = vi.fn(() => ({ promise: Promise.resolve() })); const clear = vi.fn();
  const getPage = vi.fn().mockResolvedValue({ getViewport: ({ scale }: { scale: number }) => ({ width: 2048 * scale, height: 2048 * scale }), render: draw, cleanup: clear });
  const destroy = vi.fn().mockResolvedValue(undefined);
  pdfjs.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 9, getPage }), destroy });
  const print = vi.fn();
  const realAppend = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation(function <T extends Node>(node: T): T {
    const appended = realAppend(node);
    if (node instanceof HTMLIFrameElement) Object.defineProperty(node.contentWindow!, 'print', { configurable: true, value: print });
    return appended;
  });
  render(<BlankFormActions form={form} revision={revision} />);
  click('Print');
  await screen.findByText('This blank form is too large to print here. Download the blank form to print all its pages.');
  expect(getPage).toHaveBeenCalledTimes(9);
  expect(draw).toHaveBeenCalledTimes(8); expect(toDataURL).toHaveBeenCalledTimes(8);
  expect(clear).toHaveBeenCalledTimes(9); expect(destroy).toHaveBeenCalledTimes(1);
  expect(draw).toHaveBeenCalledWith(expect.objectContaining({ annotationMode: pdfjs.AnnotationMode.ENABLE, background: '#ffffff' }));
  expect(print).not.toHaveBeenCalled(); expect(document.querySelector('iframe')).toBeNull();
  expect(screen.getByRole('button', { name: 'Download blank ' + form.title })).toBeEnabled();
  click('Download'); await waitFor(() => expect(downloadClicks).toHaveLength(1));
});

test('changing form identity aborts a pending preview and prevents the old blank content from appearing', async () => {
  let finish: (blob: Blob) => void = () => {};
  vi.mocked(api.getRegistrationFormContent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const shown = render(<BlankFormActions form={form} revision={imageRevision} />);
  click('Preview'); await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(api.getRegistrationFormContent).mock.calls[0][3];
  const nextForm = { ...form, id: 'form-2', title: 'Another blank form' };
  shown.rerender(<BlankFormActions form={nextForm} revision={imageRevision} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(new Blob(['old image'], { type: 'image/png' })); });
  expect(screen.queryByRole('region', { name: /Blank form preview/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview blank Another blank form' })).toBeEnabled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('changing revision in place aborts pending content and enables the new version actions', async () => {
  let finish: (blob: Blob) => void = () => {};
  vi.mocked(api.getRegistrationFormContent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const shown = render(<BlankFormActions form={form} revision={imageRevision} />);
  click('Preview'); await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(api.getRegistrationFormContent).mock.calls[0][3];
  const nextRevision = { ...imageRevision, id: 'revision-3', revision: 3 };
  shown.rerender(<BlankFormActions form={{ ...form, currentRevisionId: nextRevision.id }} revision={nextRevision} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(new Blob(['old image'], { type: 'image/png' })); });
  expect(screen.queryByRole('region', { name: /Blank form preview/ })).not.toBeInTheDocument();
  click('Preview'); await screen.findByAltText('Blank ' + form.title + ' preview');
  expect(api.getRegistrationFormContent).toHaveBeenLastCalledWith(form.id, nextRevision.id, false, expect.any(AbortSignal));
  expect(screen.getByText('Blank ' + form.title + ' · Version 3')).toBeInTheDocument();
});

test('unmount and session expiry abort pending content and ignore late responses', async () => {
  const finishes: ((blob: Blob) => void)[] = [];
  vi.mocked(api.getRegistrationFormContent).mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const first = render(<BlankFormActions form={form} revision={revision} />);
  click('Download'); await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(1));
  const firstSignal = vi.mocked(api.getRegistrationFormContent).mock.calls[0][3]; first.unmount(); expect(firstSignal.aborted).toBe(true);
  render(<BlankFormActions form={form} revision={revision} />);
  click('Download'); await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(2));
  const secondSignal = vi.mocked(api.getRegistrationFormContent).mock.calls[1][3];
  act(() => { for (const callback of sessionExpired) callback(); }); expect(secondSignal.aborted).toBe(true);
  await act(async () => { finishes.forEach(finish => finish(new Blob(['late']))); });
  expect(downloadClicks).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
