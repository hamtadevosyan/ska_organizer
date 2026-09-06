// server/controllers/shoppingController.js

const shoppingService = require("../services/shoppingService");

exports.generateShoppingList = async (req, res, next) => {
  try {
    const { childrenCount, staffCount, week } = req.body || {};

    const list = await shoppingService.generateShoppingList({
      childrenCount,
      staffCount,
      week
    });

    res.json({ data: list });
  } catch (err) {
    next(err);
  }
};
