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
