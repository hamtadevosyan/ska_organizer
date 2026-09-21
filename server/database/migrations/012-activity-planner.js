exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  const qi = sequelize.getQueryInterface();
  const table = (tableName) => ({ tableName, schema });
  const options = { transaction };
  for (const [name, definition] of Object.entries({
    durationMinutes: { type: DataTypes.INTEGER },
    ageMinMonths: { type: DataTypes.INTEGER }, ageMaxMonths: { type: DataTypes.INTEGER },
    materials: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  })) await qi.addColumn(table('Activities'), name, definition, options);
  // Earlier activities used whole years. Preserve the original columns and
  // import only valid ranges; no duration or material amounts are invented.
  await sequelize.query(`UPDATE "${schema}"."Activities"
    SET "ageMinMonths" = "ageMin" * 12, "ageMaxMonths" = "ageMax" * 12
    WHERE "ageMin" >= 0 AND "ageMax" > "ageMin" AND "ageMax" <= 18`, options);
  await sequelize.query(`ALTER TABLE "${schema}"."Activities"
    ADD CONSTRAINT activities_duration_check CHECK ("durationMinutes" BETWEEN 1 AND 480),
    ADD CONSTRAINT activities_age_months_check CHECK (
      ("ageMinMonths" IS NULL AND "ageMaxMonths" IS NULL) OR
      ("ageMinMonths" IS NOT NULL AND "ageMaxMonths" IS NOT NULL AND
       "ageMinMonths" >= 0 AND "ageMaxMonths" > "ageMinMonths" AND "ageMaxMonths" <= 216)),
    ADD CONSTRAINT activities_materials_check CHECK (jsonb_typeof("materials") = 'array'),
    ADD CONSTRAINT activities_version_check CHECK ("version" > 0)`, options);
  await qi.addColumn(table('ScheduleEntries'), 'activitySnapshot', { type: DataTypes.JSONB }, options);
  await qi.createTable(table('ScheduleWeeks'), {
    roomId: { type: DataTypes.STRING, primaryKey: true, allowNull: false,
      references: { model: table('Rooms'), key: 'id' }, onDelete: 'RESTRICT' },
    weekStart: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    savedAt: { type: DataTypes.DATE, allowNull: false },
    requestId: { type: DataTypes.STRING(100) }, request: { type: DataTypes.JSONB },
  }, options);
  await sequelize.query(`ALTER TABLE "${schema}"."ScheduleWeeks"
    ADD CONSTRAINT schedule_weeks_version_check CHECK ("version" > 0),
    ADD CONSTRAINT schedule_weeks_monday_check CHECK (EXTRACT(ISODOW FROM "weekStart") = 1)`, options);
  await sequelize.query(`UPDATE "${schema}"."ScheduleEntries" AS s SET "activitySnapshot" = jsonb_build_object(
    'id', a."id", 'name', a."name", 'description', COALESCE(a."description", ''),
    'durationMinutes', a."durationMinutes", 'ageMinMonths', a."ageMinMonths", 'ageMaxMonths', a."ageMaxMonths",
    'roomId', a."roomId", 'materials', a."materials", 'version', a."version")
    FROM "${schema}"."Activities" AS a WHERE a."id" = s."activityId"`, options);
  await sequelize.query(`INSERT INTO "${schema}"."ScheduleWeeks" ("roomId", "weekStart", "version", "savedAt")
    SELECT "roomId", date_trunc('week', "date"::timestamp)::date, 1, COALESCE(MAX("updatedAt"), MAX("createdAt"), CURRENT_TIMESTAMP)
    FROM "${schema}"."ScheduleEntries" GROUP BY "roomId", date_trunc('week', "date"::timestamp)::date`, options);
};
