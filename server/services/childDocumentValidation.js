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
const PDF_WHITESPACE = '[\\x00\\t\\n\\f\\r ]';
const PDF_SEPARATORS = '(?:' + PDF_WHITESPACE + '|%[^\\r\\n]*(?:\\r\\n?|\\n|$))+';
const pdfSeparators = new RegExp('^' + PDF_SEPARATORS);
function pdf(buffer) {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(buffer.toString('latin1', 0, Math.min(buffer.length, 12))) ||
    !new RegExp('%%EOF' + PDF_WHITESPACE + '*$').test(buffer.toString('latin1', Math.max(0, buffer.length - 1024)))) {
    throw invalid('The PDF file is damaged or incomplete.');
  }
  // Basic integrity checks, not a complete PDF parser or malware scan. Keep the
  // bounded cross-reference/trailer checks compatible with classic tables,
  // compressed cross-reference streams and inherited incremental trailers.
  const tailOffset = Math.max(0, buffer.length - 4096);
  const terminal = new RegExp('(?:^|[\\r\\n])startxref' + PDF_SEPARATORS + '(\\d{1,10})' + PDF_SEPARATORS +
    '%%EOF' + PDF_WHITESPACE + '*$').exec(buffer.toString('latin1', tailOffset));
  if (!terminal) throw invalid('The PDF file is damaged or incomplete.');
  const finalSectionEnd = tailOffset + terminal.index;
  let position = Number(terminal[1]);
  const visited = new Set();
  for (let depth = 0; depth < 32; depth++) {
    if (!Number.isSafeInteger(position) || position < 9 || position >= finalSectionEnd || visited.has(position)) break;
    visited.add(position);
    const section = buffer.toString('latin1', position, Math.min(finalSectionEnd, position + 1024 * 1024));
    // startxref must address the actual keyword/object, not nearby whitespace.
    if (!/^(?:xref|[1-9]\d{0,9})(?=[\x00\t\n\f\r %])/.test(section)) break;
    const reader = { value: section, index: 0 };
    const first = pdfToken(reader);
    let dictionary;
    if (first?.type === 'atom' && first.value === 'xref') {
      let sections = 0;
      while (reader.index < section.length) {
        const start = pdfToken(reader);
        if (start?.type === 'atom' && start.value === 'trailer') {
          if (sections) dictionary = pdfDictionary(section.slice(reader.index));
          break;
        }
        const count = pdfInteger(pdfToken(reader), 1);
        if (pdfInteger(start, 0) === null || count === null || count > (section.length - reader.index) / 18) break;
        let valid = true;
        for (let entry = 0; entry < count; entry++) {
          const offset = pdfToken(reader); const generation = pdfToken(reader); const flag = pdfToken(reader);
          if (offset?.type !== 'atom' || !/^\d{10}$/.test(offset.value) || generation?.type !== 'atom' ||
            !/^\d{5}$/.test(generation.value) || Number(generation.value) > 65535 || flag?.type !== 'atom' || !/^[nf]$/.test(flag.value)) {
            valid = false; break;
          }
        }
        if (!valid) break;
        sections++;
      }
    } else {
      const generation = pdfToken(reader); const object = pdfToken(reader);
      if (pdfInteger(first, 1) === null || pdfInteger(generation, 0, 65535) === null || object?.type !== 'atom' || object.value !== 'obj') break;
      const body = section.slice(reader.index);
      dictionary = pdfDictionary(body);
      if (!dictionary || dictionary.entries.get('Type')?.type !== 'name' || dictionary.entries.get('Type').value !== 'XRef') break;
      const widths = dictionary.entries.get('W'); const length = dictionary.entries.get('Length');
      if (widths?.type !== 'array' || widths.values.length !== 3 || widths.values.some(value => pdfInteger(value, 0) === null) ||
        (pdfInteger(length, 1) === null && !(length?.type === 'reference' && pdfInteger({ type: 'atom', value: length.object }, 1) !== null))) break;
      const afterDictionary = body.slice(dictionary.length).replace(pdfSeparators, '');
      if (!/^stream(?:\r\n|\n|\r)/.test(afterDictionary) ||
        !new RegExp('endstream' + PDF_SEPARATORS + 'endobj(?=' + PDF_WHITESPACE + '|[()<>\\[\\]/%]|$)').test(afterDictionary)) break;
    }
    if (!dictionary) break;
    const size = pdfInteger(dictionary.entries.get('Size'), 1);
    if (size === null) break;
    const root = dictionary.entries.get('Root');
    if (root?.type === 'reference' && pdfInteger({ type: 'atom', value: root.object }, 1, size - 1) !== null &&
      pdfInteger({ type: 'atom', value: root.generation }, 0, 65535) !== null) return;
    const previous = pdfInteger(dictionary.entries.get('Prev'), 0);
    if (previous === null || previous >= position) break;
    position = previous;
  }
  throw invalid('The PDF file is damaged or incomplete.');
}
function pdfInteger(token, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!token || !['atom', 'number'].includes(token.type) || !/^\d+$/.test(token.value)) return null;
  const number = Number(token.value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}
function pdfToken(reader) {
  const value = reader.value;
  while (reader.index < value.length) {
    const char = value[reader.index];
    if (/[\x00\t\n\f\r ]/.test(char)) { reader.index++; continue; }
    if (char === '%') {
      while (reader.index < value.length && !/[\r\n]/.test(value[reader.index])) reader.index++;
      continue;
    }
    break;
  }
  if (reader.index >= value.length) return null;
  const start = reader.index++; const char = value[start];
  if ((char === '<' || char === '>') && value[reader.index] === char) {
    reader.index++; return { type: 'delimiter', value: char + char };
  }
  if (char === '(') {
    let nesting = 1;
    while (reader.index < value.length) {
      const next = value[reader.index++];
      if (next === '\\') { if (reader.index >= value.length) return null; reader.index++; }
      else if (next === '(') nesting++;
      else if (next === ')' && --nesting === 0) return { type: 'string' };
    }
    return null;
  }
  if (char === '<') {
    while (reader.index < value.length) {
      const next = value[reader.index++];
      if (next === '>') return { type: 'string' };
      if (!/[0-9a-fA-F\x00\t\n\f\r ]/.test(next)) return null;
    }
    return null;
  }
  if (char === '[' || char === ']') return { type: 'delimiter', value: char };
  if (char !== '/' && /[)>%{}]/.test(char)) return null;
  while (reader.index < value.length && !/[\x00\t\n\f\r ()<>\[\]/%{}]/.test(value[reader.index])) reader.index++;
  if (char === '/') {
    const name = value.slice(start + 1, reader.index);
    if (/#(?![0-9a-fA-F]{2})/.test(name)) return null;
    return { type: 'name', value: name.replace(/#([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(parseInt(code, 16))) };
  }
  return { type: 'atom', value: value.slice(start, reader.index) };
}
function pdfValue(reader, token, depth) {
  if (!token || depth > 32) return null;
  if (token.type === 'name' || token.type === 'string') return token;
  if (token.type === 'delimiter' && token.value === '<<') return pdfEntries(reader, depth + 1);
  if (token.type === 'delimiter' && token.value === '[') {
    const values = [];
    while (reader.index < reader.value.length) {
      const item = pdfToken(reader);
      if (item?.type === 'delimiter' && item.value === ']') return { type: 'array', values };
      const parsed = pdfValue(reader, item, depth + 1);
      if (!parsed) return null;
      values.push(parsed);
    }
    return null;
  }
  if (token.type !== 'atom') return null;
  if (/^\d+$/.test(token.value)) {
    const position = reader.index; const generation = pdfToken(reader); const reference = pdfToken(reader);
    if (generation?.type === 'atom' && /^\d+$/.test(generation.value) && reference?.type === 'atom' && reference.value === 'R') {
      return { type: 'reference', object: token.value, generation: generation.value };
    }
    reader.index = position;
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token.value)) return { type: 'number', value: token.value };
  return /^(?:true|false|null)$/.test(token.value) ? token : null;
}
function pdfEntries(reader, depth) {
  const entries = new Map();
  while (reader.index < reader.value.length) {
    const key = pdfToken(reader);
    if (key?.type === 'delimiter' && key.value === '>>') return { type: 'dictionary', entries };
    if (key?.type !== 'name') return null;
    const value = pdfValue(reader, pdfToken(reader), depth);
    if (!value) return null;
    entries.set(key.value, value);
  }
  return null;
}
function pdfDictionary(value) {
  // Read only the bounded dictionary, respecting names, comments, literal/hex
  // strings and nested values. A nested or quoted /Root cannot supply the
  // trailer's top-level catalog reference.
  const reader = { value: value.slice(0, 65536), index: 0 };
  const start = pdfToken(reader);
  if (start?.type !== 'delimiter' || start.value !== '<<') return null;
  const dictionary = pdfEntries(reader, 0);
  return dictionary ? { entries: dictionary.entries, length: reader.index } : null;
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
