const router = require('express').Router({ mergeParams: true });
const safety = require('../services/childSafetyService');
const auth = require('../auth/service');
router.use((req, res, next) => Object.keys(req.query).length ? next(auth.problem('The safety card does not accept filters.')) : next());
router.get('/', async (req, res, next) => {
  try { res.json({ data: await safety.read(req.sessionToken, req.params.childId) }); } catch (error) { next(error); }
});
router.put('/', async (req, res, next) => {
  try { res.json({ data: await safety.save(req.sessionToken, req.params.childId, req.body) }); } catch (error) { next(error); }
});
module.exports = router;
