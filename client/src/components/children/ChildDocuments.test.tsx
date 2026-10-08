import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChildDocuments } from './ChildDocuments';
import { SignedIn } from '../../tests/authFixture';
import { testAccount } from '../../tests/authAccount';
import * as api from '../../api/childDocuments';
import * as formsApi from '../../api/registrationForms';
import type { RegistrationChecklist, RegistrationForm } from '../../api/registrationForms';
import type { ChildDocument, DocumentRevision } from '../../api/childDocuments';
import { UnsavedChangesContext } from '../UnsavedChangesContext';

const sessionExpired = vi.hoisted(() => new Set<() => void>());
vi.mock('../../auth/transport', () => ({ authError: (_error: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { sessionExpired.add(callback); return () => sessionExpired.delete(callback); } }));
vi.mock('../../api/registrationForms', () => ({ getRegistrationChecklist: vi.fn(), getRegistrationForm: vi.fn(), getRegistrationFormContent: vi.fn() }));
vi.mock('./PdfDocumentPreview', () => ({ default: () => <canvas role="img" aria-label="PDF page 1" /> }));
vi.mock('../../api/childDocuments', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/childDocuments')>();
  return { ...actual, listChildDocuments: vi.fn(), getChildDocument: vi.fn(), addChildDocument: vi.fn(), updateChildDocument: vi.fn(), reviseChildDocument: vi.fn(), reviewChildDocument: vi.fn(), getDocumentContent: vi.fn(), readDocumentFile: vi.fn() };
});
const document: ChildDocument = { id: 'document-1', childId: 'child-1', title: 'Synthetic consent', category: 'consent', documentDate: '2026-10-01', notes: 'Synthetic paperwork only.', version: 1, currentRevisionId: 'revision-1', updatedAt: '2026-10-01T10:00:00Z' };
const revision: DocumentRevision = { id: 'revision-1', revision: 1, filename: 'synthetic.pdf', contentType: 'application/pdf', byteLength: 21, sha256: 'synthetic', uploadedAt: '2026-10-01T10:00:00Z', uploadedBy: 'test-admin', changeNote: null, current: true };
let objectUrl = 0;
let savedSecure: PropertyDescriptor | undefined;
let savedMedia: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.clearAllMocks(); sessionExpired.clear(); objectUrl = 0;
  savedSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  savedMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:synthetic-' + ++objectUrl), revokeObjectURL: vi.fn() }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValue({ items: [], requiredTotal: 0, requiredComplete: 0, complete: false });
  vi.mocked(api.reviewChildDocument).mockResolvedValue({ document: { ...document, version: 2, reviewedRevisionId: 'revision-1' } });
  vi.mocked(api.listChildDocuments).mockResolvedValue({ items: [document], total: 1 });
  vi.mocked(api.getChildDocument).mockResolvedValue({ document, revisions: [revision], total: 1 });
  vi.mocked(api.addChildDocument).mockResolvedValue({ document, revision });
  vi.mocked(api.updateChildDocument).mockResolvedValue({ document: { ...document, version: 2 } });
  vi.mocked(api.reviseChildDocument).mockResolvedValue({ document: { ...document, version: 2 }, revision: { ...revision, id: 'revision-2', revision: 2 } });
  vi.mocked(api.getDocumentContent).mockResolvedValue(new Blob(['%PDF-1.7 synthetic'], { type: 'application/pdf' }));
  vi.mocked(api.readDocumentFile).mockImplementation(async file => ({ name: file.name, contentType: file.type, dataBase64: 'c3ludGhldGlj' }));
});
afterEach(() => {
  if (savedSecure) Object.defineProperty(window, 'isSecureContext', savedSecure); else Reflect.deleteProperty(window, 'isSecureContext');
  if (savedMedia) Object.defineProperty(navigator, 'mediaDevices', savedMedia); else Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
});
async function selectDocument() { fireEvent.click(await screen.findByRole('button', { name: /Synthetic consent.*Consent form/ })); await screen.findByRole('region', { name: 'Selected document' }); }
function uploadFile(file = new File(['%PDF-1.7 synthetic'], 'synthetic.pdf', { type: 'application/pdf' })) { fireEvent.change(screen.getByLabelText('Upload a document'), { target: { files: [file] } }); }

test.each(['editor', 'viewer'] as const)('%s sees no documentation section or requests even with a legacy grant', role => {
  for (const documentAccess of ['none', 'view', 'edit'] as const) {
    const result = render(<SignedIn account={{ ...testAccount, role, documentAccess }}><ChildDocuments childId="child-1" /></SignedIn>);
    expect(screen.queryByRole('region', { name: 'Documents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Registration checklist' })).not.toBeInTheDocument();
    expect(api.listChildDocuments).not.toHaveBeenCalled();
    expect(formsApi.getRegistrationChecklist).not.toHaveBeenCalled();
    result.unmount();
  }
});

test('new upload preserves its file and request ID after an uncertain response, then saves to the stable child ID', async () => {
  vi.mocked(api.addChildDocument).mockRejectedValueOnce(new Error('Disconnected'));
  const report = vi.fn();
  render(<SignedIn><UnsavedChangesContext.Provider value={report}><ChildDocuments childId="child-1" openAdd /></UnsavedChangesContext.Provider></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'New consent' } });
  fireEvent.change(screen.getByLabelText('Document category'), { target: { value: 'consent' } }); uploadFile();
  fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
  await screen.findByText(/Your changes are still here/);
  expect(screen.getByLabelText('Document title')).toHaveValue('New consent');
  const requestId = vi.mocked(api.addChildDocument).mock.calls[0][3]; expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
  await screen.findByText('Document saved.');
  expect(api.addChildDocument).toHaveBeenLastCalledWith('child-1', expect.objectContaining({ title: 'New consent', category: 'consent' }), expect.objectContaining({ name: 'synthetic.pdf' }), requestId, expect.any(AbortSignal));
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false));
});

test('camera selection previews and retakes locally, and requires confirmation before any upload', async () => {
  render(<SignedIn><ChildDocuments childId="child-1" openAdd /></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Synthetic camera form' } });
  fireEvent.change(screen.getByLabelText('Take a photo'), { target: { files: [new File(['first'], 'first.png', { type: 'image/png' })] } });
  const first = await screen.findByAltText('Captured document preview'); expect(first).toHaveAttribute('src', 'blob:synthetic-1');
  expect(screen.getByRole('button', { name: 'Save document' })).toBeDisabled(); expect(api.addChildDocument).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Retake photo'), { target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] } });
  await waitFor(() => expect(screen.getByAltText('Captured document preview')).toHaveAttribute('src', 'blob:synthetic-2'));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-1');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm photo' })); fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
  await screen.findByText('Document saved.'); expect(api.addChildDocument).toHaveBeenCalledTimes(1);
  expect(api.addChildDocument).toHaveBeenCalledWith('child-1', expect.anything(), expect.objectContaining({ name: 'second.png' }), expect.any(String), expect.any(AbortSignal));
});

test('invalid file size and type produce clear errors without starting an upload', async () => {
  render(<SignedIn><ChildDocuments childId="child-1" openAdd /></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
  uploadFile(new File(['script'], 'synthetic.html', { type: 'text/html' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF, JPG or PNG');
  uploadFile(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' }));
  expect(screen.getByRole('alert')).toHaveTextContent('5 MB or less'); expect(api.readDocumentFile).not.toHaveBeenCalled(); expect(api.addChildDocument).not.toHaveBeenCalled();
});

test('metadata edit sends the saved version and retains the original file history', async () => {
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit document details' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Renamed synthetic consent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save document details' })); await screen.findByText('Document details saved.');
  expect(api.updateChildDocument).toHaveBeenCalledWith('child-1', document, expect.objectContaining({ title: 'Renamed synthetic consent' }), expect.any(AbortSignal));
  expect(api.readDocumentFile).not.toHaveBeenCalled(); expect(api.reviseChildDocument).not.toHaveBeenCalled();
});

test('a failed replacement keeps the current revision and the replacement draft for retry', async () => {
  vi.mocked(api.reviseChildDocument).mockRejectedValueOnce(new Error('Storage unavailable'));
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Upload new version' })); uploadFile(new File(['png'], 'revised.png', { type: 'image/png' }));
  fireEvent.change(screen.getByLabelText('Change note (optional)'), { target: { value: 'Corrected signature' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save new version' })); await screen.findByText(/Your changes are still here/);
  expect(screen.getByText('Current version')).toBeInTheDocument(); expect(screen.getByText('Version 1')).toBeInTheDocument(); expect(screen.getByText('revised.png')).toBeInTheDocument();
  const requestId = vi.mocked(api.reviseChildDocument).mock.calls[0][4];
  fireEvent.click(screen.getByRole('button', { name: 'Save new version' })); await screen.findByText('New version saved. Previous versions are kept.');
  expect(api.reviseChildDocument).toHaveBeenLastCalledWith('child-1', document, expect.objectContaining({ name: 'revised.png' }), 'Corrected signature', requestId, expect.any(AbortSignal));
});

test('authenticated PDF preview uses a canvas without a private URL, and image URLs are revoked on close or session expiry', async () => {
  const shown = render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview version 1' }));
  await screen.findByRole('img', { name: 'PDF page 1' });
  expect(api.getDocumentContent).toHaveBeenCalledWith('child-1', document.id, revision.id, false, expect.any(AbortSignal));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  shown.unmount();
  vi.mocked(api.getChildDocument).mockResolvedValue({ document, revisions: [{ ...revision, filename: 'synthetic.png', contentType: 'image/png' }], total: 1 });
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview version 1' })); await screen.findByAltText('Document version 1 preview');
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' })); await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-1'));
  await waitFor(() => expect(screen.queryByAltText('Document version 1 preview')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Preview version 1' }));
  await waitFor(() => expect(screen.getByAltText('Document version 1 preview')).toHaveAttribute('src', 'blob:synthetic-2'));
  for (const callback of sessionExpired) callback();
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Documents' })).not.toBeInTheDocument());
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-2'));
});

test('changing child ID aborts stale document results and cannot display another child’s file', async () => {
  let finish: (value: { items: ChildDocument[]; total: number }) => void = () => {};
  vi.mocked(api.listChildDocuments).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = render(<SignedIn><ChildDocuments childId="old-child" /></SignedIn>);
  const previousSignal = vi.mocked(api.listChildDocuments).mock.calls[0][2];
  result.rerender(<SignedIn><ChildDocuments childId="new-child" /></SignedIn>);
  expect(previousSignal.aborted).toBe(true);
  finish({ items: [{ ...document, title: 'Old child secret' }], total: 1 });
  await screen.findByRole('button', { name: /Synthetic consent.*Consent form/ });
  expect(screen.queryByText('Old child secret')).not.toBeInTheDocument();
});

test('cancel and document switching ask before dropping a draft', async () => {
  render(<SignedIn><ChildDocuments childId="child-1" openAdd /></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'Unsaved synthetic document' } });
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel document changes' })); expect(screen.getByLabelText('Document title')).toHaveValue('Unsaved synthetic document');
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic consent.*Consent form/ })); expect(api.getChildDocument).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Cancel document changes' }));
  expect(screen.queryByRole('form', { name: 'Add document' })).not.toBeInTheDocument();
  await selectDocument(); expect(within(screen.getByRole('region', { name: 'Selected document' })).getByText('Version 1')).toBeInTheDocument();
});

const registrationForm: RegistrationForm = { id: 'form-1', title: 'Academy enrollment consent', instructions: 'Complete every field and sign the last page.', category: 'consent', required: true, active: true, version: 1, currentRevisionId: 'blank-1', templateRevision: 1, updatedAt: '2026-10-01T10:00:00Z' };
const linkedDocument: ChildDocument = { ...document, registrationFormId: registrationForm.id, registrationFormRevisionId: registrationForm.currentRevisionId, reviewedRevisionId: null };
function checklist(status: RegistrationChecklist['items'][number]['status'], savedDocument: ChildDocument | null = linkedDocument, template = registrationForm): RegistrationChecklist {
  return { items: [{ form: template, status, document: savedDocument }], requiredTotal: 1, requiredComplete: status === 'complete' ? 1 : 0, complete: status === 'complete' };
}

test('opening after a saved child shows the checklist without creating an empty upload draft', async () => {
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValue(checklist('missing', null));
  render(<SignedIn><ChildDocuments childId="child-1" openAdd /></SignedIn>);
  const row = await screen.findByRole('article', { name: registrationForm.title });
  expect(within(row).getByText('Missing')).toBeInTheDocument();
  expect(screen.queryByRole('form', { name: 'Add document' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Registration checklist' })).toHaveFocus();
  expect(api.addChildDocument).not.toHaveBeenCalled();
});

test('attaching a completed copy preselects the catalog title, category and current blank revision', async () => {
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValue(checklist('missing', null));
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'Attach completed ' + registrationForm.title }));
  expect(screen.getByLabelText('Document title')).toHaveValue(registrationForm.title);
  expect(screen.getByLabelText('Document category')).toHaveValue('consent');
  uploadFile(); fireEvent.click(screen.getByRole('button', { name: 'Save document' }));
  await screen.findByText('Document saved.');
  expect(api.addChildDocument).toHaveBeenCalledWith('child-1', expect.objectContaining({ title: registrationForm.title, category: 'consent', registrationFormId: 'form-1', registrationFormRevisionId: 'blank-1' }), expect.anything(), expect.any(String), expect.any(AbortSignal));
});

test('review requires an explicit acknowledgement and only then marks required registration complete', async () => {
  let state = checklist('needs_review');
  vi.mocked(formsApi.getRegistrationChecklist).mockImplementation(async () => state);
  vi.mocked(api.getChildDocument).mockImplementation(async () => ({ document: state.items[0].document!, revisions: [revision], total: 1 }));
  vi.mocked(api.reviewChildDocument).mockImplementation(async () => {
    const reviewed = { ...linkedDocument, version: 2, reviewedRevisionId: revision.id, reviewedAt: '2026-10-02T10:00:00Z' };
    state = checklist('complete', reviewed); return { document: reviewed };
  });
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'Review completed ' + registrationForm.title }));
  const mark = await screen.findByRole('button', { name: 'Mark reviewed' }); expect(mark).toBeDisabled();
  fireEvent.click(mark); expect(api.reviewChildDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I checked this copy is filled out and signed where required' }));
  fireEvent.click(mark); await screen.findByText(/Registration complete$/);
  expect(api.reviewChildDocument).toHaveBeenCalledWith('child-1', linkedDocument, true, expect.any(AbortSignal));
  expect(screen.getByText(/Current copy reviewed/)).toBeInTheDocument();
});

test('an updated blank form needs a new mapped completed copy and cannot review the old one', async () => {
  const updated = { ...registrationForm, currentRevisionId: 'blank-2', templateRevision: 2, version: 2 };
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValue(checklist('outdated', linkedDocument, updated));
  vi.mocked(api.getChildDocument).mockResolvedValue({ document: linkedDocument, revisions: [revision], total: 1 });
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: 'View completed ' + registrationForm.title }));
  await screen.findByRole('region', { name: 'Selected document' });
  expect(screen.getByText('Updated form needed')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Attach completed ' + registrationForm.title })); uploadFile();
  fireEvent.click(screen.getByRole('button', { name: 'Save document' })); await screen.findByText('Document saved.');
  expect(api.addChildDocument).toHaveBeenCalledWith('child-1', expect.objectContaining({ registrationFormRevisionId: 'blank-2' }), expect.anything(), expect.any(String), expect.any(AbortSignal));
});

test('existing unmatched copies can be linked after confirming the selected blank revision', async () => {
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValue(checklist('missing', null));
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  await screen.findByRole('article', { name: registrationForm.title });
  fireEvent.click(screen.getByRole('button', { name: 'Edit document details' }));
  fireEvent.change(screen.getByLabelText('Registration form (optional)'), { target: { value: 'form-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save document details' }));
  expect(api.updateChildDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'I confirmed this completed copy uses blank form version 1.' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save document details' })); await screen.findByText('Document details saved.');
  expect(api.updateChildDocument).toHaveBeenCalledWith('child-1', document, expect.objectContaining({ registrationFormId: 'form-1', registrationFormRevisionId: 'blank-1' }), expect.any(AbortSignal));
});

test('a replaced completed file needs a fresh acknowledgement and review', async () => {
  let savedDocument: ChildDocument = { ...linkedDocument, reviewedRevisionId: revision.id };
  let state = checklist('complete', savedDocument);
  vi.mocked(formsApi.getRegistrationChecklist).mockImplementation(async () => state);
  vi.mocked(api.getChildDocument).mockImplementation(async () => ({ document: savedDocument, revisions: [revision], total: 1 }));
  vi.mocked(api.reviseChildDocument).mockImplementation(async () => {
    savedDocument = { ...linkedDocument, version: 2, currentRevisionId: 'revision-2', reviewedRevisionId: null }; state = checklist('needs_review', savedDocument);
    return { document: savedDocument, revision: { ...revision, id: 'revision-2', revision: 2 } };
  });
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  await screen.findByText(/Registration complete$/);
  fireEvent.click(screen.getByRole('button', { name: 'Upload new version' })); uploadFile();
  fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
  await screen.findByText('Needs review');
  expect(await screen.findByRole('checkbox', { name: 'I checked this copy is filled out and signed where required' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
  expect(screen.queryByText(/Registration complete$/)).not.toBeInTheDocument();
});

test('a failed refresh clears previous completion and empty catalogs never claim registration complete', async () => {
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValueOnce(checklist('complete', { ...linkedDocument, reviewedRevisionId: revision.id })).mockRejectedValueOnce(new Error('Disconnected'));
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>);
  await screen.findByText(/Registration complete$/); await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh documents' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh documents' }));
  await screen.findByText(/Registration completion could not be verified/);
  expect(screen.queryByText(/Registration complete$/)).not.toBeInTheDocument();
  vi.mocked(formsApi.getRegistrationChecklist).mockResolvedValue({ items: [], requiredTotal: 0, requiredComplete: 0, complete: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh documents' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'Refresh documents' }));
  await screen.findByText(/No registration forms have been set up/);
  expect(screen.queryByText(/Registration complete$/)).not.toBeInTheDocument();
});

test('document version conflicts preserve the draft and explicitly load the latest version for retry', async () => {
  vi.mocked(api.updateChildDocument).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409 } });
  render(<SignedIn><ChildDocuments childId="child-1" /></SignedIn>); await selectDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit document details' }));
  fireEvent.change(screen.getByLabelText('Document title'), { target: { value: 'My retained title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save document details' }));
  const reload = await screen.findByRole('button', { name: 'Load latest document version' });
  expect(screen.getByLabelText('Document title')).toHaveValue('My retained title');
  vi.mocked(api.getChildDocument).mockResolvedValue({ document: { ...document, version: 3 }, revisions: [revision], total: 1 });
  fireEvent.click(reload); await screen.findByText(/Latest document version loaded/);
  fireEvent.click(screen.getByRole('button', { name: 'Save document details' })); await screen.findByText('Document details saved.');
  expect(api.updateChildDocument).toHaveBeenLastCalledWith('child-1', expect.objectContaining({ version: 3 }), expect.objectContaining({ title: 'My retained title' }), expect.any(AbortSignal));
});
