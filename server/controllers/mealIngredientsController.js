const mealIngredientsService = require("../services/mealIngredientsService");

exports.listMealIngredients = async (req, res, next) => {
  try {
    const { mealId } = req.params;

    const items = await mealIngredientsService.listMealIngredients(mealId);
    res.json({ data: items });
  } catch (err) {
    next(err);
  }
};

exports.addMealIngredient = async (req, res, next) => {
  try {
    const { mealId } = req.params;
    const { ingredientId, quantity } = req.body;

    if (!ingredientId || quantity === undefined) {
      return res.status(400).json({
        error: { message: "ingredientId and quantity are required" }
      });
    }

    const item = await mealIngredientsService.addMealIngredient(mealId, {
      ingredientId,
      quantity
    });

    res.status(201).json({ data: item });
  } catch (err) {
    next(err);
  }
};

exports.updateMealIngredient = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (quantity === undefined || Number(quantity) <= 0) {
      return res.status(400).json({
        error: { message: "quantity must be greater than 0" }
      });
    }

    const updated = await mealIngredientsService.updateMealIngredient(id, {
      quantity: Number(quantity)
    });

    if (!updated) {
      return res.status(404).json({
        error: { message: "Meal ingredient not found" }
      });
    }

    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
};

exports.deleteMealIngredient = async (req, res, next) => {
  try {
    const { id } = req.params;

    const deleted = await mealIngredientsService.deleteMealIngredient(id);

    if (!deleted) {
      return res.status(404).json({
        error: { message: "Meal ingredient not found" }
      });
    }

    res.json({ data: { deleted: true, id } });
  } catch (err) {
    next(err);
  }
};
