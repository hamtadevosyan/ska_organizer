import { act, fireEvent, render as renderComponent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import RegistrationForms from './RegistrationForms';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
import { UnsavedChangesContext } from '../components/UnsavedChangesContext';
import * as api from '../api/registrationForms';
import * as documents from '../api/childDocuments';
import type { RegistrationForm } from '../api/registrationForms';
import type { DocumentRevision } from '../api/childDocuments';

const sessionExpired = vi.hoisted(() => new Set<() => void>());
vi.mock('../auth/transport', () => ({ authError: (_error: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { sessionExpired.add(callback); return () => sessionExpired.delete(callback); } }));
vi.mock('../components/registration/BlankFormActions', () => ({ BlankFormActions: ({ form, revision, disabled }: { form: RegistrationForm; revision: DocumentRevision; disabled: boolean }) => <button type="button" disabled={disabled} aria-label={'Blank file actions for version ' + revision.revision} data-form-id={form.id}>Preview, download and print blank file</button> }));
vi.mock('../api/registrationForms', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/registrationForms')>();
  return { ...actual, listRegistrationForms: vi.fn(), getRegistrationForm: vi.fn(), addRegistrationForm: vi.fn(), updateRegistrationForm: vi.fn(), reviseRegistrationForm: vi.fn() };
});
vi.mock('../api/childDocuments', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/childDocuments')>();
  return { ...actual, readDocumentFile: vi.fn() };
});
const template: RegistrationForm = { id: 'form-1', title: 'Blank consent', instructions: 'Complete and return the consent form.', category: 'consent', required: true, active: true, version: 2, currentRevisionId: 'revision-2', templateRevision: 2, updatedAt: '2026-10-01T10:00:00Z' };
const revision: DocumentRevision = { id: 'revision-2', revision: 2, filename: 'blank-consent.pdf', contentType: 'application/pdf', byteLength: 21, sha256: 'synthetic', uploadedAt: '2026-10-01T10:00:00Z', uploadedBy: 'test-admin', changeNote: 'Updated instructions', current: true };
const oldRevision: DocumentRevision = { ...revision, id: 'revision-1', revision: 1, filename: 'original-blank-consent.pdf', changeNote: null, current: false };
function render(ui: ReactElement, initialEntries = ['/registration-forms']) {
  return renderComponent(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks(); sessionExpired.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api.listRegistrationForms).mockResolvedValue({ items: [template] });
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form: template, revisions: [revision, oldRevision], total: 2 });
  vi.mocked(api.addRegistrationForm).mockResolvedValue({ form: template, revision });
  vi.mocked(api.updateRegistrationForm).mockResolvedValue({ form: { ...template, version: 3 } });
  vi.mocked(api.reviseRegistrationForm).mockResolvedValue({ form: { ...template, version: 3 }, revision: { ...revision, id: 'revision-3', revision: 3 } });
  vi.mocked(documents.readDocumentFile).mockImplementation(async file => ({ name: file.name, contentType: file.type, dataBase64: 'c3ludGhldGlj' }));
});
async function selectTemplate() {
  fireEvent.click(await screen.findByRole('button', { name: /Blank consent.*Consent form.*Active/ }));
  await screen.findByRole('region', { name: 'Selected registration template' });
}
function upload(file = new File(['%PDF-1.7 synthetic'], 'new-blank.pdf', { type: 'application/pdf' })) { fireEvent.change(screen.getByLabelText(/Upload a blank form/), { target: { files: [file] } }); }
function newForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Add blank form' }));
  fireEvent.change(screen.getByLabelText('Form title'), { target: { value: 'New blank contract' } });
}

test('only an active administrator can fetch and manage templates', () => {
  for (const account of [{ ...testAccount, role: 'editor' as const }, { ...testAccount, disabled: true }, { ...testAccount, mustChangePassword: true }]) {
    const result = render(<SignedIn account={account}><RegistrationForms /></SignedIn>);
    expect(screen.getByRole('alert')).toHaveTextContent('Administrator access is required');
    expect(api.listRegistrationForms).not.toHaveBeenCalled();
    result.unmount();
  }
});

test('manager explains blank templates and separates current and earlier blank versions', async () => {
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  expect(screen.getByText(/Upload blank forms only/)).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Current blank template version' })).getByText('blank-consent.pdf')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Earlier blank template versions' })).getByText('original-blank-consent.pdf')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Blank file actions for version 1' })).toHaveAttribute('data-form-id', template.id);
  expect(screen.getByRole('button', { name: 'Blank file actions for version 2' })).toBeEnabled();
});

test('blank version history reaches versions beyond twenty and resets when selecting a template', async () => {
  const latest = { ...template, templateRevision: 21, currentRevisionId: 'revision-21' };
  const versions = Array.from({ length: 21 }, (_, index) => ({ ...revision, id: 'revision-' + (21 - index), revision: 21 - index, current: index === 0, filename: 'blank-version-' + (21 - index) + '.pdf' }));
  vi.mocked(api.listRegistrationForms).mockResolvedValue({ items: [latest] });
  vi.mocked(api.getRegistrationForm).mockImplementation(async (_id, _signal, page = 1) => ({ form: latest, revisions: versions.slice((page - 1) * 10, page * 10), total: 21 }));
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  expect(api.getRegistrationForm).toHaveBeenLastCalledWith(latest.id, expect.any(AbortSignal), 1);
  expect(screen.getByText('Page 1 of 3 · 21 blank versions')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous blank versions' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Next blank versions' }));
  await screen.findByText('Page 2 of 3 · 21 blank versions');
  expect(api.getRegistrationForm).toHaveBeenLastCalledWith(latest.id, expect.any(AbortSignal), 2);
  expect(screen.getByText('blank-version-11.pdf')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next blank versions' }));
  await screen.findByText('Page 3 of 3 · 21 blank versions');
  expect(api.getRegistrationForm).toHaveBeenLastCalledWith(latest.id, expect.any(AbortSignal), 3);
  expect(screen.getByText('blank-version-1.pdf')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next blank versions' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous blank versions' }));
  await screen.findByText('Page 2 of 3 · 21 blank versions');
  fireEvent.click(screen.getByRole('button', { name: /Blank consent.*Consent form.*Active/ }));
  await screen.findByText('Page 1 of 3 · 21 blank versions');
  expect(screen.getByText('blank-version-21.pdf')).toBeInTheDocument();
});

test('a failed new template upload preserves metadata, file and request ID for retry', async () => {
  vi.mocked(api.addRegistrationForm).mockRejectedValueOnce(new Error('Disconnected'));
  const report = vi.fn();
  render(<SignedIn><UnsavedChangesContext.Provider value={report}><RegistrationForms /></UnsavedChangesContext.Provider></SignedIn>);
  newForm();
  fireEvent.change(screen.getByLabelText('Document category'), { target: { value: 'contract' } });
  fireEvent.change(screen.getByLabelText('Instructions (optional)'), { target: { value: 'Return this blank contract after completion.' } });
  fireEvent.click(screen.getByLabelText('Required for this group')); upload();
  fireEvent.click(screen.getByRole('button', { name: 'Save blank form' }));
  await screen.findByText(/Your draft and file are still here/);
  expect(screen.getByLabelText('Form title')).toHaveValue('New blank contract');
  expect(screen.getByText('Selected blank file: new-blank.pdf')).toBeInTheDocument();
  const requestId = vi.mocked(api.addRegistrationForm).mock.calls[0][2]; expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  fireEvent.click(screen.getByRole('button', { name: 'Save blank form' }));
  await screen.findByText('Blank form template added.');
  expect(api.addRegistrationForm).toHaveBeenLastCalledWith({ title: 'New blank contract', instructions: 'Return this blank contract after completion.', category: 'contract', audience: 'child', required: true, expirationRequired: false }, expect.objectContaining({ name: 'new-blank.pdf' }), requestId, expect.any(AbortSignal));
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false));
});

test('invalid blank files never start a read or upload', () => {
  render(<SignedIn><RegistrationForms /></SignedIn>); newForm();
  upload(new File(['script'], 'blank.html', { type: 'text/html' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF, JPG or PNG file.');
  upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' }));
  expect(screen.getByRole('alert')).toHaveTextContent('5 MB or less');
  upload(new File([], 'empty.pdf', { type: 'application/pdf' }));
  expect(screen.getByRole('alert')).toHaveTextContent('not empty');
  expect(documents.readDocumentFile).not.toHaveBeenCalled(); expect(api.addRegistrationForm).not.toHaveBeenCalled();
});

test('metadata edits preserve the file history and use the saved optimistic version', async () => {
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  fireEvent.click(screen.getByRole('button', { name: 'Edit template details' }));
  fireEvent.change(screen.getByLabelText('Form title'), { target: { value: 'Updated blank consent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save template details' }));
  await screen.findByText('Template details saved.');
  expect(api.updateRegistrationForm).toHaveBeenCalledWith(template, { title: 'Updated blank consent', audience: 'child', category: 'consent', instructions: template.instructions, required: true, expirationRequired: false, active: true }, expect.any(AbortSignal));
  expect(documents.readDocumentFile).not.toHaveBeenCalled(); expect(api.reviseRegistrationForm).not.toHaveBeenCalled();
});

test('replacement conflicts retain the file and note while latest loading preserves the draft', async () => {
  const conflict = Object.assign(new Error('Stale'), { isAxiosError: true, response: { status: 409 } });
  vi.mocked(api.reviseRegistrationForm).mockRejectedValueOnce(conflict);
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  fireEvent.click(screen.getByRole('button', { name: 'Upload new blank version' })); upload();
  fireEvent.change(screen.getByLabelText('Change note (optional)'), { target: { value: 'Replace the outdated consent wording' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save new blank version' }));
  await screen.findByText(/This template changed since you opened it/);
  expect(screen.getByLabelText('Change note (optional)')).toHaveValue('Replace the outdated consent wording');
  expect(screen.getByText('Current blank template')).toBeInTheDocument();
  const latest = { ...template, version: 5, templateRevision: 3, currentRevisionId: 'revision-3' };
  vi.mocked(api.getRegistrationForm).mockResolvedValueOnce({ form: latest, revisions: [{ ...revision, id: 'revision-3', revision: 3 }, oldRevision], total: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Load latest template and keep draft' }));
  await screen.findByText(/Latest template loaded/);
  expect(screen.getByText('Selected blank file: new-blank.pdf')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save new blank version' }));
  await screen.findByText('New blank form version saved. Earlier versions are kept.');
  expect(api.reviseRegistrationForm).toHaveBeenLastCalledWith(latest, expect.objectContaining({ name: 'new-blank.pdf' }), 'Replace the outdated consent wording', expect.any(String), expect.any(AbortSignal));
});

test('loading the latest metadata after a conflict keeps administrator edits for review', async () => {
  vi.mocked(api.updateRegistrationForm).mockRejectedValueOnce(Object.assign(new Error('Stale'), { isAxiosError: true, response: { status: 409 } }));
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  fireEvent.click(screen.getByRole('button', { name: 'Edit template details' }));
  fireEvent.change(screen.getByLabelText('Form title'), { target: { value: 'My revised consent title' } });
  fireEvent.change(screen.getByLabelText('Instructions (optional)'), { target: { value: 'My draft instructions' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save template details' }));
  await screen.findByText(/This template changed since you opened it/);
  const latest = { ...template, title: 'Another administrator title', instructions: 'Another administrator instructions', version: 8 };
  vi.mocked(api.getRegistrationForm).mockResolvedValueOnce({ form: latest, revisions: [revision, oldRevision], total: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Load latest template and keep draft' }));
  await screen.findByText(/Latest template loaded/);
  expect(screen.getByLabelText('Form title')).toHaveValue('My revised consent title');
  expect(screen.getByLabelText('Instructions (optional)')).toHaveValue('My draft instructions');
  fireEvent.click(screen.getByRole('button', { name: 'Save template details' }));
  await screen.findByText('Template details saved.');
  expect(api.updateRegistrationForm).toHaveBeenLastCalledWith(latest, expect.objectContaining({ title: 'My revised consent title', instructions: 'My draft instructions' }), expect.any(AbortSignal));
});

test('archive and restore update status without deleting any blank file version', async () => {
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form: { ...template, active: false, version: 3 }, revisions: [revision, oldRevision], total: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));
  await screen.findByText('Template archived. Earlier versions and submitted documents are kept.');
  expect(api.updateRegistrationForm).toHaveBeenCalledWith(template, expect.objectContaining({ active: false }), expect.any(AbortSignal));
  expect(screen.getByRole('button', { name: 'Blank file actions for version 1' })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Restore template' }));
  await screen.findByText('Template restored to the active registration forms.');
  expect(api.updateRegistrationForm).toHaveBeenLastCalledWith(expect.objectContaining({ active: false, version: 3 }), expect.objectContaining({ active: true }), expect.any(AbortSignal));
});

test('cancel, refresh and archived filtering ask before discarding a changed draft', async () => {
  render(<SignedIn><RegistrationForms /></SignedIn>);
  await screen.findByRole('button', { name: /Blank consent.*Consent form.*Active/ }); newForm();
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel template changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh templates' }));
  fireEvent.click(screen.getByLabelText('Include archived templates'));
  expect(screen.getByLabelText('Form title')).toHaveValue('New blank contract');
  expect(screen.getByLabelText('Include archived templates')).not.toBeChecked();
  expect(api.listRegistrationForms).toHaveBeenCalledTimes(1);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByLabelText('Include archived templates'));
  await waitFor(() => expect(api.listRegistrationForms).toHaveBeenLastCalledWith(true, expect.any(AbortSignal)));
  expect(screen.queryByRole('form', { name: 'Add blank form template' })).not.toBeInTheDocument();
});

test('beforeunload and shared navigation guard cover a draft and clear on cancel', async () => {
  const report = vi.fn();
  render(<SignedIn><UnsavedChangesContext.Provider value={report}><RegistrationForms /></UnsavedChangesContext.Provider></SignedIn>); newForm();
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(true, false));
  const dirtyUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirtyUnload); expect(dirtyUnload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel template changes' }));
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false));
  const cleanUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(cleanUnload); expect(cleanUnload.defaultPrevented).toBe(false);
});

test('session expiry aborts in-flight uploads, clears drafts and ignores late results', async () => {
  let finish: (value: Awaited<ReturnType<typeof api.addRegistrationForm>>) => void = () => {};
  vi.mocked(api.addRegistrationForm).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const report = vi.fn();
  render(<SignedIn><UnsavedChangesContext.Provider value={report}><RegistrationForms /></UnsavedChangesContext.Provider></SignedIn>); newForm(); upload();
  fireEvent.click(screen.getByRole('button', { name: 'Save blank form' }));
  await waitFor(() => expect(api.addRegistrationForm).toHaveBeenCalled());
  const signal = vi.mocked(api.addRegistrationForm).mock.calls[0][3];
  act(() => { for (const callback of sessionExpired) callback(); });
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(screen.queryByRole('heading', { name: 'Registration forms' })).not.toBeInTheDocument();
  await act(async () => { finish({ form: template, revision }); });
  expect(screen.queryByText('Blank form template added.')).not.toBeInTheDocument();
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false));
});

test('unmount aborts a late list response without displaying its templates', async () => {
  let finish: (value: { items: RegistrationForm[] }) => void = () => {};
  vi.mocked(api.listRegistrationForms).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = render(<SignedIn><RegistrationForms /></SignedIn>);
  const signal = vi.mocked(api.listRegistrationForms).mock.calls[0][1]; result.unmount();
  await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => { finish({ items: [template] }); });
  expect(screen.queryByText('Blank consent')).not.toBeInTheDocument();
});


test('new employee templates preserve their group and catalog filters separate facility templates', async () => {
  vi.mocked(api.listRegistrationForms).mockResolvedValue({ items: [template,
    { ...template, id: 'employee-form', title: 'Employee onboarding', audience: 'employee' },
    { ...template, id: 'facility-form', title: 'Facility emergency plan', audience: 'facility' }] });
  render(<SignedIn><RegistrationForms /></SignedIn>);
  await screen.findByRole('button', { name: /Employee onboarding/ });
  fireEvent.change(screen.getByLabelText('Filter templates'), { target: { value: 'facility' } });
  expect(screen.getByRole('button', { name: /Facility emergency plan/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /Employee onboarding/ })).not.toBeInTheDocument();
  newForm();
  fireEvent.change(screen.getByLabelText(/Template for/), { target: { value: 'employee' } });
  upload(); fireEvent.click(screen.getByRole('button', { name: 'Save employee requirement' }));
  await waitFor(() => expect(api.addRegistrationForm).toHaveBeenCalledWith(expect.objectContaining({ audience: 'employee' }), expect.anything(), expect.any(String), expect.any(AbortSignal)));
});

test('employee training requirements save without blank files and retain their request ID on retry', async () => {
  const requirement: RegistrationForm = { ...template, id: 'employee-cpr', audience: 'employee', title: 'CPR training', currentRevisionId: null, templateRevision: 0, expirationRequired: true };
  vi.mocked(api.addRegistrationForm).mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce({ form: requirement, revision: null });
  render(<SignedIn><RegistrationForms /></SignedIn>); newForm();
  fireEvent.change(screen.getByLabelText('Form title'), { target: { value: requirement.title } });
  fireEvent.change(screen.getByLabelText(/Template for/), { target: { value: 'employee' } });
  expect(screen.getByText(/A blank file is optional/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Expiration date required'));
  fireEvent.click(screen.getByLabelText('Required for every active employee'));
  fireEvent.click(screen.getByRole('button', { name: 'Save employee requirement' }));
  await screen.findByText(/Your draft and file are still here/);
  const requestId = vi.mocked(api.addRegistrationForm).mock.calls[0][2];
  expect(api.addRegistrationForm).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'CPR training', audience: 'employee', expirationRequired: true, required: true }), undefined, requestId, expect.any(AbortSignal));
  expect(documents.readDocumentFile).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Expiration date required')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save employee requirement' }));
  await screen.findByText('Employee requirement added.');
  expect(api.addRegistrationForm).toHaveBeenLastCalledWith(expect.objectContaining({ audience: 'employee', expirationRequired: true }), undefined, requestId, expect.any(AbortSignal));
});

test('switching away from employee clears the expiration flag and child templates require a blank file', async () => {
  render(<SignedIn><RegistrationForms /></SignedIn>); newForm();
  fireEvent.change(screen.getByLabelText(/Template for/), { target: { value: 'employee' } });
  fireEvent.click(screen.getByLabelText('Expiration date required'));
  fireEvent.change(screen.getByLabelText(/Template for/), { target: { value: 'child' } });
  expect(screen.queryByLabelText('Expiration date required')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save blank form' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF, JPG or PNG blank form first.');
  expect(api.addRegistrationForm).not.toHaveBeenCalled();
  upload(); fireEvent.click(screen.getByRole('button', { name: 'Save blank form' }));
  await screen.findByText('Blank form template added.');
  expect(api.addRegistrationForm).toHaveBeenCalledWith(expect.objectContaining({ audience: 'child', expirationRequired: false }), expect.anything(), expect.any(String), expect.any(AbortSignal));
});

test('metadata-only requirements show no blank file actions and can acquire a first version', async () => {
  const requirement: RegistrationForm = { ...template, id: 'employee-cpr', audience: 'employee', title: 'CPR training', currentRevisionId: null, templateRevision: 0, expirationRequired: true };
  vi.mocked(api.listRegistrationForms).mockResolvedValue({ items: [requirement] });
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form: requirement, revisions: [], total: 0 });
  render(<SignedIn><RegistrationForms /></SignedIn>);
  fireEvent.click(await screen.findByRole('button', { name: /CPR training.*No blank file.*Expiration date required/ }));
  await screen.findByText('This employee requirement has no blank file. Upload a blank version if one becomes available.');
  expect(screen.queryByRole('button', { name: /Blank file actions/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Current blank template version' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Upload new blank version' })); upload();
  fireEvent.click(screen.getByRole('button', { name: 'Save new blank version' }));
  await screen.findByText('New blank form version saved. Earlier versions are kept.');
  expect(api.reviseRegistrationForm).toHaveBeenCalledWith(requirement, expect.objectContaining({ name: 'new-blank.pdf' }), '', expect.any(String), expect.any(AbortSignal));
});

test('editing an employee requirement retains its expiration policy and removes an optional selected blank file', async () => {
  const requirement: RegistrationForm = { ...template, audience: 'employee', expirationRequired: true };
  vi.mocked(api.listRegistrationForms).mockResolvedValue({ items: [requirement] });
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form: requirement, revisions: [revision, oldRevision], total: 2 });
  render(<SignedIn><RegistrationForms /></SignedIn>); await selectTemplate();
  fireEvent.click(screen.getByRole('button', { name: 'Edit template details' }));
  expect(screen.getByLabelText('Expiration date required')).toBeChecked();
  fireEvent.change(screen.getByLabelText('Instructions (optional)'), { target: { value: 'Renew CPR before expiration.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save template details' }));
  await screen.findByText('Template details saved.');
  expect(api.updateRegistrationForm).toHaveBeenCalledWith(requirement, expect.objectContaining({ expirationRequired: true }), expect.any(AbortSignal));
  newForm(); fireEvent.change(screen.getByLabelText(/Template for/), { target: { value: 'employee' } }); upload();
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected blank file' }));
  expect(screen.queryByText('Selected blank file: new-blank.pdf')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save employee requirement' }));
  await screen.findByText('Employee requirement added.');
  expect(api.addRegistrationForm).toHaveBeenCalledWith(expect.objectContaining({ audience: 'employee', expirationRequired: false }), undefined, expect.any(String), expect.any(AbortSignal));
});

test('the employee shortcut requires only a name and defaults to required without a file', async () => {
  const requirement: RegistrationForm = { ...template, id: 'employee-cpr', audience: 'employee', title: 'CPR certification', currentRevisionId: null, templateRevision: 0 };
  vi.mocked(api.addRegistrationForm).mockResolvedValue({ form: requirement, revision: null });
  vi.mocked(api.getRegistrationForm).mockResolvedValue({ form: requirement, revisions: [], total: 0 });
  render(<SignedIn><RegistrationForms /></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Add employee requirement' }));
  const form = screen.getByRole('form', { name: 'Add employee requirement' });
  expect(within(form).getByLabelText(/Template for/)).toHaveValue('employee');
  expect(within(form).getByLabelText('Required for every active employee')).toBeChecked();
  expect(within(form).getByLabelText('Upload a blank form (optional)')).not.toBeRequired();
  expect(within(form).getByText(/No blank template is needed/)).toBeInTheDocument();
  fireEvent.change(within(form).getByLabelText('Certificate or document name'), { target: { value: ' CPR certification ' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save employee requirement' }));
  await screen.findByText('Employee requirement added.');
  expect(api.addRegistrationForm).toHaveBeenCalledWith({ title: 'CPR certification', instructions: '', category: 'other', audience: 'employee', required: true, expirationRequired: false }, undefined, expect.any(String), expect.any(AbortSignal));
  expect(documents.readDocumentFile).not.toHaveBeenCalled();
  expect(screen.queryByRole('form', { name: 'Add employee requirement' })).not.toBeInTheDocument();
  await screen.findByText('This employee requirement has no blank file. Upload a blank version if one becomes available.');
});

test('the staff shortcut opens the required employee draft once and its presets are not unsaved changes', async () => {
  const report = vi.fn();
  render(<SignedIn><UnsavedChangesContext.Provider value={report}><RegistrationForms /></UnsavedChangesContext.Provider></SignedIn>, ['/registration-forms?employee-requirement=new']);
  expect(screen.getByRole('form', { name: 'Add employee requirement' })).toBeInTheDocument();
  expect(screen.getByLabelText(/Template for/)).toHaveValue('employee');
  expect(screen.getByLabelText('Required for every active employee')).toBeChecked();
  expect(screen.getByLabelText('Filter templates')).toHaveValue('employee');
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel template changes' }));
  expect(window.confirm).not.toHaveBeenCalled();
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh templates' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Refresh templates' }));
  await waitFor(() => expect(api.listRegistrationForms).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('form')).not.toBeInTheDocument();
});

test('switching from a changed employee draft to a blank form respects discard confirmation', async () => {
  const report = vi.fn();
  render(<SignedIn><UnsavedChangesContext.Provider value={report}><RegistrationForms /></UnsavedChangesContext.Provider></SignedIn>);
  fireEvent.click(screen.getByRole('button', { name: 'Add employee requirement' }));
  fireEvent.change(screen.getByLabelText('Certificate or document name'), { target: { value: 'CPR certification' } });
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(true, false));
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Add blank form' }));
  expect(screen.getByLabelText('Certificate or document name')).toHaveValue('CPR certification');
  expect(api.addRegistrationForm).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add blank form' }));
  expect(screen.getByLabelText('Form title')).toHaveValue('');
  expect(screen.getByLabelText(/Template for/)).toHaveValue('child');
  expect(screen.getByLabelText('Required for this group')).not.toBeChecked();
  await waitFor(() => expect(report).toHaveBeenLastCalledWith(false, false));
});
