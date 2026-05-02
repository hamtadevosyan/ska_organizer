// server/controllers/menuController.js
const menuService = require("../services/menuService");

exports.generateWeeklyMenu = async (req, res, next) => {
  try {
    const week = await menuService.generateWeeklyMenu();
    res.json({ data: { week } });
  } catch (err) {
    next(err);
  }
};

exports.confirmWeeklyMenu = async (req, res, next) => {
  try {
    const { week } = req.body;

    if (!Array.isArray(week)) {
      return res.status(400).json({
        error: { message: "Invalid payload: expected { week: [] }" }
      });
    }

    const saved = await menuService.confirmWeeklyMenu({ week });
    res.json({ data: saved });
  } catch (err) {
    next(err);
  }
};

exports.getCurrentMenu = async (req, res, next) => {
  try {
    const menu = await menuService.getCurrentMenu();
    res.json({ data: menu });
  } catch (err) {
    next(err);
  }
};
