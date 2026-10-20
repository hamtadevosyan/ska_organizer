import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import axios from 'axios';
import { StaffAccountAccess } from './StaffAccountAccess';
vi.mock('axios', async original => { const real = await original<typeof import('axios')>(); return { ...real, default: { ...real.default, get: vi.fn() } }; });
test('staff details identify the linked role and login status', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { data: [{ id: 'employee', account: { username: 'teacher-login', role: 'teacher', disabled: false } }] } });
  render(<StaffAccountAccess staffId="employee" />);
  expect(await screen.findByText('teacher-login · Teacher · Enabled', { exact: true })).toBeVisible();
  expect(screen.getByRole('link')).toHaveAttribute('href', '/accounts');
});
test('a failed account lookup does not claim that the employee has no account', async () => {
  vi.mocked(axios.get).mockRejectedValue(new Error('Synthetic outage'));
  render(<StaffAccountAccess staffId="employee" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the linked account');
  expect(screen.queryByText('No sign-in account is linked to this staff member.')).not.toBeInTheDocument();
});
