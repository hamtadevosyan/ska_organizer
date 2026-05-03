const express = require("express");
const router = express.Router();
const ingredientsController = require("../controllers/ingredientsController");

router.get("/", ingredientsController.listIngredients);
router.post("/", ingredientsController.createIngredient);

module.exports = router;
