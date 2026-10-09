const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { deflateSync } = require('node:zlib');

const classic = readFileSync(join(__dirname, '../fixtures/child-documents/synthetic.pdf'));
const replaceClassic = (original, replacement) => Buffer.from(classic.toString('latin1').replace(original, replacement), 'latin1');

function crossReferenceStream(dictionary = value => value, beforeDictionary = '', closing = '\n') {
  const chunks = [Buffer.from('%PDF-1.5\n')];
  const offsets = [0];
  const length = () => chunks.reduce((total, chunk) => total + chunk.length, 0);
  for (const [index, value] of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>'].entries()) {
    offsets.push(length()); chunks.push(Buffer.from((index + 1) + ' 0 obj\n' + value + '\nendobj\n'));
  }
  const xref = length(); offsets.push(xref);
  const entries = Buffer.alloc(5 * 7); entries.writeUInt16BE(65535, 5);
  for (let index = 1; index < 5; index++) {
    entries[index * 7] = 1; entries.writeUInt32BE(offsets[index], index * 7 + 1);
  }
  const compressed = deflateSync(entries);
  const header = dictionary('<< /Type /XRef /Size 5 /Root 1 0 R /W [1 4 2] /Length ' + compressed.length + ' /Filter /FlateDecode >>');
  chunks.push(Buffer.from('4 0 obj\n' + beforeDictionary + header + '\nstream\n'), compressed,
    Buffer.from('\nendstream' + closing + 'endobj\nstartxref\n' + xref + '\n%%EOF\n'));
  return Buffer.concat(chunks);
}

// Fictional, inactive one-page documents. These variants are independently
// checked with PDF.js; all except NUL-only numeric separators also parse with
// pypdf's strict reader (which does not support that separator combination).
const compatiblePdfFixtures = [
  ['ordinary classic table', classic],
  ['form-feed separators', replaceClassic('/Root 1 0 R', '/Root\f1\f0\fR')],
  ['NUL separators', replaceClassic('/Root 1 0 R', '/Root\x001\x000\x00R')],
  ['escaped trailer names', replaceClassic('/Size 6 /Root', '/Si#7ae 6 /#52oot')],
  ['comment before trailer dictionary', replaceClassic('trailer\n<<', 'trailer\n% Synthetic comment\n<<')],
  ['comments between trailer values', replaceClassic('/Root 1 0 R', '/Root% Synthetic comment\n1 0 R')],
  ['opaque string and hex metadata', replaceClassic('/Size 6 /Root', '/Note (A \\(synthetic\\) /Root 9 0 R) /Hex <526f6f74> /Size 6 /Root')],
  ['nested metadata', replaceClassic('/Size 6 /Root', '/Metadata << /Root 9 0 R /Labels [(Synthetic) <526f6f74>] >> /Size 6 /Root')],
  ['cross-reference stream', crossReferenceStream()],
  ['escaped stream names and comment before its dictionary', crossReferenceStream(value => value.replace('/Type /XRef', '/Ty#70e /X#52ef')
    .replace('/W ', '/#57 ').replace('/Length ', '/Len#67th ').replace('/Root ', '/#52oot ').replace('/Size ', '/Si#7ae '), '% Synthetic dictionary comment\n')],
  ['comment between stream closing tokens', crossReferenceStream(value => value, '', '\n% Synthetic closing comment\n')],
];

module.exports = { classic, replaceClassic, crossReferenceStream, compatiblePdfFixtures };
