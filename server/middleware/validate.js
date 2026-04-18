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
  endTime: Joi.string().isoDate().optional(),
  category: Joi.string().valid('foundational', 'thematic').required(),
  repeatWindowWeeks: Joi.number().integer().min(1).required(),
  type: Joi.string().required(),
  location: Joi.string().valid('indoor', 'outdoor').required(),
  ageMin: Joi.number().integer().min(0).max(10).required(),
  ageMax: Joi.number().integer().min(0).max(10).required(),
  energyLevel: Joi.string().valid('low', 'medium', 'high').required(),
  estimatedCost: Joi.number().min(0).optional(),
  materialsLinks: Joi.array().items(Joi.string().uri()).optional(),
  materialsNotes: Joi.string().allow('').optional(),
  roomId: Joi.string().optional(),
  startTime: Joi.date().iso().optional(),
  endTime: Joi.date().iso().optional()
});

exports.validateActivity = (req, res, next) => {
  const { error } = activitySchema.validate(req.body, { abortEarly: false });
  console.log("VALIDATION ERROR:", error?.details);
  if (error) return res.status(400).json({ error: 'Invalid activity payload', details: error.details.map(d => d.message) });
  next();
};

