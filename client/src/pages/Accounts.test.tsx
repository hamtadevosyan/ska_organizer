import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import Accounts from './Accounts';
import { SignedIn } from '../tests/authFixture';
import { testAccount } from '../tests/authAccount';
vi.mock('axios', async original => {
  const real = await original<typeof import('axios')>();
  return { ...real, default: { ...real.default, get: vi.fn(), post: vi.fn(), put: vi.fn() } };
});
const editor = { ...testAccount, id: 'synthetic-editor', username: 'synthetic-editor', displayName: 'Synthetic editor',
  role: 'editor' as const, documentAccess: 'none' as const };
const viewer = { ...editor, id: 'synthetic-viewer', username: 'synthetic-viewer', role: 'viewer' as const, roomId: 'rainbow' };
const activeClass = { id: 'rainbow', name: 'Rainbow class', active: true };
beforeEach(() => {
  vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); vi.mocked(axios.put).mockReset();
  vi.mocked(axios.get).mockImplementation(async url => ({ data: { data: String(url).includes('/accounts') ? [testAccount, editor] : [] } }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('teacher creation has no document grant control and sends no access', async () => {
  vi.mocked(axios.post).mockResolvedValue({ data: { data: editor } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Username', { exact: true })).toBeEnabled());
  expect(screen.queryByLabelText('Child documents', { exact: true })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Username', { exact: true }), { target: { value: 'new-editor' } });
  fireEvent.change(screen.getByLabelText('Display name', { exact: true }), { target: { value: 'New synthetic editor' } });
  fireEvent.change(screen.getByLabelText('Temporary password', { exact: true }), { target: { value: 'Synthetic long password 20!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/accounts'), expect.objectContaining({ role: 'editor', documentAccess: 'none' })));
});

test('documentation policy remains administrator-only for every role selection', async () => {
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Access', { exact: true })).toBeEnabled());
  for (const role of ['viewer', 'admin', 'editor']) {
    fireEvent.change(screen.getByLabelText('Access', { exact: true }), { target: { value: role } });
    expect(screen.queryByLabelText('Child documents', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('Child documents, registration forms and contracts are available only to administrators.')).toBeInTheDocument();
  }
});

test('saving a legacy teacher account clears an old grant and offers no document access control', async () => {
  vi.mocked(axios.get).mockImplementation(async url => ({ data: { data: String(url).includes('/accounts') ? [testAccount, { ...editor, documentAccess: 'edit' }] : [] } }));
  vi.mocked(axios.put).mockResolvedValue({ data: { data: editor } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Account', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Account', { exact: true }), { target: { value: editor.id } });
  expect(screen.queryByLabelText('Account child documents', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining(`/accounts/${editor.id}`), expect.objectContaining({ documentAccess: 'none' })));
});

function classResponses(rooms: unknown[] = [activeClass]) {
  vi.mocked(axios.get).mockImplementation(async url => ({ data: { data: String(url).endsWith('/rooms') ? rooms : String(url).includes('/accounts') ? [testAccount, editor, viewer] : [] } }));
}
test('new class viewers can be explicitly assigned an active class', async () => {
  classResponses(); vi.mocked(axios.post).mockResolvedValue({ data: { data: viewer } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Access', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Access', { exact: true }), { target: { value: 'viewer' } });
  const assignment = screen.getByLabelText('Assigned class', { exact: true });
  await waitFor(() => expect(assignment).toBeEnabled());
  expect(assignment).toHaveValue('');
  expect(screen.getByText('Without an assigned class, this account sees no class information.')).toBeVisible();
  fireEvent.change(assignment, { target: { value: 'rainbow' } });
  fireEvent.change(screen.getByLabelText('Username', { exact: true }), { target: { value: 'new-viewer' } });
  fireEvent.change(screen.getByLabelText('Display name', { exact: true }), { target: { value: 'New viewer' } });
  fireEvent.change(screen.getByLabelText('Temporary password', { exact: true }), { target: { value: 'Synthetic long password 20!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/accounts'), expect.objectContaining({ role: 'viewer', roomId: 'rainbow' })));
});
test('changing away from viewer clears a pending new account assignment', async () => {
  classResponses(); vi.mocked(axios.post).mockResolvedValue({ data: { data: editor } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Access', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Access', { exact: true }), { target: { value: 'viewer' } });
  await waitFor(() => expect(screen.getByLabelText('Assigned class', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Assigned class', { exact: true }), { target: { value: 'rainbow' } });
  fireEvent.change(screen.getByLabelText('Access', { exact: true }), { target: { value: 'editor' } });
  expect(screen.queryByLabelText('Assigned class', { exact: true })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Username', { exact: true }), { target: { value: 'new-editor' } });
  fireEvent.change(screen.getByLabelText('Display name', { exact: true }), { target: { value: 'New editor' } });
  fireEvent.change(screen.getByLabelText('Temporary password', { exact: true }), { target: { value: 'Synthetic long password 20!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/accounts'), expect.objectContaining({ role: 'editor', roomId: null })));
});
test('existing viewer assignment can be removed explicitly with a session warning', async () => {
  classResponses(); vi.mocked(axios.put).mockResolvedValue({ data: { data: { ...viewer, roomId: null } } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Account', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Account', { exact: true }), { target: { value: viewer.id } });
  await waitFor(() => expect(screen.getByLabelText('Account assigned class', { exact: true })).toBeEnabled());
  expect(screen.getByLabelText('Account assigned class', { exact: true })).toHaveValue('rainbow');
  fireEvent.change(screen.getByLabelText('Account assigned class', { exact: true }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('class assignment'));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/accounts/' + viewer.id), expect.objectContaining({ roomId: null })));
});
test('archived or missing assignments are retained without offering other archived classes', async () => {
  classResponses([{ ...activeClass, active: false }, { id: 'old-other', name: 'Other archived', active: false }]);
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Account', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Account', { exact: true }), { target: { value: viewer.id } });
  await screen.findByRole('option', { name: 'Assigned class unavailable' });
  expect(screen.getByLabelText('Account assigned class', { exact: true })).toHaveValue('rainbow');
  expect(screen.queryByRole('option', { name: 'Other archived' })).not.toBeInTheDocument();
});
test('a failed class lookup preserves an existing assignment and can retry', async () => {
  classResponses();
  vi.mocked(axios.get).mockImplementation(async url => {
    if (String(url).endsWith('/rooms')) throw new Error('Synthetic class outage');
    return { data: { data: String(url).includes('/accounts') ? [testAccount, viewer] : [] } };
  });
  vi.mocked(axios.put).mockResolvedValue({ data: { data: viewer } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Account', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Account', { exact: true }), { target: { value: viewer.id } });
  await screen.findByRole('button', { name: 'Retry class list' });
  expect(screen.getByLabelText('Account assigned class', { exact: true })).toHaveValue('rainbow');
  expect(screen.getByLabelText('Account assigned class', { exact: true })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/accounts/' + viewer.id), expect.objectContaining({ roomId: 'rainbow' })));
  classResponses(); fireEvent.click(screen.getByRole('button', { name: 'Retry class list' }));
  await waitFor(() => expect(screen.getByLabelText('Account assigned class', { exact: true })).toBeEnabled());
  expect(screen.getByRole('option', { name: 'Rainbow class' })).toBeVisible();
});
test('role changes on an existing account clear its class assignment', async () => {
  classResponses(); vi.mocked(axios.put).mockResolvedValue({ data: { data: { ...viewer, role: 'editor', roomId: null } } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Account', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Account', { exact: true }), { target: { value: viewer.id } });
  fireEvent.change(screen.getByLabelText('Account access', { exact: true }), { target: { value: 'editor' } });
  expect(screen.queryByLabelText('Account assigned class', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining('/accounts/' + viewer.id), expect.objectContaining({ role: 'editor', roomId: null })));
});
test('non-administrators do not fetch accounts or the class assignment list', () => {
  render(<SignedIn account={viewer}><Accounts /></SignedIn>);
  expect(screen.getByRole('alert')).toHaveTextContent('Administrator access is required.');
  expect(axios.get).not.toHaveBeenCalled();
});
