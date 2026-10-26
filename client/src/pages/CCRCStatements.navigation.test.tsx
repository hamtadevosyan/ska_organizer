import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import CCRCStatements from './CCRCStatements';
import UnsavedChangesProvider from '../components/UnsavedChangesProvider';
import { SignedIn } from '../tests/authFixture';
import { ccrcStatementFixture } from '../tests/ccrcStatementFixture';
import { getCcrcStatement, listCcrcStatements, uploadCcrcStatement } from '../api/ccrcStatements';
import { readDocumentFile } from '../api/childDocuments';

const { transferableAbortController } = await vi.importActual<{ transferableAbortController: () => AbortController }>('node:util');
const originalDialogs = { showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'), close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close') };
const events = vi.hoisted(() => ({ expired: new Set<() => void>(), denied: new Set<() => void>() }));
vi.mock('../auth/transport', () => ({ authError: (_failure: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { events.expired.add(callback); return () => events.expired.delete(callback); }, onWorkAccessRequired: (callback: () => void) => { events.denied.add(callback); return () => events.denied.delete(callback); } }));
vi.mock('../api/ccrcStatements', () => ({ cancelCcrcStatement: vi.fn(), getCcrcStatement: vi.fn(), getCcrcStatementContent: vi.fn(), listCcrcStatements: vi.fn(), postCcrcStatement: vi.fn(), reopenCcrcStatement: vi.fn(), saveCcrcReview: vi.fn(), uploadCcrcStatement: vi.fn() }));
vi.mock('../api/childDocuments', async original => ({ ...await original<typeof import('../api/childDocuments')>(), readDocumentFile: vi.fn() }));
function CurrentPath() { return <output aria-label="Current statement path">{useLocation().pathname + useLocation().search}</output>; }
function show(path = '/billing/ccrc-statements') {
  const router = createMemoryRouter([{ path: '/billing/ccrc-statements', element: <SignedIn><UnsavedChangesProvider><CCRCStatements /><CurrentPath /></UnsavedChangesProvider></SignedIn> }, { path: '/billing', element: <h1>Tuition landing</h1> }], { initialEntries: [path] });
  return { ...render(<RouterProvider router={router} />), router };
}
beforeEach(() => {
  vi.clearAllMocks();
  // React Router uses Node fetch; its signal must come from the same realm.
  vi.stubGlobal('AbortController', class { constructor() { return transferableAbortController(); } });
  Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value() { this.setAttribute('open', ''); } }, close: { configurable: true, value() { this.removeAttribute('open'); } } });
  events.expired.clear(); events.denied.clear(); const data = ccrcStatementFixture();
  vi.mocked(listCcrcStatements).mockResolvedValue({ items: [data], total: 1, today: data.today, timeZone: data.timeZone }); vi.mocked(getCcrcStatement).mockResolvedValue(data); vi.mocked(uploadCcrcStatement).mockResolvedValue(data);
  vi.mocked(readDocumentFile).mockResolvedValue({ name: data.filename, contentType: data.contentType, dataBase64: 'c3ludGhldGlj' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ['showModal', 'close'] as const) { const descriptor = originalDialogs[name]; if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>)[name]; }
});
test('confirmed upload opens its draft through the real unsaved-work blocker without a discard prompt', async () => {
  show(); fireEvent.change(screen.getByLabelText('Choose statement file'), { target: { files: [new File(['synthetic'], 'original.pdf', { type: 'application/pdf' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Read statement' }));
  await screen.findByRole('form', { name: 'Review CCRC statement' });
  expect(screen.queryByRole('dialog', { name: 'Leave your unsaved work?' })).not.toBeInTheDocument(); expect(screen.getByLabelText('Current statement path')).toHaveTextContent('?statement=source%2Fa');
});
test('ordinary navigation still protects a dirty review and keeps its values after Keep editing', async () => {
  show('/billing/ccrc-statements?statement=source%2Fa'); await screen.findByRole('form', { name: 'Review CCRC statement' }); fireEvent.change(screen.getByLabelText('Reconciliation note'), { target: { value: 'Private unfinished review' } });
  fireEvent.click(screen.getByRole('link', { name: 'Tuition & payments' }));
  expect(await screen.findByRole('dialog', { name: 'Leave your unsaved work?' })).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })); expect(screen.getByLabelText('Reconciliation note')).toHaveValue('Private unfinished review'); expect(screen.queryByRole('heading', { name: 'Tuition landing' })).not.toBeInTheDocument();
});
test('explicitly discarding for a different saved statement does not ask for the same discard twice', async () => {
  const current = ccrcStatementFixture(), other = { ...ccrcStatementFixture(), id: 'source/b', filename: 'other-original.pdf' };
  vi.mocked(listCcrcStatements).mockResolvedValue({ items: [current, other], total: 2, today: current.today, timeZone: current.timeZone }); vi.mocked(getCcrcStatement).mockImplementation(async id => id === other.id ? other : current);
  const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    show('/billing/ccrc-statements?statement=source%2Fa'); await screen.findByRole('form', { name: 'Review CCRC statement' }); fireEvent.change(screen.getByLabelText('Reconciliation note'), { target: { value: 'Unfinished review' } });
    fireEvent.change(screen.getByLabelText('Statement', { exact: true }), { target: { value: other.id } });
    await screen.findByRole('heading', { name: 'other-original.pdf' }); expect(confirmation).toHaveBeenCalledTimes(1); expect(screen.queryByRole('dialog', { name: 'Leave your unsaved work?' })).not.toBeInTheDocument();
  } finally { confirmation.mockRestore(); }
});


test.each(['expired', 'denied'] as const)('%s access aborts a pending upload and releases the real navigation guard', async event => {
  let finish!: (value: ReturnType<typeof ccrcStatementFixture>) => void;
  vi.mocked(uploadCcrcStatement).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const { router } = show();
  fireEvent.change(screen.getByLabelText('Choose statement file'), { target: { files: [new File(['synthetic'], 'private-original.pdf', { type: 'application/pdf' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Read statement' }));
  await waitFor(() => expect(uploadCcrcStatement).toHaveBeenCalled()); const signal = vi.mocked(uploadCcrcStatement).mock.calls[0][2]!;
  act(() => events[event].forEach(callback => callback())); expect(signal.aborted).toBe(true); expect(screen.queryByText('private-original.pdf')).not.toBeInTheDocument();
  await act(async () => { await router.navigate('/billing'); }); expect(screen.getByRole('heading', { name: 'Tuition landing' })).toBeVisible(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => finish(ccrcStatementFixture())); expect(screen.queryByRole('form', { name: 'Review CCRC statement' })).not.toBeInTheDocument();
});
