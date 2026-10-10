const childProcess = require('node:child_process');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const validation = require('./childDocumentValidation');
const { imageBuffer } = require('./recipePhotoService');
const recipeImage = require('./recipeImage');

const MAX_TEXT_BYTES = 24000;
const DEADLINE_MS = 30000;
const problem = (message, status, code) => auth.problem(message, status, 'STAFF_DOCUMENT_OCR_' + code);
const cancelled = () => problem('Document reading was cancelled. Enter the expiration date yourself.', 400, 'CANCELLED');
const timedOut = () => problem('Reading took too long. Enter the expiration date yourself.', 422, 'TIMEOUT');
let reserved = false;
let processing = false;

// Reserve before buffering the larger JSON body. A disconnected request retains
// its slot until its worker and OCR process have actually stopped.
exports.reserve = (req, res, next) => {
  if (reserved) return res.status(429).set('Retry-After', '5').json({ error: {
    message: 'Another employee document is being read. Try again in a moment or enter the date yourself.',
    code: 'STAFF_DOCUMENT_OCR_BUSY',
  } });
  reserved = true;
  let released = false;
  const release = () => {
    if (released || req.staffDocumentOcrProcessing) return;
    released = true; reserved = false;
    res.off('finish', release); res.off('close', release);
  };
  req.releaseStaffDocumentOcrSlot = release;
  res.once('finish', release); res.once('close', release); next();
};

const access = (token, staffId, fn = () => {}) => db.withAuthLock(async () => {
  const actor = await auth.administrator(token);
  validation.identifier(staffId, 'employee');
  if (!await db.getStaffById(staffId)) throw auth.problem('Employee not found.', 404, 'STAFF_NOT_FOUND');
  return fn(actor);
});

function validatedImage(body) {
  // Reuse only the bounded PNG-container validator, which removes ancillary
  // profiles and metadata. No recipe endpoint, parser or catalog is involved.
  try { return imageBuffer(body); }
  catch { throw problem('Choose one readable document image under 5 MB after resizing.', 400, 'INVALID_IMAGE'); }
}

function recognition(image, remaining, signal) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11', '--dpi', '300'], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    });
    let output = '', bytes = 0, failure;
    const stop = (error) => { failure ||= error; child.kill('SIGKILL'); };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(timedOut()), remaining);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_TEXT_BYTES) stop(problem('This image contains too much text. Enter the expiration date yourself.', 422, 'TOO_MUCH_TEXT'));
      else output += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      // Optional local OCR can be unavailable while the application is healthy.
      // A manual-entry response must not announce a whole-server 503 outage.
      failure ||= problem('Local document reading is unavailable. Enter the expiration date yourself.', 422, 'UNAVAILABLE');
    });
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(problem('This image could not be read. Enter the expiration date yourself.', 422, 'UNREADABLE'));
      // Keep line breaks for date labels, while discarding terminal/control text.
      const text = output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
      resolve({ text });
    });
    if (signal?.aborted) abort();
    else child.stdin.end(image);
  });
}

exports.checkExpiration = async (token, staffId, body, { signal, query = {} } = {}) => {
  await access(token, staffId);
  validation.object(query, [], 'document reading');
  const image = validatedImage(body);
  if (processing) throw problem('Another employee document is being read. Try again in a moment.', 429, 'BUSY');
  if (signal?.aborted) throw cancelled();
  processing = true;
  const started = Date.now();
  try {
    let prepared;
    try { prepared = await recipeImage.prepareRecipeImage(image, { signal, timeout: DEADLINE_MS }); }
    catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error.code === 'RECIPE_PHOTO_TIMEOUT') throw timedOut();
      throw problem('This image could not be prepared. Enter the expiration date yourself.', 422, 'UNREADABLE');
    }
    if (signal?.aborted) throw cancelled();
    const remaining = DEADLINE_MS - (Date.now() - started);
    if (remaining <= 0) throw timedOut();
    const result = await recognition(prepared, remaining, signal);
    if (signal?.aborted) throw cancelled();
    // Never retain AuthLock during OCR. Recheck permissions and the employee
    // before returning sensitive recognized text; audit only the action and ID.
    await access(token, staffId, (actor) => auth.audit(actor, 'staff_document.expiration_check', staffId));
    if (signal?.aborted) throw cancelled();
    return result;
  } finally { processing = false; }
};
