import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BlankFormActions } from './BlankFormActions';
import * as api from '../../api/registrationForms';
import type { RegistrationForm } from '../../api/registrationForms';
import type { DocumentRevision } from '../../api/childDocuments';

const sessionExpired = vi.hoisted(() => new Set<() => void>());
vi.mock('../../auth/transport', () => ({ authError: (_error: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { sessionExpired.add(callback); return () => sessionExpired.delete(callback); } }));
vi.mock('../children/PdfDocumentPreview', () => ({ default: ({ blob }: { blob: Blob }) => <canvas role="img" aria-label="Local PDF blank page" data-blob-type={blob.type} /> }));
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
function click(action: 'Preview' | 'Download' | 'Share / Print', title = form.title) { fireEvent.click(screen.getByRole('button', { name: action + ' blank ' + title })); }

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

function nativeSharing(share = vi.fn().mockResolvedValue(undefined), canShare = vi.fn().mockReturnValue(true)) {
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
  return { share, canShare };
}
function fileText(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(file);
  });
}
async function prepareShare() {
  click('Share / Print');
  return screen.findByRole('region', { name: 'Share or print blank form' });
}

test('blank forms have three primary actions and prepare before opening a native share menu', async () => {
  let finish: (blob: Blob) => void = () => {};
  vi.mocked(api.getRegistrationFormContent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { share } = nativeSharing();
  render(<BlankFormActions form={form} revision={revision} />);
  expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
    'Preview blank ' + form.title, 'Download blank ' + form.title, 'Share / Print blank ' + form.title,
  ]);
  click('Share / Print');
  await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Share / Print blank ' + form.title })).toBeDisabled();
  expect(screen.queryByRole('region', { name: 'Share or print blank form' })).not.toBeInTheDocument();
  expect(share).not.toHaveBeenCalled();
  await act(async () => finish(new Blob(['original blank PDF'], { type: 'application/pdf' })));
  expect(screen.getByRole('region', { name: 'Share or print blank form' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open share menu' })).toBeEnabled();
  expect(share).not.toHaveBeenCalled();
  expect(document.querySelector('iframe, object, embed')).toBeNull();
});

test('the final native share click synchronously shares the original blank file without child metadata or a URL', async () => {
  const { share, canShare } = nativeSharing();
  const original = new Blob(['original blank PDF bytes'], { type: 'application/pdf' });
  vi.mocked(api.getRegistrationFormContent).mockResolvedValue(original);
  render(<><p>Child Synthetic Private Name</p><BlankFormActions form={form} revision={revision} /></>);
  await prepareShare();
  expect(share).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open share menu' }));
  // Assert before yielding: mobile browsers require this call in the user's activation.
  expect(share).toHaveBeenCalledTimes(1);
  const payload = share.mock.calls[0][0] as { files: File[]; title: string };
  expect(Object.keys(payload).sort()).toEqual(['files', 'title']);
  expect(payload.title).toBe('Blank ' + form.title);
  expect(payload.files).toHaveLength(1); expect(payload.files[0]).toBeInstanceOf(File);
  expect(payload.files[0].name).toBe('blank-Consent  permission.pdf'); expect(payload.files[0].type).toBe('application/pdf');
  expect(await fileText(payload.files[0])).toBe('original blank PDF bytes');
  expect(canShare).toHaveBeenCalledWith({ files: payload.files });
  expect(downloadClicks).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(api.getRegistrationForm).not.toHaveBeenCalled();
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, revision.id, true, expect.any(AbortSignal));
});

test.each(['no share', 'no canShare', 'unsupported files', 'canShare throws'] as const)('unsupported native sharing offers an explicit file download: %s', async mode => {
  const { share, canShare } = nativeSharing();
  if (mode === 'no share') Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  if (mode === 'no canShare') Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  if (mode === 'unsupported files') canShare.mockReturnValue(false);
  if (mode === 'canShare throws') canShare.mockImplementation(() => { throw new Error('Unsupported files'); });
  vi.mocked(api.getRegistrationFormContent).mockResolvedValue(new Blob(['original blank image'], { type: 'image/png' }));
  const shown = render(<BlankFormActions form={form} revision={imageRevision} />);
  await prepareShare();
  expect(downloadClicks).toHaveLength(0); expect(share).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Open share menu' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Download to share or print' }));
  expect(await screen.findByText('The blank form was downloaded. Open the file to share or print it.')).toBeInTheDocument();
  expect(downloadClicks).toEqual([{ href: 'blob:blank-1', name: 'blank-Consent  permission.png' }]);
  const downloaded = vi.mocked(URL.createObjectURL).mock.calls[0][0] as File;
  expect(downloaded).toBeInstanceOf(File); expect(downloaded.type).toBe('image/png');
  expect(await fileText(downloaded)).toBe('original blank image');
  expect(api.getRegistrationFormContent).toHaveBeenCalledWith(form.id, imageRevision.id, true, expect.any(AbortSignal));
  shown.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:blank-1');
});

test('canceling the native menu keeps the prepared file available to retry without a download', async () => {
  const { share } = nativeSharing(vi.fn().mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError')).mockResolvedValue(undefined));
  render(<BlankFormActions form={form} revision={revision} />);
  await prepareShare();
  fireEvent.click(screen.getByRole('button', { name: 'Open share menu' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open share menu' })).toBeEnabled());
  expect(screen.getByRole('region', { name: 'Share or print blank form' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(downloadClicks).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Open share menu' }));
  expect(share).toHaveBeenCalledTimes(2);
  expect(share.mock.calls[1][0].files[0]).toBe(share.mock.calls[0][0].files[0]);
  expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(1);
  await act(async () => {}); expect(downloadClicks).toHaveLength(0);
});

test('a native sharing failure explains retry or download and does not automatically download', async () => {
  const { share } = nativeSharing(vi.fn().mockRejectedValue(new Error('Unsupported')));
  render(<BlankFormActions form={form} revision={revision} />);
  await prepareShare();
  fireEvent.click(screen.getByRole('button', { name: 'Open share menu' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the share menu. Try again, or download the blank form to share or print it.');
  expect(share).toHaveBeenCalledTimes(1); expect(downloadClicks).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Open share menu' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Download blank ' + form.title })).toBeEnabled();
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


test.each(['form', 'revision'] as const)('changing the %s clears the ready file and ignores a late preparation', async changed => {
  const { share } = nativeSharing();
  const shown = render(<BlankFormActions form={form} revision={revision} />);
  await prepareShare();
  const nextRevision = { ...revision, id: 'revision-3', revision: 3 };
  const nextForm = changed === 'form' ? { ...form, id: 'form-2', title: 'Another blank form' } : { ...form, currentRevisionId: nextRevision.id };
  shown.rerender(<BlankFormActions form={nextForm} revision={changed === 'revision' ? nextRevision : revision} />);
  expect(screen.queryByRole('region', { name: 'Share or print blank form' })).not.toBeInTheDocument();
  let finish: (blob: Blob) => void = () => {};
  vi.mocked(api.getRegistrationFormContent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  click('Share / Print', nextForm.title);
  await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(2));
  const signal = vi.mocked(api.getRegistrationFormContent).mock.calls[1][3];
  shown.rerender(<BlankFormActions form={form} revision={revision} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(new Blob(['stale blank PDF'], { type: 'application/pdf' })));
  expect(screen.queryByRole('region', { name: 'Share or print blank form' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Share / Print blank ' + form.title })).toBeEnabled();
  expect(share).not.toHaveBeenCalled(); expect(downloadClicks).toHaveLength(0);
});

test.each(['unmount', 'expiry'] as const)('%s during preparation aborts the fetch and cannot expose the late file', async stopped => {
  let finish: (blob: Blob) => void = () => {};
  vi.mocked(api.getRegistrationFormContent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { share } = nativeSharing();
  const shown = render(<BlankFormActions form={form} revision={revision} />);
  click('Share / Print'); await waitFor(() => expect(api.getRegistrationFormContent).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(api.getRegistrationFormContent).mock.calls[0][3];
  if (stopped === 'unmount') shown.unmount();
  else act(() => { for (const callback of sessionExpired) callback(); });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(new Blob(['late blank PDF'], { type: 'application/pdf' })));
  expect(screen.queryByRole('region', { name: 'Share or print blank form' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Share / Print blank ' + form.title })).not.toBeInTheDocument();
  expect(share).not.toHaveBeenCalled(); expect(downloadClicks).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('session expiry clears the prepared file without sharing or downloading it', async () => {
  const { share } = nativeSharing();
  render(<BlankFormActions form={form} revision={revision} />);
  await prepareShare();
  act(() => { for (const callback of sessionExpired) callback(); });
  expect(screen.queryByRole('region', { name: 'Share or print blank form' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open share menu' })).not.toBeInTheDocument();
  expect(share).not.toHaveBeenCalled(); expect(downloadClicks).toHaveLength(0);
});

test.each(['resolves', 'rejects'] as const)('a native share that %s after session expiry cannot reactivate the file or download', async outcome => {
  let finish: () => void = () => {};
  const { share } = nativeSharing(vi.fn().mockImplementation(() => new Promise<void>((resolve, reject) => {
    finish = outcome === 'resolves' ? resolve : () => reject(new Error('Native menu failed'));
  })));
  render(<BlankFormActions form={form} revision={revision} />);
  await prepareShare();
  fireEvent.click(screen.getByRole('button', { name: 'Open share menu' }));
  expect(share).toHaveBeenCalledTimes(1);
  act(() => { for (const callback of sessionExpired) callback(); });
  await act(async () => finish());
  expect(screen.queryByRole('region', { name: 'Share or print blank form' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Share / Print blank ' + form.title })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(downloadClicks).toHaveLength(0); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
