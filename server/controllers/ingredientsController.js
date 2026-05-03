const ingredientsService = require("../services/ingredientsService");

exports.listIngredients = async (req, res, next) => {
  try {
    const ingredients = await ingredientsService.listIngredients();
    res.json({ data: ingredients });
  } catch (err) {
    next(err);
  }
};

exports.createIngredient = async (req, res, next) => {
  try {
    const { name, unit, shelfLifeDays } = req.body;

    if (!name || !unit) {
      return res.status(400).json({
        error: { message: "name and unit are required" }
      });
    }

    const ingredient = await ingredientsService.createIngredient({
      name,
      unit,
      shelfLifeDays
    });

    res.status(201).json({ data: ingredient });
  } catch (err) {
    next(err);
  }
};
