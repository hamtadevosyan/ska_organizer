const { audited } = require('../auth/middleware');
const express = require("express");
const router = express.Router();
const ingredientsController = require("../controllers/ingredientsController");

router.get("/", ingredientsController.listIngredients);
router.post("/", audited('ingredient.create', ingredientsController.createIngredient));

router.put("/:id", audited('ingredient.update', ingredientsController.updateIngredient));
router.delete("/:id", audited('ingredient.archive', ingredientsController.archiveIngredient));

module.exports = router;
