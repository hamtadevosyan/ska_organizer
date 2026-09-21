exports.up = async ({ sequelize, schema, transaction, DataTypes }) => {
  const qi = sequelize.getQueryInterface();
  const table = { tableName: 'ScheduleEntries', schema };
  const options = { transaction };
  await qi.addColumn(table, 'startTime', { type: DataTypes.STRING(5) }, options);
  await qi.addColumn(table, 'endTime', { type: DataTypes.STRING(5) }, options);
  await qi.changeColumn(table, 'timeBlock', { type: DataTypes.STRING, allowNull: true }, options);
  // Earlier blocks did not record clock times. Keep them unchanged and visibly
  // untimed until a teacher supplies the times; never invent a daily routine.
  await sequelize.query(`ALTER TABLE "${schema}"."ScheduleEntries"
    ADD CONSTRAINT schedule_entry_times_check CHECK (
      ("startTime" IS NULL AND "endTime" IS NULL AND "timeBlock" IS NOT NULL) OR
      ("startTime" IS NOT NULL AND "endTime" IS NOT NULL AND "timeBlock" IS NULL AND
       "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND
       ("endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR "endTime" = '24:00') AND
       "endTime" > "startTime"))`, options);
  await sequelize.query(`ALTER TABLE "${schema}"."Activities"
    DROP CONSTRAINT activities_duration_check,
    ADD CONSTRAINT activities_duration_check CHECK ("durationMinutes" BETWEEN 1 AND 1440)`, options);
};
