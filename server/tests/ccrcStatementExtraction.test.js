const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { validateStatementFile, extractStatement, MAX_PAGES } = require('../services/ccrcStatementExtraction');
const fixtures = name => require('./fixtures/ccrc-statements/' + name + '.json');
const toolsAvailable = ['prlimit', 'pdfinfo', 'pdftotext', 'pdftoppm', 'pdfimages', 'tesseract'].every(program => !spawnSync(program, ['-v'], { stdio: 'ignore' }).error)
  && spawnSync('python3', ['-c', 'from PIL import Image, ImageOps'], { stdio: 'ignore' }).status === 0;
const real = toolsAvailable ? test : test.skip;
afterEach(() => jest.restoreAllMocks());
async function toolFixture(programs, check) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skao-ccrc-test-tools-'));
  const previous = process.env.PATH;
  try {
    await fs.symlink('/usr/bin/prlimit', path.join(directory, 'prlimit'));
    for (const [program, script] of Object.entries(programs)) await fs.writeFile(path.join(directory, program), '#!/bin/sh\n' + script + '\n', { mode: 0o700 });
    process.env.PATH = directory;
    return await check(directory);
  } finally { process.env.PATH = previous; await fs.rm(directory, { recursive: true, force: true }); }
}

test('statement validation retains exact original bytes, filename, type and digest', () => {
  const payload = fixtures('synthetic-labelled-pdf'), file = validateStatementFile(payload);
  expect(file).toMatchObject({ name: payload.name, contentType: 'application/pdf', byteLength: Buffer.from(payload.dataBase64, 'base64').length });
  expect(file.buffer.toString('base64')).toBe(payload.dataBase64);
  expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test.each([
  { name: '../statement.pdf', contentType: 'application/pdf', dataBase64: 'Zg==' },
  { name: 'statement.pdf', contentType: 'image/png', dataBase64: 'Zg==' },
  { name: 'statement.pdf', contentType: 'application/pdf', dataBase64: 'Zg=' },
  { name: 'statement.pdf', contentType: 'application/pdf', dataBase64: '!!!!' },
  { name: 'statement.svg', contentType: 'image/svg+xml', dataBase64: 'Zg==' },
  { name: 'statement.jpg', contentType: 'image/jpeg', dataBase64: Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(50, 255)]).toString('base64') },
])('malformed inputs fail safely before any OCR work %#', value => {
  expect(() => validateStatementFile(value)).toThrow();
  try { validateStatementFile(value); } catch (cause) { expect(cause.status).toBe(400); expect(cause).not.toBeInstanceOf(RangeError); }
});

test('oversized input is rejected before decoding or launching a child process', () => {
  const payload = { name: 'too-large.pdf', contentType: 'application/pdf', dataBase64: 'A'.repeat(4 * Math.ceil((5 * 1024 * 1024) / 3) + 4) };
  expect(() => validateStatementFile(payload)).toThrow(expect.objectContaining({ status: 413, code: 'CCRC_FILE_TOO_LARGE' }));
});

test('normal 12MP iPhone dimensions are accepted without changing the original JPEG bytes', () => {
  const payload = fixtures('synthetic-12mp-jpg'), bytes = Buffer.from(payload.dataBase64, 'base64');
  const parsed = validateStatementFile(payload);
  expect(parsed.buffer.equals(bytes)).toBe(true);
});

test('over-limit image dimensions fail with a plain input error', () => {
  const payload = fixtures('synthetic-photo-png'), bytes = Buffer.from(payload.dataBase64, 'base64');
  bytes.writeUInt32BE(5001, 16);
  expect(() => validateStatementFile({ ...payload, dataBase64: bytes.toString('base64') })).toThrow(expect.objectContaining({ status: 400, code: 'CCRC_FILE_INVALID' }));
});

real('installed Poppler reads every page of a text PDF including its final payment row', async () => {
  const result = await extractStatement(validateStatementFile(fixtures('synthetic-labelled-pdf')));
  expect(result).toMatchObject({ pageCount: 2, incomplete: false, paymentDate: '2026-11-20', totalCents: 100000 });
  expect(result.pages.map(page => [page.number, page.method])).toEqual([[1, 'text'], [2, 'text']]);
  expect(result.lines).toMatchObject([{ childName: 'Ada Synthetic', amountCents: 60000, page: 1 }, { childName: 'Ben Synthetic', amountCents: 40000, page: 2 }]);
  expect(result.pages.at(-1).text).toContain('Total paid: $1,000.00');
}, 15000);

real.each(['synthetic-photo-png', 'synthetic-photo-jpg'])('installed Tesseract reads an original statement photo: %s', async name => {
  const payload = fixtures(name), file = validateStatementFile(payload), result = await extractStatement(file);
  expect(file.buffer.toString('base64')).toBe(payload.dataBase64);
  expect(result).toMatchObject({ pageCount: 1, incomplete: false, totalCents: 60000, lines: [{ childName: 'Ada Synthetic', serviceMonth: '2026-10', amountCents: 60000 }] });
  expect(result.pages[0].method).toBe('ocr');
  expect(result.lines[0].warnings.join(' ')).toMatch(/OCR/);
}, 30000);

real.each([6, 8, 2])('phone EXIF orientation %s is normalized for OCR while every original JPEG byte and its source hash stay unchanged', async orientation => {
  const script = [
    'import base64, io, json, sys',
    'from PIL import Image',
    'source = json.load(sys.stdin)',
    'image = Image.open(io.BytesIO(base64.b64decode(source["dataBase64"])))',
    'orientation = int(sys.argv[1])',
    'transpose = getattr(Image, "Transpose", Image)',
    'operation = {6: transpose.ROTATE_90, 8: transpose.ROTATE_270, 2: transpose.FLIP_LEFT_RIGHT}[orientation]',
    'stored = image.transpose(operation)',
    'exif = Image.Exif(); exif[274] = orientation',
    'stored.save(sys.stdout.buffer, format="JPEG", quality=95, exif=exif)',
  ].join('\n');
  const original = execFileSync('python3', ['-c', script, String(orientation)], { input: JSON.stringify(fixtures('synthetic-photo-jpg')), timeout: 10000, maxBuffer: 1024 * 1024 });
  const file = validateStatementFile({ name: 'phone-portrait.jpg', contentType: 'image/jpeg', dataBase64: original.toString('base64') });
  const hash = file.sha256, result = await extractStatement(file);
  expect(result).toMatchObject({ incomplete: false, totalCents: 60000, lines: [{ childName: 'Ada Synthetic', serviceMonth: '2026-10', amountCents: 60000 }] });
  expect(file.buffer.equals(original)).toBe(true);
  expect(file.sha256).toBe(hash);
}, 30000);

real('photo preparation flattens transparency onto white without upscaling or copying private PNG metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skao-ccrc-photo-test-'));
  try {
    const input = path.join(directory, 'source.png'), output = path.join(directory, 'derived.png');
    execFileSync('python3', ['-c', [
      'import sys', 'from PIL import Image, PngImagePlugin',
      'image = Image.new("RGBA", (2, 3), (255, 0, 0, 0))',
      'metadata = PngImagePlugin.PngInfo(); metadata.add_text("private-note", "synthetic-secret")',
      'image.save(sys.argv[1], pnginfo=metadata)',
    ].join('\n'), input], { timeout: 10000 });
    const original = await fs.readFile(input);
    execFileSync('prlimit', ['--as=536870912', '--cpu=45', '--', 'python3', path.resolve(__dirname, '../services/normalizeCcrcImage.py'), input, output], { timeout: 10000 });
    const info = JSON.parse(execFileSync('python3', ['-c', [
      'import json, sys', 'from PIL import Image', 'image = Image.open(sys.argv[1])',
      'print(json.dumps({"size": image.size, "mode": image.mode, "pixel": image.getpixel((0, 0)), "keys": list(image.info), "exif": dict(image.getexif())}))',
    ].join('\n'), output], { encoding: 'utf8', timeout: 10000 }));
    expect(info).toEqual({ size: [2, 3], mode: 'RGB', pixel: [255, 255, 255], keys: [], exif: {} });
    expect(await fs.readFile(input)).toEqual(original);
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

real('photo preparation supports the legacy Pillow filter API', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skao-ccrc-legacy-pillow-'));
  try {
    const input = path.join(directory, 'source.png'), output = path.join(directory, 'derived.png');
    await fs.writeFile(input, Buffer.from(fixtures('synthetic-photo-png').dataBase64, 'base64'));
    // Present the pre-9.1 public API while retaining the installed decoder.
    const script = [
      'import sys, runpy, types, PIL',
      'from PIL import Image, ImageOps',
      'original = Image',
      'legacy = types.ModuleType("PIL.Image")',
      'legacy.LANCZOS = getattr(original, "Resampling", original).LANCZOS',
      'def lookup(name):',
      '    if name == "Resampling": raise AttributeError(name)',
      '    return getattr(original, name)',
      'legacy.__getattr__ = lookup',
      'PIL.Image = legacy',
      'sys.argv = sys.argv[1:]',
      'runpy.run_path(sys.argv[0], run_name="__main__")',
    ].join('\n');
    execFileSync('prlimit', ['--as=536870912', '--cpu=45', '--', 'python3', '-c', script,
      path.resolve(__dirname, '../services/normalizeCcrcImage.py'), input, output], { timeout: 10000 });
    expect((await fs.readFile(output)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await fs.readFile(input)).toEqual(Buffer.from(fixtures('synthetic-photo-png').dataBase64, 'base64'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

real('a missing Pillow installation reports a sanitized unavailable status without source paths or contents', async () => {
  const result = spawnSync('python3', ['-S', path.resolve(__dirname, '../services/normalizeCcrcImage.py'), '/synthetic-private/source.jpg', '/synthetic-private/derived.png'],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: '/tmp', LANG: 'C' } });
  expect(result.status).toBe(69);
  expect(result.stderr).toBe('Local statement image preparation is not installed.\n');
  expect(result.stderr).not.toMatch(/synthetic-private|Traceback/);
  expect(result.stdout).toBe('');
});

real('unavailable photo preparation preserves the uploaded page for manual review', async () => {
  const payload = fixtures('synthetic-photo-jpg'), file = validateStatementFile(payload);
  await toolFixture({ python3: 'exit 69' }, async () => {
    const result = await extractStatement(file);
    expect(result).toMatchObject({ pageCount: 1, incomplete: true, pages: [{ number: 1, method: 'unreadable', text: '' }] });
    expect(result.warnings.join(' ')).toMatch(/Local photo\/PDF reading is unavailable/);
    expect(file.buffer.toString('base64')).toBe(payload.dataBase64);
  });
});

real.each(['synthetic-scanned-pdf', 'synthetic-hybrid-pdf'])('scanned or mixed PDFs include the last page instead of mistaking a searchable heading for complete extraction: %s', async name => {
  const result = await extractStatement(validateStatementFile(fixtures(name)));
  expect(result).toMatchObject({ pageCount: 2, incomplete: false, totalCents: 100000 });
  expect(result.pages.every(page => page.method === 'ocr')).toBe(true);
  expect(result.lines).toMatchObject([{ childName: 'Ada Synthetic', amountCents: 60000, page: 1 }, { childName: 'Ben Synthetic', amountCents: 40000, page: 2 }]);
}, 60000);

real('password-protected PDFs fail before attempting OCR', async () => {
  await expect(extractStatement(validateStatementFile(fixtures('synthetic-locked-pdf')))).rejects.toMatchObject({ status: 400, code: 'CCRC_FILE_INVALID' });
});

real('a PDF exceeding the page limit is rejected before page decoding', async () => {
  await toolFixture({ pdfinfo: "printf 'Pages: 13\\nEncrypted: no\\n'" }, async () => {
    await expect(extractStatement(validateStatementFile(fixtures('synthetic-labelled-pdf')))).rejects.toMatchObject({ status: 413, code: 'CCRC_FILE_TOO_MANY_PAGES' });
  });
});

real('oversized embedded PDF rasters are stopped before text or image decompression and all pages stay visible', async () => {
  await toolFixture({ pdfinfo: "printf 'Pages: 2\\nEncrypted: no\\n'", pdfimages: "printf '1 0 image 100000 100000 rgb 3 8 image no 1 0 100 100 1K 1%%\\n'",
    pdftotext: "printf called > \"$0.called\"; printf 'Must not reach this decoder'" }, async directory => {
    const result = await extractStatement(validateStatementFile(fixtures('synthetic-labelled-pdf')));
    expect(result).toMatchObject({ pageCount: 2, incomplete: true, pages: [{ number: 1, method: 'unreadable' }, { number: 2, method: 'unreadable' }] });
    expect(result.pages[0].warnings.join(' ')).toMatch(/images too large/);
    await expect(fs.stat(path.join(directory, 'pdftotext.called'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

real('a failed last-page render is retained as an unreadable source page beside earlier extracted rows', async () => {
  await toolFixture({ pdfinfo: "printf 'Pages: 2\\nEncrypted: no\\n'", pdfimages: 'exit 0',
    pdftotext: "if [ \"$2\" = 1 ]; then printf 'Child name: Ada Synthetic\\nService month: 2026-10\\nAmount paid: $100.00\\n'; fi",
    pdftoppm: 'exit 1' }, async () => {
    const result = await extractStatement(validateStatementFile(fixtures('synthetic-labelled-pdf')));
    expect(result).toMatchObject({ pageCount: 2, incomplete: true, pages: [{ number: 1, method: 'text' }, { number: 2, method: 'unreadable', text: '' }] });
    expect(result.lines).toMatchObject([{ childName: 'Ada Synthetic', amountCents: 10000, page: 1 }]);
    expect(result.pages[1].warnings.join(' ')).toMatch(/not extracted/);
  });
});

real('excessive child stdout is bounded and the page remains a manual-review entry', async () => {
  const longLine = 'x'.repeat(1000);
  await toolFixture({ pdfinfo: "printf 'Pages: 1\\nEncrypted: no\\n'", pdfimages: 'exit 0',
    pdftotext: 'i=0; while [ "$i" -lt 300 ]; do printf \'' + longLine + '\\n\'; i=$((i + 1)); done' }, async () => {
    const result = await extractStatement(validateStatementFile(fixtures('synthetic-labelled-pdf')));
    expect(result).toMatchObject({ pageCount: 1, incomplete: true, pages: [{ number: 1, method: 'unreadable', text: '' }] });
    expect(result.pages[0].warnings.join(' ')).toMatch(/too much text/);
  });
});

test('missing OCR tools keep the photo page visible as unreadable for manual review', async () => {
  const previous = process.env.PATH; process.env.PATH = '/skao-synthetic-missing-tools';
  try {
    const result = await extractStatement(validateStatementFile(fixtures('synthetic-photo-png')));
    expect(result).toMatchObject({ pageCount: 1, incomplete: true, pages: [{ number: 1, method: 'unreadable', text: '' }] });
    expect(result.warnings.join(' ')).toMatch(/Local photo\/PDF reading is unavailable/);
  } finally { process.env.PATH = previous; }
});

test('cancellation releases the one-reader slot and removes its own private temporary directory', async () => {
  const temporary = jest.spyOn(fs, 'mkdtemp'), controller = new AbortController(), file = validateStatementFile(fixtures('synthetic-photo-png'));
  const reading = extractStatement(file, { signal: controller.signal });
  await expect(extractStatement(file)).rejects.toMatchObject({ status: 429, code: 'CCRC_EXTRACTION_BUSY' });
  controller.abort();
  await expect(reading).rejects.toMatchObject({ code: 'CCRC_EXTRACTION_CANCELLED' });
  const directory = await temporary.mock.results[0].value;
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await expect(extractStatement(file, { signal: alreadyCancelled.signal })).rejects.toMatchObject({ code: 'CCRC_EXTRACTION_CANCELLED' });
  expect(MAX_PAGES).toBe(12);
});
