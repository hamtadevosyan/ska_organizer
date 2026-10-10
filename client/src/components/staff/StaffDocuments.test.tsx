import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { SignedIn } from '../../tests/authFixture';
import { testAccount } from '../../tests/authAccount';
import { StaffDocuments } from './StaffDocuments';
import * as api from '../../api/staffDocuments';
import { analyzeStaffDocumentExpiration } from './staffDocumentExpiration';
import type { StaffChecklist, StaffCompliance, StaffDocument, StaffDocumentMetadata, StaffDocumentRevision, StaffRequirement } from '../../api/staffDocuments';
vi.mock('../../api/staffDocuments', async original => ({ ...await original<typeof api>(), getStaffChecklist: vi.fn(), getStaffCompliance: vi.fn(), getStaffComplianceSettings: vi.fn(), updateStaffComplianceSettings: vi.fn(), listStaffDocuments: vi.fn(), getStaffDocument: vi.fn(), addStaffDocument: vi.fn(), updateStaffDocument: vi.fn(), reviseStaffDocument: vi.fn(), reviewStaffDocument: vi.fn(), getStaffDocumentContent: vi.fn() }));
const expiry = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
vi.mock('../../auth/transport', () => ({ onSessionExpired: (callback: () => void) => { expiry.callbacks.add(callback); return () => expiry.callbacks.delete(callback); }, authError: (failure: { response?: { data?: { error?: { message?: string } } } }, fallback: string) => failure.response?.data?.error?.message || fallback }));
vi.mock('../registration/BlankFormActions', () => ({ BlankFormActions: ({ form }: { form: { title: string } }) => <button>Preview blank {form.title}</button> }));
vi.mock('../children/PdfDocumentPreview', () => ({ default: () => <p>Local PDF preview</p> }));
vi.mock('./staffDocumentExpiration', () => ({ analyzeStaffDocumentExpiration: vi.fn() }));
const employee = 'staff-one';
const form: StaffRequirement = { id: 'form-one', title: 'CPR training', category: 'other', audience: 'employee', instructions: 'Provide a current certificate.', required: true, active: true, version: 1, currentRevisionId: 'blank-one', templateRevision: 1, updatedAt: '2026-10-08T10:00:00Z', expirationRequired: true };
const metadata: StaffDocumentMetadata = { title: form.title, category: 'other', documentDate: null, notes: 'Private personnel note', issuer: 'Private issuer', reference: 'Private certificate number', issuedOn: '2026-01-01', expiresOn: '2026-11-01', nonExpiring: false, warningDays: null, registrationFormId: form.id, registrationFormRevisionId: form.currentRevisionId };
const initial: StaffDocument = { ...metadata, id: 'document-one', staffId: employee, version: 1, currentRevisionId: 'revision-one', reviewedRevisionId: null, reviewedAt: null, reviewedBy: null, updatedAt: '2026-10-08T10:00:00Z' };
const revision: StaffDocumentRevision = { id: 'revision-one', revision: 1, filename: 'certificate.png', contentType: 'image/png', byteLength: 8, sha256: 'synthetic', uploadedAt: '2026-10-08T10:00:00Z', uploadedBy: 'Administrator', changeNote: null, current: true, expiresOn: initial.expiresOn, nonExpiring: false };
const emptyAlerts = (): StaffCompliance => ({ items: [], totals: {}, configured: true, requiredTotal: 1, activeStaffTotal: 1, warningDays: 40, today: '2026-10-08', timeZone: 'America/Los_Angeles' });
let documents: StaffDocument[]; let revisions: StaffDocumentRevision[]; let requirements: StaffRequirement[]; let status: StaffChecklist['items'][number]['status'] | null;
const renderArea = (role: 'admin' | 'editor' | 'viewer' = 'admin') => render(<SignedIn account={{ ...testAccount, role }}><StaffDocuments staffId={employee} employeeName="Synthetic Teacher" /></SignedIn>);
const png = (name = 'certificate.png') => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
async function ready() { await screen.findByRole('button', { name: 'Add staff document' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh staff documents' })).toBeEnabled()); }
async function attach() { await ready(); fireEvent.click(screen.getByRole('button', { name: 'Attach completed CPR training' })); }
function upload(file = png()) { fireEvent.change(screen.getByLabelText('Upload a staff document'), { target: { files: [file] } }); }
async function openDocument() { await ready(); fireEvent.click(screen.getByRole('button', { name: /^CPR training Expires/ })); await screen.findByRole('region', { name: 'Selected staff document' }); }
beforeEach(() => {
  vi.clearAllMocks(); expiry.callbacks.clear(); documents = []; revisions = []; requirements = [structuredClone(form)]; status = null;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  URL.createObjectURL = vi.fn(() => 'blob:local-staff-document'); URL.revokeObjectURL = vi.fn();
  vi.mocked(analyzeStaffDocumentExpiration).mockResolvedValue({ candidates: [], incomplete: false });
  vi.mocked(api.getStaffComplianceSettings).mockResolvedValue({ warningDays: 40, version: 1 }); vi.mocked(api.getStaffCompliance).mockResolvedValue(emptyAlerts());
  vi.mocked(api.updateStaffComplianceSettings).mockImplementation(async (previous, warningDays) => ({ warningDays, version: previous.version + 1 }));
  vi.mocked(api.listStaffDocuments).mockImplementation(async () => ({ items: structuredClone(documents), total: documents.length }));
  vi.mocked(api.getStaffChecklist).mockImplementation(async () => {
    const items = requirements.map(requirement => ({ form: requirement, status: status || (!documents[0] ? 'missing' : documents[0].reviewedRevisionId === documents[0].currentRevisionId ? 'expiring' : 'needs_review'), document: documents[0] || null, expiresOn: documents[0]?.expiresOn || null, daysRemaining: documents[0] ? 24 : null }));
    const complete = items.filter(item => item.form.required && (item.status === 'complete' || item.status === 'expiring')).length; const total = items.filter(item => item.form.required).length;
    return { items, requiredTotal: total, requiredComplete: complete, complete: total > 0 && complete === total, percentage: total ? Math.round(complete / total * 100) : 0, today: '2026-10-08', timeZone: 'America/Los_Angeles', warningDays: 40 } as StaffChecklist;
  });
  vi.mocked(api.getStaffDocument).mockImplementation(async () => ({ document: structuredClone(documents[0]), revisions: structuredClone(revisions), total: revisions.length }));
  vi.mocked(api.addStaffDocument).mockImplementation(async (_staffId, details) => { documents = [{ ...initial, ...details }]; revisions = [structuredClone(revision)]; return { document: documents[0], revision }; });
  vi.mocked(api.updateStaffDocument).mockImplementation(async (_staffId, previous, details) => { documents = [{ ...previous, ...details, version: previous.version + 1, reviewedRevisionId: null }]; return { document: documents[0] }; });
  vi.mocked(api.reviseStaffDocument).mockImplementation(async (_staffId, previous, details) => { const next = { ...revision, id: 'revision-two', revision: 2, expiresOn: details.expiresOn }; revisions = [next, { ...revision, current: false }]; documents = [{ ...previous, ...details, currentRevisionId: next.id, reviewedRevisionId: null, version: previous.version + 1 }]; return { document: documents[0], revision: next }; });
  vi.mocked(api.reviewStaffDocument).mockImplementation(async (_staffId, previous, reviewed) => { documents = [{ ...previous, version: previous.version + 1, reviewedRevisionId: reviewed ? previous.currentRevisionId : null }]; return { document: documents[0] }; });
  vi.mocked(api.getStaffDocumentContent).mockResolvedValue(new Blob(['original file bytes'], { type: 'image/png' }));
});

test('missing documents use a configurable 40-day local reminder and do not imply completion', async () => {
  renderArea(); await ready(); expect(screen.getByRole('region', { name: 'Employee requirements' })).toHaveTextContent('Missing document'); expect(screen.getByLabelText('Default reminder days')).toHaveValue(40); expect(screen.getByText('0% complete · 0 of 1 required documents current · Needs attention')).toBeInTheDocument(); expect(api.getStaffCompliance).not.toHaveBeenCalled();
});
test('externally issued certificates need no blank template file', async () => {
  requirements[0].currentRevisionId = null; requirements[0].templateRevision = 0; renderArea(); await attach(); expect(screen.queryByRole('button', { name: 'Preview blank CPR training' })).not.toBeInTheDocument(); upload(); fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-01-01' } }); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); await screen.findByText('Staff document saved. Check its dates and mark it reviewed.'); expect(api.addStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ registrationFormId: form.id, registrationFormRevisionId: null }), expect.objectContaining({ dataBase64: 'iVBORw0KGgo=' }), expect.any(String), expect.any(AbortSignal));
});
test('uploads original bytes and requirement mapping with dates and a reminder override', async () => {
  renderArea(); await attach(); upload(); fireEvent.change(screen.getByLabelText('Issued date (optional)'), { target: { value: '2026-01-01' } }); fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-01-01' } }); fireEvent.change(screen.getByLabelText('Reminder days (optional)'), { target: { value: '30' } }); fireEvent.change(screen.getByLabelText('Issuer (optional)'), { target: { value: 'Training center' } }); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); await screen.findByRole('region', { name: 'Selected staff document' }); expect(api.addStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ issuedOn: '2026-01-01', expiresOn: '2027-01-01', issuer: 'Training center', warningDays: 30, registrationFormRevisionId: 'blank-one' }), { name: 'certificate.png', contentType: 'image/png', dataBase64: 'iVBORw0KGgo=' }, expect.any(String), expect.any(AbortSignal)); expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
});
test('reversed dates are rejected before upload and the file is preserved', async () => {
  renderArea(); await attach(); upload(); fireEvent.change(screen.getByLabelText('Issued date (optional)'), { target: { value: '2027-01-01' } }); fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2026-01-01' } }); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); expect(screen.getByRole('alert')).toHaveTextContent('Expiration date must be on or after the issued date.'); expect(api.addStaffDocument).not.toHaveBeenCalled(); expect(screen.getByText('certificate.png')).toBeInTheDocument();
});
test('an expiration-required certificate cannot be nonexpiring', async () => { renderArea(); await attach(); expect(screen.getByRole('checkbox', { name: 'Does not expire' })).toBeDisabled(); });
test('documents without an expiry rule can be explicitly nonexpiring', async () => {
  requirements[0].expirationRequired = false; renderArea(); await attach(); upload(); fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' })); expect(screen.getByLabelText('Expiration date')).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); await screen.findByText('Staff document saved. Check its dates and mark it reviewed.'); expect(api.addStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ expiresOn: null, nonExpiring: true }), expect.anything(), expect.any(String), expect.any(AbortSignal));
});
test.each([0, 366, 1.5])('rejects an invalid reminder %s', async days => {
  renderArea(); await attach(); upload(); fireEvent.change(screen.getByLabelText('Reminder days (optional)'), { target: { value: String(days) } }); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); expect(screen.getByRole('alert')).toHaveTextContent('Enter a reminder between 1 and 365 days'); expect(api.addStaffDocument).not.toHaveBeenCalled();
});
test('rejects unsupported and oversized files before reading them', async () => {
  renderArea(); await attach(); upload(new File(['text'], 'file.txt', { type: 'text/plain' })); expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF, JPG or PNG file.'); upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })); expect(screen.getByRole('alert')).toHaveTextContent('Choose a file of 5 MB or less.'); expect(api.addStaffDocument).not.toHaveBeenCalled();
});
test('an interrupted upload keeps its draft and reuses the request ID on retry', async () => {
  vi.mocked(api.addStaffDocument).mockRejectedValueOnce(new Error('Synthetic outage')); renderArea(); await attach(); upload(); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); await screen.findByText('Could not save this document. Your changes are still here.'); await waitFor(() => expect(screen.getByRole('button', { name: 'Save staff document' })).toBeEnabled()); expect(screen.getByText('certificate.png')).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); await screen.findByText('Staff document saved. Check its dates and mark it reviewed.'); expect(api.addStaffDocument).toHaveBeenCalledTimes(2); expect(vi.mocked(api.addStaffDocument).mock.calls[0][3]).toBe(vi.mocked(api.addStaffDocument).mock.calls[1][3]);
});
test('review requires acknowledgement and expiring training remains actionable', async () => {
  documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; renderArea(); await openDocument(); fireEvent.click(screen.getByRole('checkbox', { name: 'I checked this document and its dates' })); fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' })); await screen.findByText('Staff document reviewed.'); await screen.findByText(/Requirements satisfied/); expect(api.reviewStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ id: initial.id, version: 1 }), true, expect.any(AbortSignal)); expect(screen.getByRole('region', { name: 'Employee requirements' })).toHaveTextContent('Renewal due soon'); expect(screen.getByRole('region', { name: 'Employee requirements' })).toHaveTextContent('24 days remaining');
});
test('renewal saves new dates and retains both versions while resetting review', async () => {
  documents = [{ ...initial, reviewedRevisionId: initial.currentRevisionId }]; revisions = [structuredClone(revision)]; renderArea(); await openDocument(); fireEvent.click(screen.getByRole('button', { name: 'Upload new version' })); upload(png('renewed.png')); fireEvent.change(screen.getByLabelText('Issued date (optional)'), { target: { value: '2026-10-08' } }); fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2028-10-08' } }); fireEvent.click(screen.getByRole('button', { name: 'Save new version' })); await screen.findByText('New version saved. Previous files and dates are kept. Review the renewed copy.'); await screen.findByRole('button', { name: 'Preview staff document version 2' }); expect(screen.getByRole('button', { name: 'Preview staff document version 1' })).toBeInTheDocument(); expect(api.reviseStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ id: initial.id, version: 1 }), expect.objectContaining({ expiresOn: '2028-10-08', issuedOn: '2026-10-08' }), expect.objectContaining({ name: 'renewed.png' }), '', expect.any(String), expect.any(AbortSignal)); expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled(); expect(screen.queryByText(/Current copy reviewed/)).not.toBeInTheDocument();
});
test.each(['expired', 'expiry_missing', 'outdated'] as const)('%s requirements stay incomplete', async value => {
  documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; status = value; renderArea(); await ready(); expect(screen.getByRole('region', { name: 'Employee requirements' })).toHaveTextContent(api.staffComplianceLabels[value]); expect(screen.queryByText(/Requirements satisfied/)).not.toBeInTheDocument();
});
test('an optional-only catalog never claims employee compliance is complete', async () => {
  requirements[0].required = false; renderArea(); await ready(); expect(screen.getByText('No required employee forms have been configured. Completion cannot be verified.')).toBeInTheDocument(); expect(screen.queryByText(/100% complete/)).not.toBeInTheDocument();
});
test('editor receives only safe reminders for this employee', async () => {
  vi.mocked(api.getStaffCompliance).mockResolvedValue({ ...emptyAlerts(), items: [{ staffId: employee, employeeName: 'Synthetic Teacher', requirementId: form.id, requirementTitle: form.title, status: 'expired', expiresOn: '2026-10-01', daysRemaining: -7 }, { staffId: 'other-staff', employeeName: 'Another Teacher', requirementId: 'other', requirementTitle: 'Another certificate', status: 'missing', expiresOn: null, daysRemaining: null }] }); renderArea('editor'); await screen.findByRole('article', { name: form.title }); expect(screen.queryByText('Another certificate')).not.toBeInTheDocument(); expect(screen.getByRole('region', { name: 'Employee requirements' })).toHaveTextContent('Expired'); expect(screen.queryByText('Private personnel note')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Add staff document' })).not.toBeInTheDocument(); expect(api.getStaffChecklist).not.toHaveBeenCalled(); expect(api.listStaffDocuments).not.toHaveBeenCalled(); expect(api.getStaffDocument).not.toHaveBeenCalled(); expect(api.getStaffComplianceSettings).not.toHaveBeenCalled();
});
test('viewer sees no compliance and makes no sensitive requests', async () => {
  renderArea('viewer'); expect(screen.queryByRole('region', { name: 'Staff documents and training' })).not.toBeInTheDocument(); expect(api.getStaffCompliance).not.toHaveBeenCalled(); expect(api.getStaffChecklist).not.toHaveBeenCalled(); expect(api.listStaffDocuments).not.toHaveBeenCalled();
});
test('editor sees an explicit warning for an unconfigured catalog', async () => {
  vi.mocked(api.getStaffCompliance).mockResolvedValue({ ...emptyAlerts(), configured: false, requiredTotal: 0 }); renderArea('editor'); await screen.findByText('No required employee forms have been configured. An administrator needs to set up the requirements.'); expect(screen.queryByText(/No actionable/)).not.toBeInTheDocument();
});
test('admin can change the facility reminder period using its current version', async () => {
  renderArea(); await ready(); fireEvent.change(screen.getByLabelText('Default reminder days'), { target: { value: '30' } }); fireEvent.click(screen.getByRole('button', { name: 'Save reminder timing' })); await screen.findByText('Reminder timing saved for all staff.'); expect(api.updateStaffComplianceSettings).toHaveBeenCalledWith({ warningDays: 40, version: 1 }, 30, expect.any(AbortSignal));
});
test('a confidential image is previewed locally and its URL is revoked on expiry', async () => {
  documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; renderArea(); await openDocument(); fireEvent.click(screen.getByRole('button', { name: 'Preview staff document version 1' })); await screen.findByRole('img', { name: 'Staff document version 1 preview' }); expect(api.getStaffDocumentContent).toHaveBeenCalledWith(employee, initial.id, revision.id, false, expect.any(AbortSignal)); await act(async () => { expiry.callbacks.forEach(callback => callback()); }); expect(screen.queryByRole('region', { name: 'Staff documents and training' })).not.toBeInTheDocument(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-staff-document');
});
test('expiry aborts pending uploads, removes private drafts and ignores late results', async () => {
  let finish!: (value: { document: StaffDocument; revision: StaffDocumentRevision }) => void; vi.mocked(api.addStaffDocument).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); renderArea(); await attach(); upload(); fireEvent.click(screen.getByRole('button', { name: 'Save staff document' })); await waitFor(() => expect(api.addStaffDocument).toHaveBeenCalled()); const signal = vi.mocked(api.addStaffDocument).mock.calls[0][4]; await act(async () => { expiry.callbacks.forEach(callback => callback()); }); expect(signal.aborted).toBe(true); await act(async () => finish({ document: initial, revision })); expect(screen.queryByRole('region', { name: 'Staff documents and training' })).not.toBeInTheDocument(); expect(screen.queryByText(/Staff document saved/)).not.toBeInTheDocument();
});
test('a role change removes private data and uses only the editor reminder endpoint', async () => {
  documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; const view = renderArea(); await openDocument(); expect(screen.getByText('Private personnel note')).toBeInTheDocument(); view.rerender(<SignedIn account={{ ...testAccount, role: 'editor' }}><StaffDocuments staffId={employee} employeeName="Synthetic Teacher" /></SignedIn>); await screen.findByText(/No actionable document reminders/); expect(screen.queryByText('Private personnel note')).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Selected staff document' })).not.toBeInTheDocument(); expect(api.getStaffCompliance).toHaveBeenCalledOnce();
});
test('metadata-only edits require a discard confirmation', async () => {
  renderArea(); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Add staff document' })); fireEvent.change(screen.getByLabelText('Issuer (optional)'), { target: { value: 'Unsaved issuer' } }); vi.mocked(window.confirm).mockReturnValue(false); fireEvent.click(screen.getByRole('button', { name: 'Cancel document changes' })); expect(window.confirm).toHaveBeenCalledWith('Discard the unsaved staff document changes?'); expect(screen.getByLabelText('Issuer (optional)')).toHaveValue('Unsaved issuer');
});
test('a conflict preserves the draft until an explicit latest-version reload', async () => {
  documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; vi.mocked(api.updateStaffDocument).mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: { message: 'Document changed elsewhere.' } } } }); renderArea(); await openDocument(); fireEvent.click(screen.getByRole('button', { name: 'Edit document details' })); fireEvent.change(screen.getByLabelText('Issuer (optional)'), { target: { value: 'My unsaved issuer' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document details' })); await screen.findByRole('button', { name: 'Load latest document version' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Load latest document version' })).toBeEnabled()); expect(screen.getByLabelText('Issuer (optional)')).toHaveValue('My unsaved issuer'); expect(screen.getByRole('button', { name: 'Save document details' })).toBeDisabled(); documents[0].version = 3; fireEvent.click(screen.getByRole('button', { name: 'Load latest document version' })); await screen.findByText('Latest version loaded. Your draft is still here; check it before saving.'); expect(screen.getByLabelText('Issuer (optional)')).toHaveValue('My unsaved issuer');
});
test('camera capture requires confirming the local photo before saving', async () => {
  vi.stubGlobal('isSecureContext', true); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } }); renderArea(); await attach(); const input = screen.getByLabelText('Take a photo'); expect(input).toHaveAttribute('capture', 'environment'); fireEvent.change(input, { target: { files: [png('camera.png')] } }); expect(screen.getByRole('button', { name: 'Save staff document' })).toBeDisabled(); expect(screen.getByRole('img', { name: 'Captured staff document preview' })).toBeInTheDocument(); expect(analyzeStaffDocumentExpiration).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Confirm photo' })); expect(screen.getByRole('button', { name: 'Save staff document' })).toBeEnabled(); expect(analyzeStaffDocumentExpiration).toHaveBeenCalledWith(employee, expect.objectContaining({ name: 'camera.png' }), expect.any(AbortSignal)); expect(api.addStaffDocument).not.toHaveBeenCalled();
});
test('PDF preview uses local pixels without a browser document embed', async () => {
  documents = [structuredClone(initial)]; revisions = [{ ...revision, contentType: 'application/pdf', filename: 'certificate.pdf' }]; vi.mocked(api.getStaffDocumentContent).mockResolvedValue(new Blob(['%PDF-1.7'], { type: 'application/pdf' })); renderArea(); await openDocument(); fireEvent.click(screen.getByRole('button', { name: 'Preview staff document version 1' })); await screen.findByText('Local PDF preview'); expect(document.querySelector('iframe,embed,object')).toBeNull();
});

test('a nonexpiring draft can be corrected after selecting an expiration-required form', async () => {
  renderArea(); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Add staff document' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' }));
  fireEvent.change(screen.getByLabelText('Employee requirement (optional)'), { target: { value: form.id } });
  const nonExpiring = screen.getByRole('checkbox', { name: 'Does not expire' });
  expect(nonExpiring).toBeChecked(); expect(nonExpiring).toBeEnabled();
  fireEvent.click(nonExpiring); expect(nonExpiring).not.toBeChecked(); expect(nonExpiring).toBeDisabled();
  expect(screen.getByLabelText('Expiration date')).toBeEnabled();
});

test('an existing nonexpiring document can be corrected after its requirement policy changes', async () => {
  documents = [{ ...initial, nonExpiring: true, expiresOn: null }]; revisions = [structuredClone(revision)]; renderArea(); await ready();
  fireEvent.click(screen.getByRole('button', { name: /^CPR training Does not expire/ }));
  await screen.findByRole('region', { name: 'Selected staff document' }); fireEvent.click(screen.getByRole('button', { name: 'Edit document details' }));
  const nonExpiring = screen.getByRole('checkbox', { name: 'Does not expire' }); expect(nonExpiring).toBeEnabled(); fireEvent.click(nonExpiring);
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-01-01' } }); fireEvent.click(screen.getByRole('button', { name: 'Save document details' }));
  await screen.findByText('Document details saved. Check this version and review it again.');
  expect(api.updateStaffDocument).toHaveBeenCalledWith(employee, expect.anything(), expect.objectContaining({ nonExpiring: false, expiresOn: '2027-01-01' }), expect.any(AbortSignal));
});

test('a reminder setting conflict retains the typed days until the admin explicitly refreshes', async () => {
  vi.mocked(api.updateStaffComplianceSettings).mockRejectedValueOnce({ response: { data: { error: { message: 'Reminder setting changed elsewhere.' } } } });
  renderArea(); await ready(); fireEvent.change(screen.getByLabelText('Default reminder days'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save reminder timing' })); await screen.findByText('Reminder setting changed elsewhere.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh staff documents' })).toBeEnabled());
  expect(screen.getByLabelText('Default reminder days')).toHaveValue(30);
  vi.mocked(api.getStaffComplianceSettings).mockResolvedValue({ warningDays: 45, version: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh staff documents' }));
  await waitFor(() => expect(screen.getByLabelText('Default reminder days')).toHaveValue(45));
});

test('expiration suggestions require confirmation and leave a manually entered date unchanged', async () => {
  let finish!: (result: Awaited<ReturnType<typeof analyzeStaffDocumentExpiration>>) => void;
  vi.mocked(analyzeStaffDocumentExpiration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  renderArea(); await attach(); upload();
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-03-01' } });
  await act(async () => finish({ candidates: [{ date: '2028-03-01', label: 'Expires March 1, 2028' }], incomplete: false }));
  expect(screen.getByLabelText('Expiration date')).toHaveValue('2027-03-01');
  expect(api.addStaffDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use expiration date 2028-03-01' }));
  expect(screen.getByLabelText('Expiration date')).toHaveValue('2028-03-01');
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('Reminders start 2028-01-21 · 40 days before expiration.');
});

test('multiple possible expiration dates remain separate choices with a partial-reading warning', async () => {
  vi.mocked(analyzeStaffDocumentExpiration).mockResolvedValueOnce({ candidates: [{ date: '2027-02-03', label: 'Expires 02/03/2027 — month/day/year' }, { date: '2027-03-02', label: 'Expires 02/03/2027 — day/month/year' }], incomplete: true });
  renderArea(); await attach(); upload();
  await screen.findByRole('button', { name: 'Use expiration date 2027-02-03' });
  expect(screen.getByRole('button', { name: 'Use expiration date 2027-03-02' })).toBeInTheDocument();
  expect(screen.getByLabelText('Expiration date')).toHaveValue('');
  expect(screen.getByRole('region', { name: 'Expiration date suggestions' })).toHaveTextContent('Only part of the document could be checked.');
});

test('no detected date asks for manual entry while respecting expiration-required documents', async () => {
  renderArea(); await attach(); upload();
  await screen.findByText('No clear expiration date was found. Enter it below.');
  expect(screen.getByRole('checkbox', { name: 'Does not expire' })).toBeDisabled();
  expect(screen.getByLabelText('Expiration date')).toBeEnabled();
});

test('no detected date allows explicit nonexpiring documents when the requirement permits it', async () => {
  requirements[0].expirationRequired = false; renderArea(); await attach(); upload();
  await screen.findByText('No clear expiration date was found. Enter it below, or choose Does not expire if that is correct for this document.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' }));
  expect(screen.getByLabelText('Remind me')).toBeDisabled();
});

test('date detection failure preserves the file and does not prevent a manual save', async () => {
  vi.mocked(analyzeStaffDocumentExpiration).mockRejectedValueOnce(new Error('Unreadable scan'));
  renderArea(); await attach(); upload();
  await screen.findByText('The expiration date could not be read. Enter it below. You can still save the document.');
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save staff document' }));
  await screen.findByText('Staff document saved. Check its dates and mark it reviewed.');
  expect(api.addStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ expiresOn: '2027-01-01' }), expect.objectContaining({ name: 'certificate.png' }), expect.any(String), expect.any(AbortSignal));
});

test('a pending date check does not block a manual save and is aborted after saving', async () => {
  vi.mocked(analyzeStaffDocumentExpiration).mockImplementationOnce(() => new Promise(() => {}));
  renderArea(); await attach(); upload();
  const signal = vi.mocked(analyzeStaffDocumentExpiration).mock.calls[0][2];
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save staff document' }));
  await screen.findByText('Staff document saved. Check its dates and mark it reviewed.');
  expect(signal.aborted).toBe(true);
});

test('replacing a file aborts its date check and ignores late results from the old file', async () => {
  let finish!: (result: Awaited<ReturnType<typeof analyzeStaffDocumentExpiration>>) => void;
  vi.mocked(analyzeStaffDocumentExpiration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  renderArea(); await attach(); upload(png('first.png'));
  const signal = vi.mocked(analyzeStaffDocumentExpiration).mock.calls[0][2];
  upload(png('second.png'));
  await screen.findByText('No clear expiration date was found. Enter it below.');
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ candidates: [{ date: '2027-01-01', label: 'Old private document date' }], incomplete: false }));
  expect(screen.queryByText('Old private document date')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use expiration date 2027-01-01' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Expiration date')).toHaveValue('');
  expect(analyzeStaffDocumentExpiration).toHaveBeenLastCalledWith(employee, expect.objectContaining({ name: 'second.png' }), expect.any(AbortSignal));
});

test.each(['remove', 'cancel', 'session', 'role', 'employee', 'unmount'])('%s stops a pending date check and prevents private suggestions from returning', async action => {
  let finish!: (result: Awaited<ReturnType<typeof analyzeStaffDocumentExpiration>>) => void;
  vi.mocked(analyzeStaffDocumentExpiration).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = renderArea(); await attach(); upload();
  const signal = vi.mocked(analyzeStaffDocumentExpiration).mock.calls[0][2];
  if (action === 'remove') fireEvent.click(screen.getByRole('button', { name: 'Remove selected file' }));
  if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel document changes' }));
  if (action === 'session') await act(async () => { expiry.callbacks.forEach(callback => callback()); });
  if (action === 'role') view.rerender(<SignedIn account={{ ...testAccount, role: 'editor' }}><StaffDocuments staffId={employee} employeeName="Synthetic Teacher" /></SignedIn>);
  if (action === 'employee') view.rerender(<SignedIn><StaffDocuments staffId="other-employee" employeeName="Other Teacher" /></SignedIn>);
  if (action === 'unmount') view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ candidates: [{ date: '2027-01-01', label: 'Private stale expiration date' }], incomplete: false }));
  expect(screen.queryByText('Private stale expiration date')).not.toBeInTheDocument();
});

test('reminder presets, custom days and inherited defaults calculate calendar dates and save the chosen override', async () => {
  renderArea(); await attach(); upload();
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2028-03-01' } });
  expect(screen.getByLabelText('Remind me')).toHaveValue('default');
  fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: '30' } });
  expect(screen.getByLabelText('Reminder days (optional)')).toHaveValue(30);
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('Reminders start 2028-01-31 · 30 days before expiration.');
  fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('Reminder days (optional)'), { target: { value: '45' } });
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('Reminders start 2028-01-16 · 45 days before expiration.');
  fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: 'default' } });
  expect(screen.getByLabelText('Reminder days (optional)')).toHaveValue(null);
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('Reminders start 2028-01-21 · 40 days before expiration.');
  fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save staff document' }));
  await screen.findByText('Staff document saved. Check its dates and mark it reviewed.');
  expect(api.addStaffDocument).toHaveBeenCalledWith(employee, expect.objectContaining({ warningDays: 60 }), expect.anything(), expect.any(String), expect.any(AbortSignal));
});

test('reminder previews use the facility date and clarify when a required document reminder is already due', async () => {
  renderArea(); await attach();
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2026-11-01' } });
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('Reminders start 2026-09-22 · 40 days before expiration. This reminder is already due.');
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('For active staff, renewal reminders appear on Home and Staff after this required document is reviewed.');
});

test('unmapped or optional documents do not promise Home and Staff renewal reminders', async () => {
  renderArea(); await ready(); fireEvent.click(screen.getByRole('button', { name: 'Add staff document' }));
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('Choose a required employee requirement to include this document in renewal reminders on Home and Staff.');
  expect(screen.queryByText('For active staff, renewal reminders appear on Home and Staff after this required document is reviewed.')).not.toBeInTheDocument();
});

test('an existing optional requirement explains its reminder eligibility without asking to change its immutable mapping', async () => {
  requirements[0].required = false; documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; renderArea(); await openDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Edit document details' }));
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('This optional requirement is not included in renewal reminders on Home and Staff.');
  expect(screen.queryByLabelText('Employee requirement (optional)')).not.toBeInTheDocument();
});

test('nonexpiring documents disable expiration reminders without losing their selected override', async () => {
  requirements[0].expirationRequired = false; renderArea(); await attach();
  fireEvent.change(screen.getByLabelText('Remind me'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' }));
  expect(screen.getByLabelText('Remind me')).toBeDisabled();
  expect(screen.getByLabelText('Reminder days (optional)')).toBeDisabled();
  expect(screen.getByRole('region', { name: 'Document reminder' })).toHaveTextContent('No expiration reminder for a document marked Does not expire.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' }));
  expect(screen.getByLabelText('Reminder days (optional)')).toHaveValue(30);
  expect(screen.getByLabelText('Remind me')).toHaveValue('30');
});

test('renewals ask for the new copy expiration and retain a date entered before selecting its file', async () => {
  documents = [structuredClone(initial)]; revisions = [structuredClone(revision)]; renderArea(); await openDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Upload new version' }));
  expect(screen.getByLabelText('Issued date (optional)')).toHaveValue('');
  expect(screen.getByLabelText('Expiration date')).toHaveValue('');
  expect(screen.getByText(/Enter the new copy’s expiration date/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2028-01-01' } });
  upload(png('renewal.png'));
  await screen.findByText('No clear expiration date was found. Enter it below.');
  expect(screen.getByLabelText('Expiration date')).toHaveValue('2028-01-01');
});

test.each(['replace', 'remove'])('%s clears a date accepted from the previous file instead of attaching it to different evidence', async action => {
  vi.mocked(analyzeStaffDocumentExpiration).mockResolvedValueOnce({ candidates: [{ date: '2027-01-01', label: 'File A expires January 1, 2027' }], incomplete: false });
  renderArea(); await attach(); upload(png('file-a.png'));
  fireEvent.click(await screen.findByRole('button', { name: 'Use expiration date 2027-01-01' }));
  expect(screen.getByLabelText('Expiration date')).toHaveValue('2027-01-01');
  if (action === 'replace') {
    upload(png('file-b.png')); await screen.findByText('No clear expiration date was found. Enter it below.');
  } else fireEvent.click(screen.getByRole('button', { name: 'Remove selected file' }));
  expect(screen.getByLabelText('Expiration date')).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Use expiration date 2027-01-01' })).not.toBeInTheDocument();
});

test('a manual date correction remains when replacing a previously analyzed file', async () => {
  vi.mocked(analyzeStaffDocumentExpiration).mockResolvedValueOnce({ candidates: [{ date: '2027-01-01', label: 'File A expiration' }], incomplete: false });
  renderArea(); await attach(); upload(png('file-a.png'));
  fireEvent.click(await screen.findByRole('button', { name: 'Use expiration date 2027-01-01' }));
  fireEvent.change(screen.getByLabelText('Expiration date'), { target: { value: '2027-02-01' } });
  upload(png('file-b.png')); await screen.findByText('No clear expiration date was found. Enter it below.');
  expect(screen.getByLabelText('Expiration date')).toHaveValue('2027-02-01');
});
