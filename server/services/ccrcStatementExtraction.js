const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const documentValidation = require('./childDocumentValidation');
const { parseStatement } = require('./ccrcStatementParser');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 12;
const MAX_IMAGE_PIXELS = 20 * 1000 * 1000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_PAGE_TEXT_BYTES = 128 * 1024;
const MAX_TIME_MS = 120000;
const error = (message, status = 400, code = 'CCRC_FILE_INVALID') => Object.assign(new Error(message), { status, code });
let processing = false;
function validateStatementFile(payload) {
  documentValidation.object(payload, ['name', 'contentType', 'dataBase64'], 'file');
  const name = documentValidation.text(payload.name, 'filename', 200, { required: true });
  if (/[\/\\\r\n]/.test(name) || ['.', '..'].includes(name)) throw error('Choose a statement with a valid filename.');
  try { encodeURIComponent(name); } catch { throw error('Choose a statement with a valid filename.'); }
  const extension = name.match(/\.(pdf|jpe?g|png)$/i)?.[1].toLowerCase();
  const expected = extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : /^(?:jpg|jpeg)$/.test(extension || '') ? 'image/jpeg' : null;
  if (!expected || payload.contentType !== expected) throw error('Choose a PDF, JPG or PNG statement with a matching file type.');
  if (typeof payload.dataBase64 !== 'string') throw error('Choose a readable statement file.');
  if (payload.dataBase64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw error('Choose a statement no larger than 5 MB.', 413, 'CCRC_FILE_TOO_LARGE');
  if (!payload.dataBase64 || payload.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.dataBase64)) throw error('The statement could not be read. Choose it again.');
  const buffer = Buffer.from(payload.dataBase64, 'base64');
  if (!buffer.length || buffer.toString('base64') !== payload.dataBase64) throw error('The statement could not be read. Choose it again.');
  if (buffer.length > MAX_FILE_BYTES) throw error('Choose a statement no larger than 5 MB.', 413, 'CCRC_FILE_TOO_LARGE');
  if (expected === 'application/pdf') {
    // Poppler performs the actual bounded parse below. Do not impose the
    // historical document uploader's hand-written cross-reference rules on
    // otherwise valid compressed/incrementally saved payment PDFs.
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(buffer.toString('latin1', 0, Math.min(12, buffer.length))) ||
      !/%%EOF[\x00\t\n\f\r ]*$/.test(buffer.toString('latin1', Math.max(0, buffer.length - 1024)))) throw error('The PDF statement is damaged or incomplete.');
  } else {
    let width, height;
    if (expected === 'image/png') {
      if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw error('The PNG statement is damaged or incomplete.');
      width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
    } else {
      if (buffer[0] !== 255 || buffer[1] !== 216) throw error('The JPG statement is damaged or incomplete.');
      let offset = 2;
      while (offset + 4 <= buffer.length && buffer[offset] === 255) {
        while (buffer[offset] === 255) offset++;
        const marker = buffer[offset++];
        if ([217, 218].includes(marker)) break;
        if (marker === 1 || marker >= 208 && marker <= 215) continue;
        if (offset + 2 > buffer.length) break;
        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) break;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
          height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break;
        }
        offset += length;
      }
    }
    if (!width || !height || width > 5000 || height > 5000 || width * height > MAX_IMAGE_PIXELS) throw error('Choose a statement photo with at most 20 million pixels and no side longer than 5000 pixels.');
    try { documentValidation.file(payload); }
    catch { throw error('The statement image is damaged or incomplete. Choose a readable JPG or PNG.'); }
  }
  return { name, contentType: expected, byteLength: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), buffer };
}
function command(program, args, { directory, signal, timeout, maxBytes, invalidPdf = false }) {
  if (signal?.aborted) return Promise.reject(error('Statement reading was cancelled.', 400, 'CCRC_EXTRACTION_CANCELLED'));
  return new Promise((resolve, reject) => {
    // The tool has its own address-space and CPU ceiling as well as a wall
    // clock timeout. A tiny compressed PDF cannot exhaust the app's memory
    // while Poppler inspects a malformed stream before image scaling.
    const child = spawn('prlimit', ['--as=536870912', '--cpu=45', '--', program, ...args], { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C', OMP_THREAD_LIMIT: '1' } });
    const chunks = []; let bytes = 0, stderrBytes = 0, failure, settled = false, reapTimer;
    const finish = (problem, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(reapTimer); signal?.removeEventListener('abort', abort);
      if (problem) reject(problem); else resolve(value);
    };
    const stop = problem => {
      failure ||= problem; child.kill('SIGKILL');
      // A process error or a platform-specific missing close event must not
      // keep the upload forever. File cleanup happens after this settles.
      reapTimer ||= setTimeout(() => finish(failure), 1000);
      reapTimer.unref();
    };
    const abort = () => stop(error('Statement reading was cancelled.', 400, 'CCRC_EXTRACTION_CANCELLED'));
    const timer = setTimeout(() => stop(error('Statement reading took too long. Use a smaller or clearer statement, or enter its lines manually.', 422, 'CCRC_EXTRACTION_TIMEOUT')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(error('This page has too much text to read safely. Enter its lines manually.', 422, 'CCRC_EXTRACTION_LIMIT'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) stop(error('The statement could not be processed safely. Enter its lines manually.', 422, 'CCRC_EXTRACTION_LIMIT'));
    });
    child.on('error', cause => finish(cause.code === 'ENOENT' ? error('Local PDF/photo reading is not installed. Ask the administrator to run the CCRC OCR setup.', 503, 'CCRC_EXTRACTION_UNAVAILABLE') : error('Local statement reading is temporarily unavailable.', 503, 'CCRC_EXTRACTION_UNAVAILABLE')));
    child.on('close', code => {
      if (failure) return finish(failure);
      if ([69, 126, 127].includes(code)) return finish(error('Local PDF/photo reading is not installed or cannot run. Ask the administrator to run the CCRC OCR setup.', 503, 'CCRC_EXTRACTION_UNAVAILABLE'));
      if (code !== 0) return finish(invalidPdf ? error('The PDF could not be read. It may be damaged or password protected.', 400, 'CCRC_FILE_INVALID') : error('This page could not be read. Check the original and enter its lines manually.', 422, 'CCRC_PAGE_UNREADABLE'));
      finish(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}
async function extractStatement(file, { signal } = {}) {
  if (!file || !Buffer.isBuffer(file.buffer) || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.contentType) || !file.buffer.length || file.buffer.length > MAX_FILE_BYTES) throw error('Choose a valid statement file.');
  if (processing) throw error('Another statement is being read. Try again in a moment.', 429, 'CCRC_EXTRACTION_BUSY');
  if (signal?.aborted) throw error('Statement reading was cancelled.', 400, 'CCRC_EXTRACTION_CANCELLED');
  processing = true; const started = performance.now(); let directory;
  const pages = [], warnings = []; let pageCount = 1, textBytes = 0, incomplete = false;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skao-ccrc-')); await fs.chmod(directory, 0o700);
    const source = path.join(directory, file.contentType === 'application/pdf' ? 'source.pdf' : file.contentType === 'image/png' ? 'source.png' : 'source.jpg');
    await fs.writeFile(source, file.buffer, { mode: 0o600, flag: 'wx' });
    const run = (program, args, maxBytes = MAX_PAGE_TEXT_BYTES, options = {}) => {
      const remaining = MAX_TIME_MS - (performance.now() - started);
      if (remaining <= 0) throw error('Statement reading took too long. Enter its lines manually.', 422, 'CCRC_EXTRACTION_TIMEOUT');
      return command(program, args, { directory, signal, timeout: Math.min(45000, remaining), maxBytes, ...options });
    };
    if (file.contentType === 'application/pdf') {
      const info = await run('pdfinfo', ['-box', source], 64 * 1024, { invalidPdf: true });
      const count = /^Pages:\s*(\d+)\s*$/m.exec(info);
      if (!count || !Number.isSafeInteger(+count[1]) || +count[1] < 1) throw error('The PDF page count could not be read.', 400, 'CCRC_FILE_INVALID');
      pageCount = +count[1];
      if (pageCount > MAX_PAGES) throw error('Choose a statement with no more than ' + MAX_PAGES + ' pages. Split a larger statement into complete, clearly identified parts.', 413, 'CCRC_FILE_TOO_MANY_PAGES');
      if (/^Encrypted:\s*yes\b/m.test(info)) throw error('Choose an unlocked, unencrypted statement PDF.', 400, 'CCRC_FILE_INVALID');
    }
    for (let number = 1; number <= pageCount; number++) {
      if (signal?.aborted) throw error('Statement reading was cancelled.', 400, 'CCRC_EXTRACTION_CANCELLED');
      const page = { number, text: '', method: 'unreadable', warnings: [] };
      try {
        let embeddedText = '', needsImageOcr = false;
        if (file.contentType === 'application/pdf') {
          const images = await run('pdfimages', ['-f', String(number), '-l', String(number), '-list', source], 64 * 1024);
          let totalImagePixels = 0;
          for (const line of images.split('\n')) {
            const columns = line.trim().split(/\s+/);
            if (!/^\d+$/.test(columns[0] || '') || !['image', 'mask', 'smask', 'stencil'].includes(columns[2])) continue;
            const width = Number(columns[3]), height = Number(columns[4]), pixels = width * height;
            if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > MAX_IMAGE_PIXELS || (totalImagePixels += pixels) > MAX_IMAGE_PIXELS) throw error('This PDF page contains images too large to process safely. Enter this page manually.', 422, 'CCRC_EXTRACTION_LIMIT');
            needsImageOcr ||= columns[2] === 'image' && pixels >= 300000;
          }
          page.text = await run('pdftotext', ['-f', String(number), '-l', String(number), '-layout', '-enc', 'UTF-8', '-nopgbrk', source, '-']);
          page.text = page.text.replace(/\u0000/g, '').trim();
          if (/\p{L}{2}/u.test(page.text)) page.method = 'text';
          embeddedText = page.text;
        }
        if (page.method !== 'text' || needsImageOcr) {
          let image = source;
          if (file.contentType === 'application/pdf') {
            const prefix = path.join(directory, 'page-' + number);
            // Fit the entire page to 2200 pixels without cropping. One page
            // is rendered and OCRed at a time, including the final page.
            await run('pdftoppm', ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '2200', '-png', source, prefix], 4096);
            image = prefix + '.png';
            const details = await fs.stat(image);
            if (details.size > 16 * 1024 * 1024) throw error('The rendered page is too large. Enter this page manually.', 422, 'CCRC_EXTRACTION_LIMIT');
          } else {
            // Retain the original upload exactly, including its source hash.
            // Only this temporary OCR copy is oriented, scaled and flattened.
            image = path.join(directory, 'prepared-photo.png');
            await run('python3', [path.join(__dirname, 'normalizeCcrcImage.py'), source, image], 4096);
          }
          page.text = (await run('tesseract', [image, 'stdout', '-l', 'eng', '--psm', '6', '--dpi', '200'])).replace(/\u0000/g, '').trim();
          if (!/\p{L}{2}/u.test(page.text)) throw error('This page contains no readable statement text.', 422, 'CCRC_PAGE_UNREADABLE');
          page.method = 'ocr'; page.warnings.push('OCR can misread names, dates, decimal points and the last rows. Check this whole page against the original.');
          if (needsImageOcr && embeddedText) page.warnings.push('A large scanned image was found beside embedded text. This page was read from its full rendered image to include the scanned rows.');
        }
        textBytes += Buffer.byteLength(page.text);
        if (textBytes > MAX_TEXT_BYTES) { page.text = ''; page.method = 'unreadable'; throw error('The statement contains too much text to read safely.', 422, 'CCRC_EXTRACTION_LIMIT'); }
      } catch (cause) {
        if (cause.code === 'CCRC_EXTRACTION_CANCELLED') throw cause;
        incomplete = true; page.method = 'unreadable'; page.text = '';
        page.warnings.push('This page was not extracted. Review the original and enter all of its paid lines manually.');
        if (cause.code === 'CCRC_EXTRACTION_LIMIT') page.warnings.push(cause.message);
        if (cause.code === 'CCRC_EXTRACTION_UNAVAILABLE') warnings.push('Local photo/PDF reading is unavailable. Ask the administrator to install the CCRC OCR tools, or review every page and enter the lines manually.');
        if (cause.code === 'CCRC_EXTRACTION_TIMEOUT') warnings.push('The reading time limit was reached. Remaining pages are retained as unreadable and need manual review.');
      }
      pages.push(page);
      // Discard generated page images as soon as they are no longer needed.
      if (file.contentType === 'application/pdf') await fs.rm(path.join(directory, 'page-' + number + '.png'), { force: true });
    }
    const parsed = parseStatement(pages);
    return { pageCount, pages, ...parsed, warnings: [...new Set([...warnings, ...parsed.warnings])], incomplete: incomplete || !!parsed.incomplete };
  } finally {
    try { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
    finally { processing = false; }
  }
}
module.exports = { validateStatementFile, extractStatement, MAX_FILE_BYTES, MAX_PAGES, MAX_IMAGE_PIXELS, MAX_TIME_MS };
