// server/controllers/menuController.js
const menuService = require("../services/menuService");

exports.confirmWeeklyMenu = async (req, res, next) => {
  try {
    const { week } = req.body;

    if (!week || !Array.isArray(week)) {
      return res.status(400).json({
        error: { message: "Invalid menu format" }
      });
    }

    const saved = await menuService.confirmWeeklyMenu({ week });
    res.json({ data: saved });
  } catch (err) {
    next(err);
  }
};

exports.generateWeeklyMenu = async (req, res, next) => {
  try {
    const result = await menuService.generateWeeklyMenu();
    res.json({ data: result });
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
