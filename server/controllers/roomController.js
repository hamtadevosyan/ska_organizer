const attendanceService = require('../services/attendanceService');
const rooms = require('../services/roomService');
const { dateOnly } = require('../services/roomValidation');
const { problem } = require('../services/planValidation');

exports.list = async (req, res, next) => {
  try {
    if (req.query.includeArchived !== undefined && !['true', 'false'].includes(req.query.includeArchived)) throw problem('includeArchived must be true or false.');
    res.json({ data: await rooms.listRooms({ includeArchived: req.query.includeArchived === 'true' }) });
  } catch (error) { next(error); }
};
exports.get = async (req, res, next) => {
  try { res.json({ data: await rooms.getRoom(req.params.id) }); }
  catch (error) { next(error); }
};
exports.create = async (req, res, next) => {
  try { res.status(201).json({ data: await rooms.createRoom(req.body) }); }
  catch (error) { next(error); }
};
exports.update = async (req, res, next) => {
  try { res.json({ data: await rooms.updateRoom(req.params.id, req.body) }); }
  catch (error) { next(error); }
};
exports.assignmentPreview = async (req, res, next) => {
  try {
    if (typeof req.query.childId !== 'string' || !req.query.childId) throw problem('Choose a child to preview the assignment.');
    res.json({ data: await rooms.assignmentPreview(req.params.id, req.query.childId) });
  } catch (error) { next(error); }
};

exports.getPresentChildren = async (req, res, next) => {
  try {
    const roomId = req.params.roomId;
    const date = req.query.date;

    if (!date) {
      return res.status(400).json({ error: { message: 'date is required (YYYY-MM-DD)' } });
    }

    dateOnly(date);
    await rooms.requireRoom(roomId);
    const children = await attendanceService.getPresentChildrenForRoom(roomId, date);
    res.json(children);
  } catch (err) {
    next(err);
  }
};
