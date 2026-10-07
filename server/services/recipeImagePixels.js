const { inflateSync } = require('node:zlib');
const { PNG } = require('pngjs');

// Check the exact scanline budget before pngjs decoding, including Adam7.
// pngjs's interlaced decoder otherwise inflates without a maximum output size.
function pixelBudget(image) {
  if (image.length < 45 || image.length > 5 * 1024 * 1024) throw new Error('Invalid image');
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  const depth = image[24], channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[image[25]];
  if (!width || !height || width > 2200 || height > 2200 || !channels || ![1, 2, 4, 8, 16].includes(depth) || image[28] > 1) throw new Error('Invalid image');
  const passes = image[28] ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const bytes = passes.reduce((sum, [x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return sum + (w && h ? (Math.ceil(w * channels * depth / 8) + 1) * h : 0);
  }, 0);
  const compressed = [];
  for (let offset = 8; offset + 12 <= image.length;) {
    const length = image.readUInt32BE(offset), end = offset + length + 12;
    if (end > image.length) throw new Error('Invalid image');
    if (image.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(image.subarray(offset + 8, end - 4));
    offset = end;
  }
  if (!compressed.length || inflateSync(Buffer.concat(compressed), { maxOutputLength: bytes }).length !== bytes) throw new Error('Invalid pixels');
  return { width, height };
}

// Separable sliding maxima: linear work, with only one small deque per axis.
function background(gray, width, height, radius) {
  const horizontal = new Uint8Array(gray.length), output = new Uint8Array(gray.length);
  const deque = new Int32Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    let head = 0, tail = 0, next = 0;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      while (next <= Math.min(width - 1, x + radius)) {
        while (tail > head && gray[row + deque[tail - 1]] <= gray[row + next]) tail--;
        deque[tail++] = next++;
      }
      while (deque[head] < x - radius) head++;
      horizontal[row + x] = gray[row + deque[head]];
    }
  }
  for (let x = 0; x < width; x++) {
    let head = 0, tail = 0, next = 0;
    for (let y = 0; y < height; y++) {
      while (next <= Math.min(height - 1, y + radius)) {
        while (tail > head && horizontal[deque[tail - 1] * width + x] <= horizontal[next * width + x]) tail--;
        deque[tail++] = next++;
      }
      while (deque[head] < y - radius) head++;
      output[y * width + x] = horizontal[deque[head] * width + x];
    }
  }
  return output;
}

// A small mean filter suppresses screen/camera moire before local contrast is
// increased. Work and memory remain linear in the bounded pixel count.
function smooth(gray, width, height) {
  const rows = new Uint16Array(gray.length), output = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) rows[row + x] = gray[row + Math.max(0, x - 1)] + gray[row + x] + gray[row + Math.min(width - 1, x + 1)];
  }
  for (let y = 0; y < height; y++) {
    const above = Math.max(0, y - 1) * width, row = y * width, below = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) output[row + x] = Math.round((rows[above + x] + rows[row + x] + rows[below + x]) / 9);
  }
  return output;
}

function preparePixels(image) {
  const { width, height } = pixelBudget(image);
  const decoded = PNG.sync.read(image, { checkCRC: true });
  if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) throw new Error('Invalid pixels');
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`);
  const pgm = Buffer.alloc(header.length + width * height);
  header.copy(pgm);
  const gray = pgm.subarray(header.length);
  const histogram = new Uint32Array(256);
  for (let pixel = 0; pixel < gray.length; pixel++) {
    const offset = pixel * 4, alpha = decoded.data[offset + 3] / 255;
    gray[pixel] = Math.round((decoded.data[offset] * 0.299 + decoded.data[offset + 1] * 0.587 + decoded.data[offset + 2] * 0.114) * alpha + 255 * (1 - alpha));
    histogram[gray[pixel]]++;
  }
  let count = 0, light = 0;
  for (; light < 255; light++) { count += histogram[light]; if (count >= gray.length * 0.75) break; }
  // Preserve mostly-dark pages for Tesseract's normal inversion handling.
  // White-paper photos with shadows get a flat local background, without
  // rotating, resizing or changing source-line coordinates.
  if (light >= 100) {
    const cleaned = smooth(gray, width, height);
    const radius = Math.max(8, Math.min(48, Math.round(Math.min(width, height) / 40)));
    const local = background(cleaned, width, height, radius);
    for (let pixel = 0; pixel < gray.length; pixel++) gray[pixel] = Math.min(255, Math.round(cleaned[pixel] * 255 / Math.max(local[pixel], 8)));
  }
  return pgm;
}

module.exports = { preparePixels };
