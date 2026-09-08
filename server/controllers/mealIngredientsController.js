const service = require('../services/mealIngredientsService');
exports.listMealIngredients = async (req, res, next) => {
  try { res.json({ data: await service.listMealIngredients(req.params.mealId) }); } catch (error) { next(error); }
};
exports.addMealIngredient = async (req, res, next) => {
  try { res.status(201).json({ data: await service.addMealIngredient(req.params.mealId, req.body) }); } catch (error) { next(error); }
};
exports.updateMealIngredient = async (req, res, next) => {
  try { res.json({ data: await service.updateMealIngredient(req.params.id, req.body) }); } catch (error) { next(error); }
};
exports.deleteMealIngredient = async (req, res, next) => {
  try {
    await service.deleteMealIngredient(req.params.id);
    res.json({ data: { deleted: true, id: req.params.id } });
  } catch (error) { next(error); }
};
