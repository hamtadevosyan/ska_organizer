const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const db = require('./dbAdapter');
const auth = require('../auth/service');
const runtime = require('./localAiRuntime');
const transport = require('./activityMediaTransport');
const png = require('./activityMediaPng');
const { fieldError } = require('./catalogValidation');

const jobs = new Map();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MODEL = 'sd_xl_base_1.0.safetensors';
const DAY = 86400000, MAX_JOB_MS = 45 * 60000;
const busy = () => Object.assign(runtime.issue('AI_BUSY', 'Another AI request is running. Try again shortly.'), { status: 429, retryAfter: 5 });
const unavailable = () => runtime.issue('AI_IMAGES_UNAVAILABLE', 'Activity illustrations are unavailable. Keep the written activity and try again later.');
// Worker diagnostics are a fixed protocol, never exception text, paths, prompts
// or arbitrary messages supplied by the laptop.
const imageFailures = Object.freeze({
  IMAGE_STARTUP_TIMEOUT: 'The image process did not become ready in time. Check the image worker on the AI laptop before retrying.',
  IMAGE_CUDA: 'The image process could not use its NVIDIA GPU. Check the image runtime on the AI laptop.',
  IMAGE_OOM: 'The image process ran out of memory. Close other GPU work on the AI laptop before retrying.',
  IMAGE_PROCESS: 'The image process stopped before finishing. Check the image worker on the AI laptop.',
  IMAGE_WORKFLOW: 'The image process could not accept this illustration. Keep the written activity and try again later.',
  IMAGE_RESPONSE: 'The image process returned an unusable result. Keep the written activity and try again later.',
  IMAGE_TIMEOUT: 'The illustration took too long. Keep the written activity and try again later.',
  IMAGE_RUNTIME: 'The managed image runtime needs attention on the AI laptop.',
  IMAGE_UNAVAILABLE: 'The installed image model or runtime is unavailable. Check the image worker setup on the AI laptop.',
  IMAGE_RUNTIME_TIMEOUT: 'The image runtime did not finish its startup check in time. Check the AI laptop before retrying.',
  IMAGE_CONNECTION: 'The image process stopped responding. Check the image worker on the AI laptop before retrying.',
  IMAGE_CONTAINMENT: 'The image process could not start safely. Check the image worker setup on the AI laptop.',
  IMAGE_GENERATION: 'The image process could not finish this illustration. Keep the written activity and try again later.',
  IMAGE_INVALID: 'An illustration could not be verified. Keep the written activity and try again later.',
  IMAGE_DIRECTORY: 'The image worker could not access its private job storage. Check the AI laptop.',
  IMAGE_NOT_STARTED: 'The image request could not start. Check the image worker on the AI laptop before retrying.',
  IMAGE_INCOMPLETE: 'The image worker did not finish every illustration. Keep the written activity and try again later.',
  IMAGE_CLEANUP: 'Stopping the image process could not be confirmed. Restart the SKAO Activity Images worker on the AI laptop before using AI again.',
  WORKER_RESTARTED: 'The AI worker restarted during the image request. Create the illustrations again.',
  WORKER_RESTART_REQUIRED: 'The private AI worker needs to be restarted on the AI laptop before using AI again.',
  AI_BUSY: 'The AI machine was busy before picture generation could start. Wait for its current work to finish before retrying.',
  IMAGE_GENERATION_FAILED: 'Illustrations could not be completed. Keep the written activity and check the AI laptop before retrying.',
});
function imageFailure(result) {
  const code = typeof result?.code === 'string' && Object.hasOwn(imageFailures, result.code) ? result.code : 'IMAGE_GENERATION_FAILED';
  return { code, message: imageFailures[code] };
}
const notFound = () => auth.problem('Illustration not found.', 404, 'ACTIVITY_IMAGE_NOT_FOUND');
const fingerprint = (name, description) => createHash('sha256').update(JSON.stringify([name.trim(), description.trim()])).digest('hex');
const illustration = row => Object.fromEntries(['id', 'step', 'caption', 'width', 'height'].map(key => [key, row[key]]));
const plain = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<[^>]*>|https?:\/\/|www\.|data:|javascript:|!\[|\]\(/i.test(value);
function values(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['name', 'description', 'steps'].includes(key)) ||
    !plain(payload.name, 100) || !plain(payload.description, 4000) || !Array.isArray(payload.steps) || payload.steps.length < 1 || payload.steps.length > 6 ||
    payload.steps.some(step => !plain(step, 500)) || new Set(payload.steps.map(step => step.trim())).size !== payload.steps.length) {
    throw fieldError('illustrations', 'Use an activity name, description and one to six different brief steps.');
  }
  return { name: payload.name.trim(), description: payload.description.trim(), steps: payload.steps.map(step => step.trim()) };
}
async function actor(token, write = true) {
  const account = await auth.sessionAccount(token, { touch: true });
  auth.operationalPermission(account, write);
  if (!['admin', 'editor'].includes(account.role)) throw auth.problem('Use your assigned class to view activity illustrations.', 403, 'CLASSROOM_ONLY');
  return account;
}
const dto = job => ({ id: job.id, status: job.status, completed: job.images.length, total: job.steps.length,
  images: job.images.map(image => ({ ...image })), ...(job.message ? { message: job.message } : {}), ...(job.code ? { code: job.code } : {}) });
function pruneJobs() {
  for (const [id, job] of jobs) if (job.finishedAt && Date.now() - job.finishedAt > DAY) jobs.delete(id);
  while (jobs.size >= 32) {
    const done = [...jobs.values()].filter(job => job.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt)[0];
    if (!done) throw busy();
    jobs.delete(done.id);
  }
}
async function remote(config, method, path, value, signal, binary = false) {
  return runtime.limited(config, { signal }, requestSignal => transport.request(config, method, path, value, requestSignal, binary), 30000);
}
async function status(options = {}) {
  const config = runtime.configuration();
  if (!config) return { enabled: false, available: false, busy: false, model: null, message: 'Set up the private AI connection before generating illustrations.' };
  try {
    const result = await remote(config, 'GET', '/api/activity-images/status', undefined, options.signal);
    if (result?.version !== 1 || typeof result.enabled !== 'boolean' || typeof result.available !== 'boolean' || typeof result.busy !== 'boolean' ||
      (result.model !== null && result.model !== MODEL)) throw unavailable();
    const restartRequired = result.code === 'WORKER_RESTART_REQUIRED';
    return { enabled: result.enabled, available: result.available, busy: result.busy,
      ...(restartRequired ? { code: result.code } : {}), model: result.model,
      message: restartRequired ? imageFailures.WORKER_RESTART_REQUIRED : !result.available ? 'The activity image worker is unavailable. Check its setup on the AI laptop.' :
        result.busy ? 'Another AI request is running. Try again shortly.' : 'Private activity illustrations are ready.' };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error.workerCode === 'WORKER_RESTART_REQUIRED') return { enabled: true, available: false, busy: false, model: null,
      code: error.workerCode, message: imageFailures.WORKER_RESTART_REQUIRED };
    return { enabled: true, available: false, busy: false, model: null, message: 'Activity illustrations are unavailable. Written activities remain available.' };
  }
}
function verifyJob(result, job) {
  if (!result || result.version !== 1 || result.id !== job.id || !['running', 'complete', 'failed', 'cancelled'].includes(result.status) ||
    result.total !== job.steps.length || !Number.isInteger(result.completed) || result.completed < 0 || result.completed > job.steps.length ||
    !Array.isArray(result.frames) || result.frames.length !== result.completed) throw unavailable();
  const seen = new Set();
  for (const frame of result.frames) {
    if (!frame || !Number.isInteger(frame.step) || frame.step < 1 || frame.step > job.steps.length || seen.has(frame.step) ||
      frame.caption !== job.steps[frame.step - 1] || !/^[a-f0-9]{64}$/.test(frame.sha256 || '') ||
      !Number.isInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > 8 * 1024 * 1024 ||
      !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 1024 || !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 1024) throw unavailable();
    seen.add(frame.step);
  }
  if (result.status === 'complete' && result.completed !== job.steps.length) throw unavailable();
  return result;
}
async function cancelRemote(config, job) {
  // A known idempotency ID lets cancellation find a job even when POST's reply
  // was lost. Use a fresh deadline after the caller's operation was aborted.
  const signal = AbortSignal.timeout(60000);
  try {
    const response = await remote(config, 'DELETE', '/api/activity-images/jobs/' + job.id, undefined, signal);
    // A cancellation arriving before its POST may install an empty tombstone.
    // Accept only this exact acknowledgement here, never as normal job output.
    if (response?.version === 1 && response.id === job.id && response.status === 'cancelled' &&
      response.total === 0 && response.completed === 0 && Array.isArray(response.frames) && response.frames.length === 0) return { stopped: true };
    let result = verifyJob(response, job);
    while (result.status === 'running') {
      await delay(1000, undefined, { signal, ref: false });
      result = verifyJob(await remote(config, 'GET', '/api/activity-images/jobs/' + job.id, undefined, signal), job);
    }
    if (result.status === 'failed' && ['IMAGE_CLEANUP', 'WORKER_RESTART_REQUIRED'].includes(result.code)) return { stopped: false, failure: imageFailure(result) };
    return { stopped: true };
  } catch { return { stopped: false }; }
}
async function perform(config, job, started) {
  let workerAccepted = false;
  const timeout = setTimeout(() => job.controller.abort(runtime.issue('AI_IMAGES_TIMEOUT', 'Illustrations took too long. Keep the written activity and try again later.')), MAX_JOB_MS);
  timeout.unref();
  try {
    job.controller.signal.throwIfAborted();
    const first = await remote(config, 'POST', '/api/activity-images/jobs', { name: job.name, steps: job.steps, requestId: job.id }, job.controller.signal);
    let result = verifyJob(first, job); workerAccepted = true;
    started.resolve(dto(job));
    while (true) {
      job.controller.signal.throwIfAborted();
      // Recheck session/role/work state throughout a background job. Never write
      // a result after checkout, role removal or session revocation.
      const account = await actor(job.token);
      if (account.id !== job.ownerAccountId) throw notFound();
      if (result.status === 'failed') throw Object.assign(unavailable(), { imageFailure: imageFailure(result) });
      if (result.status === 'cancelled') { job.status = 'cancelled'; job.message = 'Illustration generation was cancelled.'; break; }
      for (const frame of result.frames.slice().sort((a, b) => a.step - b.step)) {
        if (job.images.some(image => image.step === frame.step)) continue;
        const original = await remote(config, 'GET', '/api/activity-images/jobs/' + job.id + '/frames/' + frame.step, undefined, job.controller.signal, true);
        if (original.length !== frame.byteLength || createHash('sha256').update(original).digest('hex') !== frame.sha256) throw unavailable();
        const file = png.normalize(original);
        if (file.width !== frame.width || file.height !== frame.height) throw unavailable();
        const saved = await db.withAuthLock(async () => {
          const current = await actor(job.token); job.controller.signal.throwIfAborted();
          if (current.id !== job.ownerAccountId) throw notFound();
          return db.createActivityMedia({ id: randomUUID(), ownerAccountId: current.id, fingerprint: job.fingerprint,
            step: frame.step, caption: frame.caption, ...file, claimed: false,
            createdAt: new Date(), expiresAt: new Date(Date.now() + DAY) });
        });
        job.images.push(illustration(saved));
      }
      if (result.status === 'complete') { job.status = 'complete'; job.message = 'Review every illustration before saving the activity.'; break; }
      await delay(1000, undefined, { signal: job.controller.signal, ref: false });
      result = verifyJob(await remote(config, 'GET', '/api/activity-images/jobs/' + job.id, undefined, job.controller.signal), job);
    }
  } catch (error) {
    const wasCancelled = job.controller.signal.aborted && job.controller.signal.reason?.code !== 'AI_IMAGES_TIMEOUT';
    const cleanup = await cancelRemote(config, job);
    job.status = wasCancelled && cleanup.stopped ? 'cancelled' : 'failed';
    const failure = cleanup.failure || error.imageFailure || (error.workerCode === 'WORKER_RESTART_REQUIRED' ? imageFailure({ code: error.workerCode }) : null) || (error.code === 'AI_IMAGES_TIMEOUT' ? { code: error.code, message: error.message } :
      { code: 'AI_IMAGES_UNAVAILABLE', message: 'Illustrations could not be completed. Keep the written activity and check the AI laptop before retrying.' });
    job.message = job.status === 'cancelled' ? 'Illustration generation was cancelled.' : failure.message;
    if (job.status === 'failed') job.code = failure.code;
    // Do not attach partial results from a failed or cancelled attempt.
    job.images = [];
    if (!workerAccepted) started.reject(error?.code === 'AI_BUSY' ? error : error.workerCode === 'WORKER_RESTART_REQUIRED'
      ? runtime.issue('AI_WORKER_RESTART_REQUIRED', imageFailures.WORKER_RESTART_REQUIRED) : unavailable());
  } finally {
    clearTimeout(timeout); job.finishedAt = Date.now(); job.token = undefined;
  }
}
async function createJob(token, payload, options = {}) {
  const input = values(payload), account = await actor(token), config = runtime.configuration();
  if (!config) throw runtime.issue('AI_IMAGES_NOT_CONFIGURED', 'Set up the private AI connection before generating illustrations.');
  pruneJobs();
  await db.withAuthLock(async () => {
    await actor(token);
    // Only never-attached expired previews are eligible. Claimed media remains
    // immutable forever, including historical saved-plan illustrations.
    await db.deleteExpiredActivityMedia(new Date());
    const owner = await db.activityMediaUsage(account.id), all = await db.activityMediaUsage();
    if (owner.count + input.steps.length > 12 || owner.bytes > 64 * 1024 * 1024 || all.count + input.steps.length > 48 || all.bytes > 128 * 1024 * 1024) {
      throw runtime.issue('AI_IMAGES_PREVIEW_LIMIT', 'Save the illustrations you want to keep, or wait for unused previews to expire after 24 hours before generating more.');
    }
  });
  const job = { ...input, id: randomUUID(), ownerAccountId: account.id, token, fingerprint: fingerprint(input.name, input.description),
    controller: new AbortController(), status: 'running', images: [], createdAt: Date.now() };
  if (options.signal?.aborted) throw options.signal.reason;
  const abort = () => job.controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  jobs.set(job.id, job);
  let resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  job.task = runtime.generate(() => perform(config, job, { resolve, reject })).catch(error => {
    jobs.delete(job.id); reject(error);
  }).finally(() => options.signal?.removeEventListener('abort', abort));
  return ready;
}
async function ownedJob(token, id) {
  if (!UUID.test(id || '')) throw notFound();
  const account = await actor(token), job = jobs.get(id);
  if (!job || job.ownerAccountId !== account.id || (job.finishedAt && Date.now() - job.finishedAt > DAY)) throw notFound();
  return job;
}
async function getJob(token, id) { return dto(await ownedJob(token, id)); }
async function cancelJob(token, id) {
  const job = await ownedJob(token, id);
  if (!job.finishedAt) { job.message = 'Cancelling illustration generation…'; job.controller.abort(); }
  return dto(job);
}
async function content(token, id) {
  if (!UUID.test(id || '')) throw notFound();
  return db.withAuthLock(async () => {
    const account = await actor(token, false), row = await db.getActivityMedia(id);
    if (!row || !((row.ownerAccountId === account.id && (row.claimed || new Date(row.expiresAt).getTime() > Date.now())) || await db.activityMediaAttached(id))) throw notFound();
    return { ...await db.getActivityMediaContent(id), filename: 'activity-step-' + row.step + '.png' };
  });
}
async function classroomContent(token, id) {
  if (!UUID.test(id || '')) throw notFound();
  return require('./classroomService').withScope(token, async scope => {
    if (!scope.room || !await db.activityMediaInRoom(id, scope.room.id)) throw notFound();
    const row = await db.getActivityMediaContent(id);
    if (!row) throw notFound();
    return { ...row, filename: 'activity-step-' + row.step + '.png' };
  });
}
async function resolveIllustrations(list, { account, previous, name, description }) {
  const expected = fingerprint(name, description), images = [], seen = new Set();
  for (const item of list || []) {
    const row = await db.getActivityMedia(item.id);
    const existing = previous?.illustrations?.some(image => image.id === item.id);
    if (!row || (!existing && (!account || row.ownerAccountId !== account.id || (!row.claimed && new Date(row.expiresAt).getTime() <= Date.now()))) || row.fingerprint !== expected || seen.has(row.step)) {
      throw fieldError('illustrations', 'The illustrations no longer match these activity details. Remove them or generate new illustrations before saving.');
    }
    seen.add(row.step); images.push(illustration(row));
  }
  return images.sort((a, b) => a.step - b.step);
}
async function shutdown() {
  for (const job of jobs.values()) if (!job.finishedAt) job.controller.abort();
  await Promise.all([...jobs.values()].map(job => job.task));
  jobs.clear();
}
module.exports = { status, createJob, getJob, cancelJob, content, classroomContent, resolveIllustrations, fingerprint, shutdown };
