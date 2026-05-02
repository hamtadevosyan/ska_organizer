// server/controllers/shelfController.js
const shelfService = require("../services/shelfService");

exports.saveShelfCheck = async (req, res, next) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        error: { message: "Invalid shelf data" }
      });
    }

    const saved = await shelfService.saveShelfCheck(items);

    res.json({ data: saved });
  } catch (err) {
    next(err);
  }
};

exports.generateFinalShoppingList = async (req, res, next) => {
  try {
    const list = await shelfService.generateFinalShoppingList();

    res.json({ data: list });
  } catch (err) {
    next(err);
  }
};
