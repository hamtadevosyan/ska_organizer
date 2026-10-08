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
beforeEach(() => {
  vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); vi.mocked(axios.put).mockReset();
  vi.mocked(axios.get).mockImplementation(async url => ({ data: { data: String(url).includes('/accounts') ? [testAccount, editor] : [] } }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

test('account creation explicitly starts with no document permission and grants it separately', async () => {
  vi.mocked(axios.post).mockResolvedValue({ data: { data: editor } });
  render(<SignedIn><Accounts /></SignedIn>);
  const documents = await screen.findByLabelText('Child documents', { exact: true });
  await waitFor(() => expect(documents).toBeEnabled());
  expect(documents).toHaveValue('none');
  fireEvent.change(screen.getByLabelText('Username', { exact: true }), { target: { value: 'new-editor' } });
  fireEvent.change(screen.getByLabelText('Display name', { exact: true }), { target: { value: 'New synthetic editor' } });
  fireEvent.change(screen.getByLabelText('Temporary password', { exact: true }), { target: { value: 'Synthetic long password 20!' } });
  fireEvent.change(documents, { target: { value: 'edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/accounts'), expect.objectContaining({ role: 'editor', documentAccess: 'edit' })));
});

test('read-only role restricts document access and administrators retain full access', async () => {
  render(<SignedIn><Accounts /></SignedIn>);
  const documents = await screen.findByLabelText('Child documents', { exact: true });
  await waitFor(() => expect(documents).toBeEnabled());
  fireEvent.change(documents, { target: { value: 'edit' } });
  fireEvent.change(screen.getByLabelText('Access', { exact: true }), { target: { value: 'viewer' } });
  expect(documents).toHaveValue('view');
  expect(documents.querySelector('option[value="edit"]')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Access', { exact: true }), { target: { value: 'admin' } });
  expect(documents).toHaveValue('edit'); expect(documents).toBeDisabled();
});

test('managing an account sends the independent grant and explains session revocation', async () => {
  vi.mocked(axios.put).mockResolvedValue({ data: { data: { ...editor, documentAccess: 'edit' } } });
  render(<SignedIn><Accounts /></SignedIn>);
  await waitFor(() => expect(screen.getByLabelText('Account', { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Account', { exact: true }), { target: { value: editor.id } });
  fireEvent.change(screen.getByLabelText('Account child documents', { exact: true }), { target: { value: 'edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save account' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith(expect.stringContaining(`/accounts/${editor.id}`), expect.objectContaining({ documentAccess: 'edit' })));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('document access or status sign out their existing sessions'));
});
