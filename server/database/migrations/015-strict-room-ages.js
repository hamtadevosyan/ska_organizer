// Do not rewrite published migration 005 or guess existing rooms' intended ages.
// NOT VALID preserves legacy rows while enforcing the rule on every new insert
// and update. Correct legacy ranges through Edit room, retaining IDs/history.
exports.up = async ({ sequelize, schema, transaction }) => {
  const table = sequelize.getQueryInterface().queryGenerator.quoteTable({ tableName: 'Rooms', schema });
  await sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT "room_age_range_strict"
    CHECK (
      (NOT "active" AND "ageMinMonths" IS NULL AND "ageMaxMonths" IS NULL AND "capacity" IS NULL)
      OR ("ageMinMonths" IS NOT NULL AND "ageMaxMonths" IS NOT NULL
        AND "ageMinMonths" >= 0 AND "ageMaxMonths" > "ageMinMonths" AND "ageMaxMonths" <= 216)
    ) NOT VALID`, { transaction });
};
