// server/controllers/menuController.js
const menuService = require("../services/menuService");
const generator = require("../services/menuService");

exports.confirmWeeklyMenu = async (req, res, next) => {
  try {
    const { week } = req.body;

    if (!week || !Array.isArray(week)) {
      return res.status(400).json({ error: "Invalid menu format" });
    }

    const saved = await menuService.confirmWeeklyMenu(week);
    res.json({ success: true, saved });
  } catch (err) {
    next(err);
  }
};

exports.getCurrentMenu = async (req, res, next) => {
  try {
    const menu = await menuService.getCurrentMenu();
    res.json({ menu });
  } catch (err) {
    next(err);
  }
};

exports.generateWeeklyMenu = async (req, res, next) => {
  try {
    const week = await menuService.generateWeeklyMenu();
    res.json({ week });
  } catch (err) {
    next(err);
  }
};

