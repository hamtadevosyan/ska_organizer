// server/middleware/validate.js
const Joi = require('joi');

const checkinSchema = Joi.object({
  childId: Joi.string().trim().required(),
  roomId: Joi.string().trim().required(),
  recordedBy: Joi.string().trim().optional()
});

const childSchema = Joi.object({
  firstName: Joi.string().trim().required(),
  lastName: Joi.string().trim().required(),
  dateOfBirth: Joi.date().iso().optional(),
  preferredName: Joi.string().trim().optional().allow(''),
  photoConsent: Joi.boolean().optional(),
  notes: Joi.string().trim().optional().allow('')
});

exports.validateCheckin = (req, res, next) => {
  const { error } = checkinSchema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ error: 'Invalid request', details: error.details.map(d => d.message) });
  next();
};

exports.validateChild = (req, res, next) => {
  const { error } = childSchema.validate(req.body, { abortEarly: false, convert: true });
  if (error) return res.status(400).json({ error: 'Invalid child payload', details: error.details.map(d => d.message) });
  next();
};
