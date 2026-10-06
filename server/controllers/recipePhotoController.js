const service = require('../services/recipePhotoService');

// Reserve before the larger JSON parser so only one photo request is buffered
// at a time per server process. Ordinary API requests keep their 100 KB limit.
let reading = false;
exports.reserve = (req, res, next) => {
  if (reading) return res.status(429).set('Retry-After', '5').json({ error: { message: 'Another recipe photo is being read. Try again in a moment.', code: 'RECIPE_PHOTO_BUSY' } });
  reading = true;
  const release = () => { reading = false; res.off('finish', release); res.off('close', release); };
  res.once('finish', release); res.once('close', release);
  next();
};
exports.read = async (req, res, next) => {
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', cancel);
  try {
    const data = await service.readRecipePhoto(req.body, { signal: controller.signal });
    if (!res.destroyed) res.json({ data });
  } catch (error) {
    if (res.destroyed) return;
    if (error.code?.startsWith('RECIPE_') || error.code === 'INVALID_RECIPE_IMAGE') {
      if (error.status === 429) res.set('Retry-After', '5');
      return res.status(error.status).json({ error: { message: error.message, code: error.code } });
    }
    next(error);
  } finally { res.off('close', cancel); }
};
