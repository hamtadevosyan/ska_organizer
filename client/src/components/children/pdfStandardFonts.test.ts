import { afterEach, expect, test, vi } from 'vitest';
import { LocalPdfFontFactory } from './pdfStandardFonts';

afterEach(() => vi.unstubAllGlobals());

test('standard PDF fonts use only bundled public files, without credentials, and repeated reads are bounded', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  vi.stubGlobal('fetch', fetch);
  const factory = new LocalPdfFontFactory();
  const first = await factory.fetch({ kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' });
  expect(first).toEqual(new Uint8Array([1, 2, 3]));
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('LiberationSans-Regular'), { mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(new URL(fetch.mock.calls[0][0], window.location.href).origin).toBe(window.location.origin);
  await factory.fetch({ kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' });
  expect(fetch).toHaveBeenCalledTimes(1);
  await factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSymbol.pfb' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('unrecognized font paths, remote references and other resource kinds are refused before fetching', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const factory = new LocalPdfFontFactory();
  for (const request of [{ kind: 'standardFontDataUrl', filename: '../../api/children' }, { kind: 'standardFontDataUrl', filename: 'https://external.invalid/font.ttf' }, { kind: 'standardFontDataUrl', filename: 'constructor' }, { kind: 'wasmUrl', filename: 'LiberationSans-Regular.ttf' }, { kind: 'cMapUrl', filename: 'LiberationSans-Regular.ttf' }]) {
    await expect(factory.fetch(request)).rejects.toThrow('Unsupported PDF font resource.');
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('font loading errors and oversized data cannot become an unbounded resource', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array(256 * 1024 + 1).buffer });
  vi.stubGlobal('fetch', fetch);
  const factory = new LocalPdfFontFactory();
  await expect(factory.fetch({ kind: 'standardFontDataUrl', filename: 'LiberationSans-Regular.ttf' })).rejects.toThrow('PDF font is unavailable.');
  await expect(factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSymbol.pfb' })).rejects.toThrow('Invalid PDF font resource.');
});
