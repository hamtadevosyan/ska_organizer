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
