exports.up = async ({ sequelize, schema, transaction, DataTypes: T }) => {
  const qi = sequelize.getQueryInterface();
  const table = { tableName: 'Activities', schema };
  // Existing catalog activities receive an empty list. Saved schedule snapshots
  // remain unchanged and readers treat an absent tutorialLinks field as empty.
  await qi.addColumn(table, 'tutorialLinks', { type: T.JSONB, allowNull: false, defaultValue: [] }, { transaction });
  const quoted = qi.queryGenerator.quoteTable(table);
  await sequelize.query(`ALTER TABLE ${quoted} ADD CONSTRAINT activity_tutorial_links_array
    CHECK (CASE WHEN jsonb_typeof("tutorialLinks") = 'array' THEN jsonb_array_length("tutorialLinks") <= 3 ELSE false END)`, { transaction });
};
