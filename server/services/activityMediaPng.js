const { PNG } = require('pngjs');
const { createHash } = require('node:crypto');
const { issue } = require('./localAiRuntime');
const invalid = () => issue('AI_IMAGES_INVALID', 'An illustration could not be read safely. Keep the written activity and try again.');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Bound the raster before invoking the decoder. pngjs checks chunk CRCs and
// compressed raster length; reencoding pixels drops prompts and other metadata.
function normalize(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 45 || buffer.length > 8 * 1024 * 1024 || !buffer.subarray(0, 8).equals(signature)) throw invalid();
    if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw invalid();
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 1024 || height > 1024 || buffer[24] !== 8 || ![2, 6].includes(buffer[25]) || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] !== 0) throw invalid();
    let cursor = 8, ended = false;
    while (cursor < buffer.length) {
      if (cursor + 12 > buffer.length) throw invalid();
      const length = buffer.readUInt32BE(cursor), type = buffer.toString('ascii', cursor + 4, cursor + 8);
      if (!/^[A-Za-z]{4}$/.test(type) || length > 8 * 1024 * 1024 || cursor + length + 12 > buffer.length || type === 'acTL' ||
        (type === 'IHDR' && cursor !== 8) || crc32(buffer.subarray(cursor + 4, cursor + length + 8)) !== buffer.readUInt32BE(cursor + length + 8)) throw invalid();
      cursor += length + 12;
      if (type === 'IEND') { if (length !== 0 || cursor !== buffer.length) throw invalid(); ended = true; break; }
    }
    if (!ended) throw invalid();
    const decoded = PNG.sync.read(buffer, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) throw invalid();
    const content = PNG.sync.write({ width, height, data: decoded.data }, { colorType: 6, inputColorType: 6, bitDepth: 8, deflateLevel: 6 });
    return { content, width, height, contentType: 'image/png', byteLength: content.length,
      sha256: createHash('sha256').update(content).digest('hex') };
  } catch { throw invalid(); }
}
module.exports = { normalize };
