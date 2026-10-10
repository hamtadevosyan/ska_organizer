import axios from 'axios';
import { beforeEach, expect, test, vi } from 'vitest';
import { readStaffDocumentImage } from './staffDocumentOcr';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

test('OCR sends only a prepared image to the authenticated staff endpoint with cancellation and timeout', async () => {
  vi.mocked(axios.post).mockResolvedValue({ data: { text: 'Expires March 15, 2027' } });
  const signal = new AbortController().signal;
  expect(await readStaffDocumentImage('staff/a', 'cG5n', signal)).toBe('Expires March 15, 2027');
  expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/staff/staff%2Fa/documents/expiration-check'), { image: 'cG5n' }, { signal, timeout: 32000 });
});

test('invalid or oversized OCR responses become a safe manual-entry failure', async () => {
  for (const text of [undefined, 1, 'x'.repeat(80001)]) {
    vi.mocked(axios.post).mockResolvedValue({ data: { text } });
    await expect(readStaffDocumentImage('staff', 'cG5n', new AbortController().signal)).rejects.toThrow('Document text is unavailable.');
  }
});
