import axios from 'axios';
import { beforeEach, expect, test, vi } from 'vitest';
import { API_BASE_URL } from '../lib/api';
import { BILLING_CHANGED } from './billing';
import { cancelCcrcStatement, getCcrcStatement, getCcrcStatementContent, listCcrcStatements, postCcrcStatement, reopenCcrcStatement, saveCcrcReview, uploadCcrcStatement } from './ccrcStatements';
import { ccrcStatementFixture } from '../tests/ccrcStatementFixture';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const base = API_BASE_URL + '/api/billing/statements';
test('list and detail use the private statement API with abort signals and encoded identifiers', async () => {
  const list = { items: [], total: 0, today: '2026-11-20', timeZone: 'America/Los_Angeles' }, value = ccrcStatementFixture(), signal = new AbortController().signal;
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: list } }).mockResolvedValueOnce({ data: { data: value } });
  expect(await listCcrcStatements(signal)).toEqual(list); expect(axios.get).toHaveBeenCalledWith(base, { signal });
  expect(await getCcrcStatement('source/a', signal)).toEqual(value); expect(axios.get).toHaveBeenLastCalledWith(base + '/source%2Fa', { signal });
});
test('upload preserves original bytes and its request identity', async () => {
  const value = ccrcStatementFixture(), signal = new AbortController().signal, file = { name: 'statement.pdf', contentType: 'application/pdf', dataBase64: 'c3ludGhldGlj' };
  vi.mocked(axios.post).mockResolvedValue({ data: { data: value } });
  expect(await uploadCcrcStatement(file, 'request-id', signal)).toEqual(value);
  expect(axios.post).toHaveBeenCalledWith(base, { file, requestId: 'request-id' }, { signal });
});
test.each([['review', saveCcrcReview, 'put'], ['post', postCcrcStatement, 'post'], ['cancel', cancelCcrcStatement, 'post'], ['reopen', reopenCcrcStatement, 'post']] as const)('%s preserves version/body and aborts through the private API', async (suffix, method, verb) => {
  const value = ccrcStatementFixture(), signal = new AbortController().signal, body = { version: 3, requestId: 'one-request', review: value.review };
  vi.mocked(axios[verb]).mockResolvedValue({ data: { data: value } });
  expect(await method('source/a', body, signal)).toEqual(value); expect(axios[verb]).toHaveBeenCalledWith(base + '/source%2Fa/' + suffix, body, { signal });
});
test('only successful posting announces a ledger change', async () => {
  const changed = vi.fn(); window.addEventListener(BILLING_CHANGED, changed);
  try {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('Disconnected'));
    await expect(postCcrcStatement('source/a', {})).rejects.toThrow('Disconnected'); expect(changed).not.toHaveBeenCalled();
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { data: ccrcStatementFixture() } });
    await postCcrcStatement('source/a', {}); expect(changed).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(BILLING_CHANGED, changed); }
});
test('private originals are fetched as bytes and never as a public URL', async () => {
  const blob = new Blob(['synthetic'], { type: 'application/pdf' }), signal = new AbortController().signal;
  vi.mocked(axios.get).mockResolvedValue({ data: blob });
  expect(await getCcrcStatementContent('source/a', signal)).toBe(blob);
  expect(axios.get).toHaveBeenCalledWith(base + '/source%2Fa/content', { responseType: 'blob', signal });
});
