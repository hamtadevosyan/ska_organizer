const { createHash } = require('node:crypto');
const { PNG } = require('pngjs');
const { inflateSync } = require('node:zlib');
const { problem } = require('../auth/service');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20 * 1000 * 1000;
const invalid = (message, field = 'file', status = 400) => Object.assign(problem(message, status, 'DOCUMENT_INVALID'), { fields: { [field]: message } });
const object = (value, keys, label = 'document') => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw invalid('Supply valid ' + label + ' details.', label);
  }
};
function text(value, field, maximum, { required = false, fallback = '' } = {}) {
  if (value === undefined) value = fallback;
  if (typeof value !== 'string') throw invalid('Enter valid text for ' + field + '.', field);
  value = value.trim();
  if ((required && !value) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw invalid('Enter ' + (required ? '1–' : 'at most ') + maximum + ' characters for ' + field + '.', field);
  }
  return value;
}
function identifier(value, field) {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid('Choose a valid ' + field + '.', field);
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw invalid('Reload the document form and try again.', 'requestId');
  }
  return value.toLowerCase();
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('Reload this document before saving.', 'version');
  return value;
}
function metadata(payload) {
  const title = text(payload.title, 'title', 160, { required: true });
  if (!['medical', 'contract', 'consent', 'other'].includes(payload.category)) throw invalid('Choose a document category.', 'category');
  const documentDate = payload.documentDate === undefined || payload.documentDate === '' ? null : payload.documentDate;
  if (documentDate !== null && (typeof documentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(documentDate) ||
    !Number.isFinite(Date.parse(documentDate + 'T00:00:00Z')) || new Date(documentDate + 'T00:00:00Z').toISOString().slice(0, 10) !== documentDate ||
    documentDate < '1900-01-01' || documentDate > '9999-12-31')) throw invalid('Enter a valid document date.', 'documentDate');
  return { title, category: payload.category, documentDate, notes: text(payload.notes, 'notes', 2000) };
}
function pagination(query = {}, extra = []) {
  object(query, ['page', 'pageSize', ...extra], 'pagination');
  const numeric = (value, field, fallback, maximum) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
      throw invalid('Choose a valid ' + field + '.', field);
    }
    return Number(value);
  };
  return { page: numeric(query.page, 'page', 1, 1000000), pageSize: numeric(query.pageSize, 'pageSize', 20, 50) };
}
function dimensions(width, height) {
  if (!width || !height || width > 20000 || height > 20000 || width * height > MAX_IMAGE_PIXELS) {
    throw invalid('This image is too large to process. Choose an image with no more than 20 million pixels.');
  }
}
function png(buffer) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw invalid('The PNG file is damaged or incomplete.');
  const width = buffer.readUInt32BE(16); const height = buffer.readUInt32BE(20);
  dimensions(width, height);
  const depth = buffer[24]; const color = buffer[25]; const interlace = buffer[28];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || buffer[26] !== 0 || buffer[27] !== 0 || interlace > 1) throw invalid('The PNG file is damaged or incomplete.');
  let offset = 8; let chunks = 0; let imageData = false; let ended = false;
  const compressed = [];
  while (offset < buffer.length && ++chunks <= 10000) {
    if (offset + 12 > buffer.length) throw invalid('The PNG file is damaged or incomplete.');
    const length = buffer.readUInt32BE(offset); const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (length > buffer.length - offset - 12) throw invalid('The PNG file is damaged or incomplete.');
    offset += length + 12;
    if (type === 'IDAT') { imageData = true; compressed.push(buffer.subarray(offset - length - 4, offset - 4)); }
    if (type === 'IEND') { ended = length === 0 && offset === buffer.length; break; }
  }
  if (!ended || !imageData) throw invalid('The PNG file is damaged or incomplete.');
  try {
    // pngjs bounds ordinary PNG inflation but not its interlaced path. First
    // bound decompression to the exact scanline length declared by IHDR, so a
    // small upload cannot allocate an unbounded inflated buffer on the server.
    const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => ({ width: Math.max(0, Math.ceil((width - x) / dx)), height: Math.max(0, Math.ceil((height - y) / dy)) }))
      .filter((pass) => pass.width && pass.height).map((pass) => ({ bytes: Math.ceil(pass.width * channels * depth / 8), height: pass.height }));
    const length = rows.reduce((total, pass) => total + (pass.bytes + 1) * pass.height, 0);
    let inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: length });
    if (inflated.length !== length) throw new Error('Invalid PNG scanline length.');
    let index = 0;
    for (const pass of rows) for (let row = 0; row < pass.height; row++) {
      if (inflated[index] > 4) throw new Error('Invalid PNG scanline filter.');
      index += pass.bytes + 1;
    }
    inflated = null;
    PNG.sync.read(buffer, { checkCRC: true });
  }
  catch { throw invalid('The PNG file is damaged or incomplete.'); }
}
function jpeg(buffer) {
  if (buffer.length < 20 || buffer[0] !== 255 || buffer[1] !== 216) throw invalid('The JPG file is damaged or incomplete.');
  let offset = 2; let frame = false; let scan = false;
  const frames = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
  while (offset < buffer.length) {
    if (buffer[offset++] !== 255) throw invalid('The JPG file is damaged or incomplete.');
    while (buffer[offset] === 255) offset++;
    const marker = buffer[offset++];
    if (marker === 217) {
      if (frame && scan && offset === buffer.length) return;
      throw invalid('The JPG file is damaged or incomplete.');
    }
    if (!marker || marker === 216 || marker === undefined || (marker >= 208 && marker <= 215)) throw invalid('The JPG file is damaged or incomplete.');
    if (marker === 1) continue;
    if (offset + 2 > buffer.length) throw invalid('The JPG file is damaged or incomplete.');
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw invalid('The JPG file is damaged or incomplete.');
    if (frames.has(marker)) {
      if (frame || length < 11) throw invalid('The JPG file is damaged or incomplete.');
      const components = buffer[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + 3 * components) throw invalid('The JPG file is damaged or incomplete.');
      dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)); frame = true;
    }
    offset += length;
    if (marker === 218) {
      if (!frame || length < 8) throw invalid('The JPG file is damaged or incomplete.');
      const components = buffer[offset - length + 2];
      if (components < 1 || components > 4 || length !== 6 + 2 * components) throw invalid('The JPG file is damaged or incomplete.');
      scan = true;
      const entropyStart = offset;
      // Skip entropy bytes, escaped FF values and restart markers, then parse
      // the next structural marker (including additional progressive scans).
      while (offset < buffer.length) {
        if (buffer[offset] !== 255) { offset++; continue; }
        const start = offset++;
        while (buffer[offset] === 255) offset++;
        const following = buffer[offset];
        if (following === 0 || (following >= 208 && following <= 215)) { offset++; continue; }
        offset = start; break;
      }
      if (offset === entropyStart) throw invalid('The JPG file is damaged or incomplete.');
    }
  }
  throw invalid('The JPG file is damaged or incomplete.');
}
function pdf(buffer) {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(buffer.toString('latin1', 0, Math.min(buffer.length, 12))) ||
    !/%%EOF[\t\r\n ]*$/.test(buffer.toString('latin1', Math.max(0, buffer.length - 1024)))) {
    throw invalid('The PDF file is damaged or incomplete.');
  }
  // Basic integrity checks, not a complete PDF parser or malware scan. Keep the
  // bounded cross-reference/trailer checks compatible with classic tables,
  // compressed cross-reference streams and inherited incremental trailers.
  const tailOffset = Math.max(0, buffer.length - 4096);
  const terminal = /(?:^|[\r\n])startxref[\t\r\n ]+(\d{1,10})[\t\r\n ]+%%EOF[\t\r\n ]*$/.exec(buffer.toString('latin1', tailOffset));
  if (!terminal) throw invalid('The PDF file is damaged or incomplete.');
  const finalSectionEnd = tailOffset + terminal.index;
  let position = Number(terminal[1]);
  const visited = new Set();
  for (let depth = 0; depth < 32; depth++) {
    if (!Number.isSafeInteger(position) || position < 9 || position >= finalSectionEnd || visited.has(position)) break;
    visited.add(position);
    const section = buffer.toString('latin1', position, Math.min(finalSectionEnd, position + 1024 * 1024));
    let dictionary;
    if (/^xref[\t\r\n ]/.test(section)) {
      if (!/^xref[\t\r\n ]+\d+[\t ]+[1-9]\d*[\t\r\n ]+\d{10}[\t ]+\d{5}[\t ]+[nf](?:[\t\r\n ]|$)/.test(section)) break;
      const trailer = /\btrailer[\t\r\n ]*(?=<<)/.exec(section);
      if (!trailer) break;
      dictionary = pdfDictionary(section.slice(trailer.index + trailer[0].length));
    } else {
      const header = /^[1-9]\d{0,9}[\t\r\n ]+\d{1,5}[\t\r\n ]+obj\b[\t\r\n ]*/.exec(section);
      if (!header) break;
      const body = section.slice(header[0].length);
      dictionary = pdfDictionary(body);
      if (!dictionary || !/\/Type[\t\r\n ]*\/XRef\b/.test(dictionary.text) ||
        !/\/W[\t\r\n ]*\[[\t\r\n ]*\d+[\t\r\n ]+\d+[\t\r\n ]+\d+[\t\r\n ]*\]/.test(dictionary.text) ||
        !/\/Length[\t\r\n ]+[1-9]\d*\b/.test(dictionary.text)) break;
      const afterDictionary = body.slice(dictionary.length);
      if (!/^[\t\r\n ]*stream(?:\r\n|\n|\r)/.test(afterDictionary) || !/endstream[\t\r\n ]+endobj\b/.test(afterDictionary)) break;
    }
    if (!dictionary) break;
    const size = /\/Size[\t\r\n ]+([1-9]\d*)\b/.exec(dictionary.text);
    if (!size || !Number.isSafeInteger(Number(size[1]))) break;
    const root = /\/Root[\t\r\n ]+([1-9]\d*)[\t\r\n ]+(\d{1,5})[\t\r\n ]+R\b/.exec(dictionary.text);
    if (root && Number(root[1]) < Number(size[1]) && Number(root[2]) <= 65535) return;
    const previous = /\/Prev[\t\r\n ]+(\d{1,10})\b/.exec(dictionary.text);
    if (!previous || Number(previous[1]) >= position) break;
    position = Number(previous[1]);
  }
  throw invalid('The PDF file is damaged or incomplete.');
}
function pdfDictionary(value) {
  // Track nested dictionaries and ignore comments/literal strings when finding
  // the closing delimiter. Bound dictionary scans independently of file size.
  value = value.slice(0, 65536);
  if (!value.startsWith('<<')) return null;
  let nesting = 0; let string = 0; let comment = false; let filtered = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]; const next = value[index + 1];
    if (comment) { if (char === '\r' || char === '\n') { comment = false; filtered += ' '; } continue; }
    if (string) {
      if (char === '\\') { index++; continue; }
      if (char === '(') string++;
      else if (char === ')') string--;
      continue;
    }
    if (char === '%') { comment = true; continue; }
    if (char === '(') { string = 1; filtered += ' '; continue; }
    if (char === '<' && next === '<') { nesting++; filtered += '<<'; index++; continue; }
    if (char === '>' && next === '>') {
      nesting--; filtered += '>>'; index++;
      if (nesting === 0) return { text: filtered, length: index + 1 };
      continue;
    }
    filtered += char;
  }
  return null;
}
function file(payload) {
  object(payload, ['name', 'contentType', 'dataBase64'], 'file');
  const filename = text(payload.name, 'filename', 200, { required: true });
  if (/[\/\\\r\n]/.test(filename) || filename === '.' || filename === '..') throw invalid('Choose a file with a valid filename.');
  try { encodeURIComponent(filename); } catch { throw invalid('Choose a file with a valid filename.'); }
  const extension = filename.match(/\.(pdf|jpe?g|png)$/i)?.[1].toLowerCase();
  const expected = extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : null;
  if (!expected || payload.contentType !== expected) throw invalid('Choose a PDF, JPG or PNG file with a matching file type.');
  if (typeof payload.dataBase64 !== 'string' || !payload.dataBase64) throw invalid('Choose a nonempty PDF, JPG or PNG file.');
  if (payload.dataBase64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw invalid('Choose a file no larger than 5 MB.', 'file', 413);
  if (payload.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.dataBase64)) throw invalid('The uploaded file could not be read. Choose the file again.');
  const content = Buffer.from(payload.dataBase64, 'base64');
  if (!content.length) throw invalid('Choose a nonempty PDF, JPG or PNG file.');
  if (content.length > MAX_FILE_BYTES) throw invalid('Choose a file no larger than 5 MB.', 'file', 413);
  if (content.toString('base64') !== payload.dataBase64) throw invalid('The uploaded file could not be read. Choose the file again.');
  if (expected === 'image/png') png(content);
  else if (expected === 'image/jpeg') jpeg(content);
  else pdf(content);
  return { filename, contentType: expected, byteLength: content.length, sha256: createHash('sha256').update(content).digest('hex'), content };
}
module.exports = { MAX_FILE_BYTES, MAX_IMAGE_PIXELS, invalid, object, text, identifier, requestId, version, metadata, pagination, file };
