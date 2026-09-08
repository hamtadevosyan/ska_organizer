const service = require('../services/ingredientsService');
exports.listIngredients = async (req, res, next) => {
  try { res.json({ data: await service.listIngredients({
    type: req.query.type, includeArchived: req.query.includeArchived === 'true',
  }) }); } catch (error) { next(error); }
};
exports.createIngredient = async (req, res, next) => {
  try { res.status(201).json({ data: await service.createIngredient(req.body) }); } catch (error) { next(error); }
};
exports.updateIngredient = async (req, res, next) => {
  try { res.json({ data: await service.updateIngredient(req.params.id, req.body) }); } catch (error) { next(error); }
};
exports.archiveIngredient = async (req, res, next) => {
  try { res.json({ data: await service.updateIngredient(req.params.id, { archived: true }) }); } catch (error) { next(error); }
};
