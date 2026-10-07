const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deflateSync } = require('node:zlib');
const { PNG } = require('pngjs');
const { prepareRecipeImage } = require('../services/recipeImage');
const { preparePixels } = require('../services/recipeImagePixels');
const { imageBuffer } = require('../services/recipePhotoService');
const { chunks, assemble, minimal } = require('./helpers/pngFixture');
const fixture = name => readFileSync(path.join(__dirname, 'fixtures', name));

test('local lighting correction recovers all seven ingredients with global thresholding', async () => {
  const original = fixture('recipe-photo-shadow.png'), before = Buffer.from(original);
  const prepared = await prepareRecipeImage(original);
  expect(original.equals(before)).toBe(true);
  const width = original.readUInt32BE(16), height = original.readUInt32BE(20);
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`);
  expect(prepared.subarray(0, header.length).equals(header)).toBe(true);
  expect(prepared.length).toBe(header.length + width * height);
  // The owner's missing milk/butter/egg result is reproducible with global
  // thresholding on the untreated fixture. Require this mode explicitly so
  // a locally available adaptive setting cannot hide the regression.
  const result = spawnSync('tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11', '--dpi', '300', '-c', 'thresholding_method=0'], {
    input: prepared, encoding: 'utf8', timeout: 30000,
    maxBuffer: 512 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const text = result.stdout.normalize('NFKC').toLowerCase();
  const missing = ['flour', 'baking powder', 'white sugar', 'salt', 'milk', 'butter', 'egg'].filter(name => !text.includes(name));
  expect({ missing, recognized: result.stdout }).toEqual({ missing: [], recognized: result.stdout });
}, 40000);

test.each(['recipe-photo.png', 'recipe-photo-palette.png'])('decodes %s with the same source geometry', async name => {
  const original = fixture(name);
  const prepared = await prepareRecipeImage(imageBuffer({ image: original.toString('base64') }));
  expect(prepared.subarray(0, 40).toString('ascii')).toMatch(new RegExp(`^P5\n${original.readUInt32BE(16)} ${original.readUInt32BE(20)}\n255\n`));
});

test.each([0, 1])('accepts valid 16-bit RGBA pixels with interlace=%i', interlace => {
  expect(preparePixels(minimal(6, 16, interlace))).toEqual(Buffer.concat([Buffer.from('P5\n1 1\n255\n'), Buffer.from([255])]));
});

test('transparent pixels become white and a mostly-dark page keeps its text', () => {
  const png = new PNG({ width: 20, height: 20 });
  for (let pixel = 0; pixel < 400; pixel++) {
    png.data.set([0, 0, 0, 255], pixel * 4);
  }
  png.data.set([255, 255, 255, 255], 44 * 4);
  png.data.set([0, 0, 0, 0], 45 * 4);
  const prepared = preparePixels(PNG.sync.write(png));
  const pixels = prepared.subarray(Buffer.byteLength('P5\n20 20\n255\n'));
  expect(pixels[0]).toBe(0); expect(pixels[44]).toBe(255); expect(pixels[45]).toBe(255);
});

test.each([0, 1])('rejects oversized inflated scanlines before decoding, including interlace=%i', async interlace => {
  const parts = chunks(minimal(6, 8, interlace));
  parts.find(part => part.type === 'IDAT').data = deflateSync(Buffer.alloc(1024 * 1024));
  const image = imageBuffer({ image: assemble(parts).toString('base64') });
  const decode = jest.spyOn(PNG.sync, 'read');
  try {
    expect(() => preparePixels(image)).toThrow();
    expect(decode).not.toHaveBeenCalled();
  } finally { decode.mockRestore(); }
  await expect(prepareRecipeImage(image)).rejects.toMatchObject({ status: 400, code: 'INVALID_RECIPE_IMAGE' });
});

test('malformed compressed pixels return a safe image error', async () => {
  const parts = chunks(minimal());
  parts.find(part => part.type === 'IDAT').data = Buffer.from('not compressed pixels');
  const image = imageBuffer({ image: assemble(parts).toString('base64') });
  await expect(prepareRecipeImage(image)).rejects.toMatchObject({ status: 400, code: 'INVALID_RECIPE_IMAGE' });
});

test('cancelling preparation terminates its worker and allows the next photo', async () => {
  const image = fixture('recipe-photo-shadow.png');
  const controller = new AbortController();
  const result = prepareRecipeImage(image, { signal: controller.signal });
  const rejected = expect(result).rejects.toMatchObject({ code: 'RECIPE_PHOTO_CANCELLED' });
  controller.abort();
  await rejected;
  await expect(prepareRecipeImage(image, { signal: controller.signal })).rejects.toMatchObject({ code: 'RECIPE_PHOTO_CANCELLED' });
  await expect(prepareRecipeImage(minimal())).resolves.toBeInstanceOf(Buffer);
});

test('preparation timeout terminates its worker and allows the next photo', async () => {
  await expect(prepareRecipeImage(fixture('recipe-photo-shadow.png'), { timeout: 0 })).rejects.toMatchObject({ code: 'RECIPE_PHOTO_TIMEOUT' });
  await expect(prepareRecipeImage(minimal())).resolves.toBeInstanceOf(Buffer);
});
