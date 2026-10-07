const { deflateSync } = require('node:zlib');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'latin1');
  const bytes = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, bytes, suffix]);
}
function chunks(image) {
  const result = [];
  for (let offset = 8; offset + 12 <= image.length;) {
    const length = image.readUInt32BE(offset);
    result.push({ type: image.toString('latin1', offset + 4, offset + 8), data: image.subarray(offset + 8, offset + length + 8) });
    offset += length + 12;
  }
  return result;
}
const assemble = (parts) => Buffer.concat([signature, ...parts.map(({ type, data }) => chunk(type, data))]);
function metadata(image) {
  const parts = chunks(image);
  parts.splice(1, 0,
    { type: 'iCCP', data: Buffer.concat([Buffer.from('Browser profile\0\0'), deflateSync(Buffer.from('Synthetic private profile'))]) },
    { type: 'cICP', data: Buffer.from([1, 13, 0, 1]) },
    { type: 'eXIf', data: Buffer.from('Synthetic private EXIF') },
    { type: 'tEXt', data: Buffer.from('Private note\0Synthetic private recipe metadata') });
  return assemble(parts);
}
function minimal(color = 6, depth = 8, interlace = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color] || 1;
  const parts = [{ type: 'IHDR', data: header }];
  if (color === 3) parts.push({ type: 'PLTE', data: Buffer.from([0, 0, 0]) }, { type: 'tRNS', data: Buffer.from([255]) });
  parts.push({ type: 'IDAT', data: deflateSync(Buffer.alloc(1 + Math.ceil(channels * depth / 8))) }, { type: 'IEND', data: Buffer.alloc(0) });
  return assemble(parts);
}
module.exports = { chunk, chunks, assemble, metadata, minimal };
