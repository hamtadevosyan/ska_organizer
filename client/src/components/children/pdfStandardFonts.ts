import dingbats from 'pdfjs-dist/standard_fonts/FoxitDingbats.pfb?url';
import fixed from 'pdfjs-dist/standard_fonts/FoxitFixed.pfb?url';
import fixedBold from 'pdfjs-dist/standard_fonts/FoxitFixedBold.pfb?url';
import fixedBoldItalic from 'pdfjs-dist/standard_fonts/FoxitFixedBoldItalic.pfb?url';
import fixedItalic from 'pdfjs-dist/standard_fonts/FoxitFixedItalic.pfb?url';
import serif from 'pdfjs-dist/standard_fonts/FoxitSerif.pfb?url';
import serifBold from 'pdfjs-dist/standard_fonts/FoxitSerifBold.pfb?url';
import serifBoldItalic from 'pdfjs-dist/standard_fonts/FoxitSerifBoldItalic.pfb?url';
import serifItalic from 'pdfjs-dist/standard_fonts/FoxitSerifItalic.pfb?url';
import symbol from 'pdfjs-dist/standard_fonts/FoxitSymbol.pfb?url';
import sansBold from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import sansBoldItalic from 'pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf?url';
import sansItalic from 'pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf?url';
import sansRegular from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';

const fonts = new Map([
  ['FoxitDingbats.pfb', dingbats], ['FoxitFixed.pfb', fixed], ['FoxitFixedBold.pfb', fixedBold],
  ['FoxitFixedBoldItalic.pfb', fixedBoldItalic], ['FoxitFixedItalic.pfb', fixedItalic],
  ['FoxitSerif.pfb', serif], ['FoxitSerifBold.pfb', serifBold], ['FoxitSerifBoldItalic.pfb', serifBoldItalic],
  ['FoxitSerifItalic.pfb', serifItalic], ['FoxitSymbol.pfb', symbol],
  ['LiberationSans-Bold.ttf', sansBold], ['LiberationSans-BoldItalic.ttf', sansBoldItalic],
  ['LiberationSans-Italic.ttf', sansItalic], ['LiberationSans-Regular.ttf', sansRegular],
]);

// PDF files can request only these bundled public fonts. No document-supplied
// path, remote resource or authenticated endpoint reaches fetch.
export class LocalPdfFontFactory {
  private cache = new Map<string, Promise<Uint8Array>>();
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = kind === 'standardFontDataUrl' && fonts.get(filename);
    if (!url || new URL(url, window.location.href).origin !== window.location.origin) throw new Error('Unsupported PDF font resource.');
    let result = this.cache.get(filename);
    if (!result) {
      result = globalThis.fetch(url, { mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }).then(async response => {
        if (!response.ok) throw new Error('PDF font is unavailable.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 256 * 1024) throw new Error('Invalid PDF font resource.');
        return bytes;
      });
      this.cache.set(filename, result);
    }
    return result;
  }
}
