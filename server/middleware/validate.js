// server/middleware/validate.js
const Joi = require('joi');

const checkinSchema = Joi.object({
  childId: Joi.string().trim().required(),
  roomId: Joi.string().trim().required(),
  recordedBy: Joi.string().trim().optional()
});

exports.validateCheckin = (req, res, next) => {
  const { error } = checkinSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: 'Invalid request', details: error.details.map(d => d.message) });
  next();
};

