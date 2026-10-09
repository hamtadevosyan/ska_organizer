const { createHash } = require('node:crypto');
const { file, MAX_FILE_BYTES } = require('../services/childDocumentValidation');
const { classic, replaceClassic: replace, crossReferenceStream, compatiblePdfFixtures } = require('./helpers/pdfCompatibilityFixtures');
const upload = bytes => ({ name: 'Synthetic document.pdf', contentType: 'application/pdf', dataBase64: bytes.toString('base64') });

test.each(compatiblePdfFixtures)('accepts %s without modifying its bytes', (_, bytes) => {
  const result = file(upload(bytes));
  expect(result.content).toEqual(bytes);
  expect(result.byteLength).toBe(bytes.length);
  expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
});

test.each(['\x00', '\t', '\n', '\f', '\r', ' '])('allows PDF whitespace after EOF %#', whitespace => {
  const bytes = Buffer.concat([classic, Buffer.from(whitespace)]);
  expect(file(upload(bytes)).content).toEqual(bytes);
});

const malformed = [
  ['plain text in a PDF wrapper', Buffer.from('%PDF-1.7\nnot a PDF\n%%EOF\n')],
  ['missing EOF', classic.subarray(0, classic.length - 10)],
  ['xref outside the file', replace(/startxref\n\d+/, 'startxref\n99999999')],
  ['xref points inside its keyword', replace(/startxref\n(\d+)/, (_, offset) => 'startxref\n' + (Number(offset) + 1))],
  ['xref points to preceding whitespace', replace(/startxref\n(\d+)/, (_, offset) => 'startxref\n' + (Number(offset) - 1))],
  ['no top-level root', replace('/Root 1 0 R', '/Metadata << /Root 1 0 R >>')],
  ['root only inside a literal string', replace('/Root 1 0 R', '/Note (/Root 1 0 R)')],
  ['root only inside an escaped name', replace('/Root 1 0 R', '/Note /#2fRoot#201#200#20R')],
  ['root only inside hexadecimal text', replace('/Root 1 0 R', '/Note <2f526f6f74203120302052>')],
  ['root only inside a comment', replace('/Root 1 0 R', '/Note (Synthetic) % /Root 1 0 R\n')],
  ['root outside the declared object range', replace('/Root 1 0 R', '/Root 6 0 R')],
  ['invalid name escape', replace('/Root ', '/#GGoot ')],
  ['unclosed nested dictionary', replace('/Root 1 0 R', '/Metadata << /Root 1 0 R')],
  ['unclosed literal string', replace('/Root 1 0 R', '/Note (Synthetic /Root 1 0 R')],
  ['wrong xref stream type', crossReferenceStream(value => value.replace('/Type /XRef', '/Type /Page'))],
  ['nested xref stream type', crossReferenceStream(value => value.replace('/Type /XRef', '/Metadata << /Type /XRef >>'))],
  ['wrong xref stream widths', crossReferenceStream(value => value.replace('/W [1 4 2]', '/W [1 4]'))],
  ['missing xref stream width layout', crossReferenceStream(value => value.replace('/W [', '/Fake ['))],
];

test.each(malformed)('rejects %s', (_, bytes) => {
  expect(() => file(upload(bytes))).toThrow('The PDF file is damaged or incomplete.');
});

test('retains the 5 MB file size limit', () => {
  expect(() => file(upload(Buffer.alloc(MAX_FILE_BYTES + 1)))).toThrow('Choose a file no larger than 5 MB.');
});
