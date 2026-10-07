const { readFileSync } = require('node:fs');
const path = require('node:path');
const { imageBuffer } = require('../services/recipePhotoService');
const { assemble, chunks, metadata, minimal } = require('./helpers/pngFixture');
const image = readFileSync(path.join(__dirname, 'fixtures/recipe-photo.png'));
const read = image => imageBuffer({ image: image.toString('base64') });

test('accepts browser PNG metadata and removes ICC, EXIF and text without changing image pixels', () => {
  const decorated = metadata(image);
  expect(read(decorated)).toEqual(image);
  expect(read(decorated).includes(Buffer.from('Synthetic private'))).toBe(false);
});

test.each([[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]])('accepts valid bounded PNG color %s and depth %s, including Adam7 interlace', (color, depth) => {
  for (const interlace of [0, 1]) expect(read(minimal(color, depth, interlace))).toEqual(minimal(color, depth, interlace));
});

test.each(['acTL', 'fcTL', 'fdAT', 'CgBI', 'ABCD', '\xC9HDR'])('rejects animation or unknown critical/non-ASCII chunk %s', type => {
  const parts = chunks(image); parts.splice(1, 0, { type, data: Buffer.alloc(8) });
  expect(() => read(assemble(parts))).toThrow();
});

test('rejects bad CRCs, overlong chunks, trailing bytes and duplicate headers', () => {
  const crc = Buffer.from(image); crc[crc.length - 1] ^= 1;
  expect(() => read(crc)).toThrow();
  const length = Buffer.from(image); length.writeUInt32BE(0xffffffff, 8);
  expect(() => read(length)).toThrow();
  expect(() => read(Buffer.concat([image, Buffer.from('extra')]))).toThrow();
  const parts = chunks(image); parts.splice(1, 0, parts[0]);
  expect(() => read(assemble(parts))).toThrow();
});

test('retains dimension, color/depth, compression, filter and interlace limits with valid CRCs', () => {
  for (const change of [data => data.writeUInt32BE(2201, 0), data => data.writeUInt32BE(0, 4),
    data => { data[8] = 4; data[9] = 2; }, data => { data[9] = 1; },
    data => { data[10] = 1; }, data => { data[11] = 1; }, data => { data[12] = 2; }]) {
    const parts = chunks(image).map(part => ({ ...part, data: Buffer.from(part.data) }));
    change(parts[0].data); expect(() => read(assemble(parts))).toThrow();
  }
});

test('rejects missing, duplicate, late or oversized palettes and invalid transparency', () => {
  const variants = [];
  let parts = chunks(minimal(3, 1)); variants.push(parts.filter(part => part.type !== 'PLTE'));
  parts = chunks(minimal(3, 1)); parts.splice(2, 0, parts[1]); variants.push(parts);
  parts = chunks(minimal(3, 1)); parts[1].data = Buffer.alloc(9); variants.push(parts);
  parts = chunks(minimal(3, 1)); parts[2].data = Buffer.alloc(2); variants.push(parts);
  parts = chunks(minimal(3, 1)); parts.splice(3, 0, parts[2]); variants.push(parts);
  parts = chunks(minimal(3, 1)); parts.splice(1, 1); parts.splice(3, 0, { type: 'PLTE', data: Buffer.alloc(3) }); variants.push(parts);
  parts = chunks(minimal(0, 8)); parts.splice(1, 0, { type: 'PLTE', data: Buffer.alloc(3) }); variants.push(parts);
  parts = chunks(minimal(6, 8)); parts.splice(1, 0, { type: 'tRNS', data: Buffer.alloc(6) }); variants.push(parts);
  for (const variant of variants) expect(() => read(assemble(variant))).toThrow();
});

test('rejects noncontiguous IDAT chunks before metadata stripping', () => {
  const parts = chunks(image);
  const data = parts[1].data;
  parts.splice(1, 1, { type: 'IDAT', data: data.subarray(0, 10) },
    { type: 'tEXt', data: Buffer.from('note\0test') }, { type: 'IDAT', data: data.subarray(10) });
  expect(() => read(assemble(parts))).toThrow();
});

test.each([[0, 1, 2], [2, 8, 6]])('validates transparency samples for color %s depth %s', (color, depth, length) => {
  const parts = chunks(minimal(color, depth));
  const transparency = Buffer.alloc(length); transparency.writeUInt16BE(2 ** depth - 1);
  parts.splice(1, 0, { type: 'tRNS', data: transparency });
  expect(read(assemble(parts))).toEqual(assemble(parts));
  transparency.writeUInt16BE(2 ** depth);
  expect(() => read(assemble(parts))).toThrow();
});
