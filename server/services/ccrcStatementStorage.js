const { createHash } = require('node:crypto');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const fileFields = ['fingerprint', 'filename', 'contentType', 'byteLength'];
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'CCRC_STATEMENT_INVALID' });
const conflict = () => Object.assign(new Error('This statement changed. Refresh before saving.'), { status: 409, code: 'CCRC_STATEMENT_CONFLICT' });
const duplicate = id => Object.assign(new Error('This statement file is already saved.'), { status: 409, code: 'CCRC_STATEMENT_DUPLICATE', statementId: id });

function validate(row, expectedVersion) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) ||
      !Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= 2147483647 || row.version !== expectedVersion + 1 ||
      !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) throw invalid('A valid statement object and next version are required.');
  let data;
  try { data = JSON.parse(JSON.stringify(row.data)); }
  catch { throw invalid('Supply a valid statement data object.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('Supply a valid statement data object.');
  return data;
}

function values(row, previous, data, now) {
  if (previous) {
    if (fileFields.some(field => Object.hasOwn(row, field) && row[field] !== previous[field]) ||
        Object.hasOwn(row, 'content') && (!(row.content instanceof Uint8Array) || !Buffer.from(row.content).equals(Buffer.from(previous.content)))) {
      throw invalid('The original statement file and its metadata cannot be changed.');
    }
    return { data, version: row.version, updatedAt: now };
  }
  const content = row.content instanceof Uint8Array ? Buffer.from(row.content) : null;
  if (!content || !content.length || content.length > MAX_FILE_BYTES || content.length !== row.byteLength ||
      !/^[0-9a-f]{64}$/.test(row.fingerprint) || createHash('sha256').update(content).digest('hex') !== row.fingerprint ||
      typeof row.filename !== 'string' || !row.filename.trim() || row.filename.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(row.filename) ||
      !['application/pdf', 'image/jpeg', 'image/png'].includes(row.contentType)) {
    throw invalid('Supply a bounded original PDF, JPG or PNG statement with matching file metadata.');
  }
  return { id: row.id, fingerprint: row.fingerprint, filename: row.filename, contentType: row.contentType,
    byteLength: content.length, content, data, version: row.version, createdAt: row.createdAt || now, updatedAt: now };
}

function copy(row, includeContent = true) {
  if (!row) return null;
  const { content, ...metadata } = row;
  return { ...structuredClone(metadata), ...(includeContent ? { content: Buffer.from(content) } : {}) };
}

module.exports = { MAX_FILE_BYTES, validate, values, copy, conflict, duplicate };
