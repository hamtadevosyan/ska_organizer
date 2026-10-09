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

test('document analysis cancellation reaches only a bundled public font request', async () => {
  const fetch = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(); const factory = new LocalPdfFontFactory(controller.signal);
  const request = factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSymbol.pfb' });
  controller.abort(); await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('FoxitSymbol'), expect.objectContaining({ signal: controller.signal, credentials: 'omit', mode: 'same-origin' }));
});

test('PDF.js factory resource options are ignored instead of being used as a fetch signal or remote URL', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  vi.stubGlobal('fetch', fetch);
  const factory = new LocalPdfFontFactory({ cMapUrl: 'https://external.invalid/maps/',
    standardFontDataUrl: 'https://external.invalid/fonts/', wasmUrl: 'https://external.invalid/wasm/' });
  await expect(factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSymbol.pfb' })).resolves.toEqual(new Uint8Array([1, 2, 3]));
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('FoxitSymbol'), {
    mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  expect(new URL(fetch.mock.calls[0][0], window.location.href).origin).toBe(window.location.origin);
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('signal');
});
