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

const childSchema = Joi.object({
  firstName: Joi.string().trim().required(),
  lastName: Joi.string().trim().required(),
  dateOfBirth: Joi.date().iso().optional(),
  preferredName: Joi.string().trim().optional().allow(''),
  photoConsent: Joi.boolean().optional(),
  notes: Joi.string().trim().optional().allow('')
});

exports.validateChild = (req, res, next) => {
  const { error } = childSchema.validate(req.body, { abortEarly: false, convert: true });
  if (error) return res.status(400).json({ error: 'Invalid child payload', details: error.details.map(d => d.message) });
  next();
};

const activitySchema = Joi.object({
  name: Joi.string().trim().required(),
  description: Joi.string().trim().optional().allow(''),
  roomId: Joi.string().trim().optional(),
  startTime: Joi.string().isoDate().optional(),
  endTime: Joi.string().isoDate().optional()
});

exports.validateActivity = (req, res, next) => {
  const { error } = activitySchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: 'Invalid activity payload', details: error.details.map(d => d.message) });
  next();
};

