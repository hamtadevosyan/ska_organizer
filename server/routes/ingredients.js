const express = require("express");
const router = express.Router();
const ingredientsController = require("../controllers/ingredientsController");

router.get("/", ingredientsController.listIngredients);
router.post("/", ingredientsController.createIngredient);

router.put("/:id", ingredientsController.updateIngredient);
router.delete("/:id", ingredientsController.archiveIngredient);

module.exports = router;
