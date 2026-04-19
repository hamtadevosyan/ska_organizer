// server/controllers/shoppingController.js

const shoppingService = require("../services/shoppingService");

exports.generateShoppingList = async (req, res, next) => {
  try {
    const { childrenCount, staffCount } = req.body || {};

    const list = await shoppingService.generateShoppingList({
      childrenCount,
      staffCount
    });

    res.json({ list });
  } catch (err) {
    next(err);
  }
};

