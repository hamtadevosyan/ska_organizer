const { parentPort, workerData } = require('node:worker_threads');
const { preparePixels } = require('./recipeImagePixels');

try {
  const image = preparePixels(Buffer.from(workerData));
  parentPort.postMessage({ image }, [image.buffer]);
} catch {
  parentPort.postMessage({ invalid: true });
}
