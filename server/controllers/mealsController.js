const service = require('../services/mealsService');
exports.listMeals = async (req, res, next) => {
  try { res.json({ data: await service.listMeals({
    type: req.query.type, includeArchived: req.query.includeArchived === 'true',
  }) }); } catch (error) { next(error); }
};
exports.createMeal = async (req, res, next) => {
  try { res.status(201).json({ data: await service.createMeal(req.body) }); } catch (error) { next(error); }
};
exports.updateMeal = async (req, res, next) => {
  try { res.json({ data: await service.updateMeal(req.params.id, req.body) }); } catch (error) { next(error); }
};
exports.archiveMeal = async (req, res, next) => {
  try { res.json({ data: await service.updateMeal(req.params.id, { archived: true }) }); } catch (error) { next(error); }
};
