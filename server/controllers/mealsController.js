const mealsService = require("../services/mealsService");

exports.listMeals = async (req, res, next) => {
  try {
    const meals = await mealsService.listMeals({
      type: req.query.type
    });

    res.json({ data: meals });
  } catch (err) {
    next(err);
  }
};

exports.createMeal = async (req, res, next) => {
  try {
    const { name, type, description } = req.body;

    if (!name || !type) {
      return res.status(400).json({
        error: { message: "name and type are required" }
      });
    }

    const meal = await mealsService.createMeal({
      name,
      type,
      description
    });

    res.status(201).json({ data: meal });
  } catch (err) {
    next(err);
  }
};
