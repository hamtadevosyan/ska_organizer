const { Worker } = require('node:worker_threads');
const path = require('node:path');
const problem = (message, status, code) => Object.assign(new Error(message), { status, code });

function prepareRecipeImage(image, { signal, timeout = 30000 } = {}) {
  if (signal?.aborted) return Promise.reject(problem('Photo reading was cancelled.', 400, 'RECIPE_PHOTO_CANCELLED'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'recipeImageWorker.js'), {
      workerData: image, resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(Buffer.from(result));
    };
    const abort = () => finish(problem('Photo reading was cancelled.', 400, 'RECIPE_PHOTO_CANCELLED'));
    const timer = setTimeout(() => finish(problem('Reading took too long. Try a closer, clearer photo of one recipe.', 422, 'RECIPE_PHOTO_TIMEOUT')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', result => result.invalid
      ? finish(problem('This image could not be read. Choose it again or use a JPEG or PNG photo.', 400, 'INVALID_RECIPE_IMAGE'))
      : finish(null, result.image));
    worker.once('error', () => finish(problem('Recipe photo reading is temporarily unavailable. Try again.', 503, 'RECIPE_OCR_UNAVAILABLE')));
    worker.once('exit', () => { if (!settled) finish(problem('Could not prepare this photo. Try a clear, upright photo.', 422, 'RECIPE_PHOTO_UNREADABLE')); });
  });
}

module.exports = { prepareRecipeImage };
