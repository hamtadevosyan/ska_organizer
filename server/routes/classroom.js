const express = require('express');
const auth = require('../auth/service');
const classroom = require('../services/classroomService');
const router = express.Router();
const care = require('../services/teacherCareService');
for (const [method, path, action] of [
  ['get', '/attendance', (req) => care.roster(req.sessionToken, req.query)],
  ['get', '/children/:childId/safety', (req) => care.safety(req.sessionToken, req.params.childId, req.query)],
  ['post', '/children/:childId/checkin', (req) => care.checkIn(req.sessionToken, req.params.childId, req.body, req.query)],
  ['post', '/attendance/:id/checkout', (req) => care.checkOut(req.sessionToken, req.params.id, req.body, req.query)],
]) router[method](path, async (req, res, next) => {
  try { res.json({ data: await action(req) }); } catch (error) { next(error); }
});
router.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next(auth.problem('Class information is read-only.', 403, 'CLASSROOM_READ_ONLY'));
  next();
});
for (const [path, method] of [['/', 'overview'], ['/children', 'children'], ['/activities', 'activities'], ['/meals', 'meals']]) {
  router.get(path, async (req, res, next) => {
    try { res.json({ data: await classroom[method](req.sessionToken, req.query) }); }
    catch (error) { next(error); }
  });
}
module.exports = router;
