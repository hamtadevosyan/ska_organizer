const { spawn } = require('node:child_process');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 24000;
const problem = (message, status, code) => Object.assign(new Error(message), { status, code });
let processing = false;

function imageBuffer(body) {
  if (!body || Object.keys(body).some(key => key !== 'image') || typeof body.image !== 'string' ||
      body.image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image)) {
    throw problem('Choose one recipe image under 5 MB after resizing.', 400, 'INVALID_RECIPE_IMAGE');
  }
  const image = Buffer.from(body.image, 'base64');
  if (image.length > MAX_IMAGE_BYTES || image.length < 45 || image.toString('base64') !== body.image ||
      !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw problem('Choose a readable recipe photo using the image picker.', 400, 'INVALID_RECIPE_IMAGE');
  }
  // Only bounded, non-interlaced, 8-bit RGB/RGBA PNGs produced by the browser's
  // canvas are accepted. No filenames, URLs, archives or OCR options are input.
  let offset = 8, data = false, ended = false;
  const allowed = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs']);
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset), type = image.toString('ascii', offset + 4, offset + 8);
    if (!allowed.has(type) || offset + length + 12 > image.length || (offset === 8 && type !== 'IHDR')) break;
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) break;
      const width = image.readUInt32BE(offset + 8), height = image.readUInt32BE(offset + 12);
      if (!width || !height || width > 2200 || height > 2200 || image[offset + 16] !== 8 ||
          ![2, 6].includes(image[offset + 17]) || image[offset + 18] || image[offset + 19] || image[offset + 20]) break;
    }
    if (type === 'IDAT') data = true;
    offset += length + 12;
    if (type === 'IEND') { ended = length === 0 && offset === image.length; break; }
  }
  if (!ended || !data) throw problem('This image could not be read. Choose it again or use a JPEG or PNG photo.', 400, 'INVALID_RECIPE_IMAGE');
  return image;
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
