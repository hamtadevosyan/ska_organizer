import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import axios from 'axios';
import { EnrollmentProgress } from './EnrollmentProgress';
const expired = vi.hoisted(() => new Set<() => void>());
vi.mock('axios', () => ({ default: { get: vi.fn(), isCancel: () => false } }));
vi.mock('../../auth/transport', () => ({ authError: (_: unknown, fallback: string) => fallback, onSessionExpired: (callback: () => void) => { expired.add(callback); return () => expired.delete(callback); } }));
beforeEach(() => { vi.clearAllMocks(); expired.clear(); });
test('coarse progress warns about unfinished enrollment without document details', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { percentage: 75, complete: false } });
  render(<EnrollmentProgress childId="synthetic-child" />);
  expect(await screen.findByText(/Enrollment 75%/)).toHaveTextContent('administrator needs to finish');
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(vi.mocked(axios.get).mock.calls[0][0]).toMatch(/enrollment-progress$/);
  expect(screen.queryByText(/medical|contract|insurance/i)).not.toBeInTheDocument();
});
test('complete enrollment shows 100 percent and logout clears the status', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { percentage: 100, complete: true } });
  render(<EnrollmentProgress childId="synthetic-child" />);
  await screen.findByText('Enrollment 100% · Complete');
  act(() => { for (const callback of expired) callback(); });
  await waitFor(() => expect(screen.queryByText(/Enrollment 100%/)).not.toBeInTheDocument());
});
