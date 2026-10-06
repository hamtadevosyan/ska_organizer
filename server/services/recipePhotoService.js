const { spawn } = require('node:child_process');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 24000;
const problem = (message, status, code) => Object.assign(new Error(message), { status, code });
let processing = false;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function imageBuffer(body) {
  if (!body || Object.keys(body).some(key => key !== 'image') || typeof body.image !== 'string' ||
      body.image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image)) {
    throw problem('Choose one recipe image under 5 MB after resizing.', 400, 'INVALID_RECIPE_IMAGE');
  }
  const image = Buffer.from(body.image, 'base64');
  if (image.length > MAX_IMAGE_BYTES || image.length < 45 || image.toString('base64') !== body.image ||
      !image.subarray(0, 8).equals(pngSignature)) {
    throw problem('Choose a readable recipe photo using the image picker.', 400, 'INVALID_RECIPE_IMAGE');
  }
  // Browser PNG encoders differ: Safari may include an ICC profile, and valid
  // PNGs can be grayscale, palette-based or interlaced. Validate the bounded
  // container, retain only rendering data and drop all other ancillary chunks
  // without decompressing metadata. No paths, URLs or OCR options are input.
  let offset = 8, data = false, dataEnded = false, ended = false;
  let color, depth, palette = 0, transparency = false;
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const retained = [pngSignature];
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset), type = image.toString('latin1', offset + 4, offset + 8);
    const end = offset + length + 12;
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || end > image.length ||
        image.readUInt32BE(end - 4) !== crc32(image.subarray(offset + 4, end - 4)) ||
        (offset === 8 && type !== 'IHDR')) break;
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) break;
      const width = image.readUInt32BE(offset + 8), height = image.readUInt32BE(offset + 12);
      depth = image[offset + 16]; color = image[offset + 17];
      if (!width || !height || width > 2200 || height > 2200 || !depths[color]?.includes(depth) ||
          image[offset + 18] || image[offset + 19] || image[offset + 20] > 1) break;
    } else if (type === 'PLTE') {
      if (data || palette || transparency || [0, 4].includes(color) || !length || length % 3 || length > 768 ||
          (color === 3 && length / 3 > 2 ** depth)) break;
      palette = length / 3;
    } else if (type === 'tRNS') {
      if (data || transparency || !((color === 0 && length === 2) || (color === 2 && length === 6) ||
          (color === 3 && palette && length > 0 && length <= palette))) break;
      if (color !== 3 && Array.from({ length: length / 2 }, (_, index) =>
        image.readUInt16BE(offset + 8 + index * 2)).some(value => value >= 2 ** depth)) break;
      transparency = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) break;
      data = true;
    } else if (type === 'IEND') {
      ended = length === 0 && data && end === image.length;
      if (!ended) break;
    } else {
      // Unknown critical chunks and animations are rejected, not handed to the
      // decoder. Profiles, EXIF and text are ancillary and can be omitted.
      if (!/^[a-z]/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type)) break;
    }
    if (data && type !== 'IDAT') dataEnded = true;
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) retained.push(image.subarray(offset, end));
    offset = end;
    if (ended) break;
  }
  if (!ended || !data) throw problem('This image could not be read. Choose it again or use a JPEG or PNG photo.', 400, 'INVALID_RECIPE_IMAGE');
  return Buffer.concat(retained);
}

async function readRecipePhoto(body, { signal } = {}) {
  const image = imageBuffer(body);
  if (processing) throw problem('Another recipe photo is being read. Try again in a moment.', 429, 'RECIPE_PHOTO_BUSY');
  if (signal?.aborted) throw problem('Photo reading was cancelled.', 400, 'RECIPE_PHOTO_CANCELLED');
  processing = true;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '3'], {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      });
      let output = '', bytes = 0, failure;
      const stop = error => { failure ||= error; child.kill('SIGKILL'); };
      const abort = () => stop(problem('Photo reading was cancelled.', 400, 'RECIPE_PHOTO_CANCELLED'));
      const timer = setTimeout(() => stop(problem('Reading took too long. Try a closer, clearer photo of one recipe.', 422, 'RECIPE_PHOTO_TIMEOUT')), 30000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_TEXT_BYTES) stop(problem('The image contains too much text. Photograph one recipe at a time.', 422, 'RECIPE_PHOTO_TOO_MUCH_TEXT'));
        else output += chunk.toString('utf8');
      });
      child.stdin.on('error', () => {}); // A failed/aborted child can close stdin early.
      child.on('error', error => {
        failure = error.code === 'ENOENT'
          ? problem('Recipe photo reading is not installed on this server. Ask your administrator to run the recipe OCR setup script.', 503, 'RECIPE_OCR_UNAVAILABLE')
          : problem('Recipe photo reading is temporarily unavailable. Try again.', 503, 'RECIPE_OCR_UNAVAILABLE');
      });
      child.on('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failure) return reject(failure);
        if (code !== 0) return reject(problem('Could not read this photo. Try a clear, upright JPEG or PNG of printed English text.', 422, 'RECIPE_PHOTO_UNREADABLE'));
        const text = output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
        if (!/[a-zA-Z]{2}/.test(text)) return reject(problem('No readable recipe text was found. Try better lighting and photograph the written recipe close up.', 422, 'RECIPE_PHOTO_EMPTY'));
        resolve({ text });
      });
      child.stdin.end(image);
    });
  } finally { processing = false; }
}

module.exports = { readRecipePhoto, imageBuffer };
