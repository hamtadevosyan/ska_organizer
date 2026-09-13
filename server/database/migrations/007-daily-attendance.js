module.exports = {
  async up({ sequelize, schema, transaction, DataTypes: T }) {
    const qi = sequelize.getQueryInterface();
    const table = (tableName) => ({ tableName, schema });
    const attendance = qi.queryGenerator.quoteTable(table('Attendances'));
    for (const [name, definition] of Object.entries({
      version: { type: T.INTEGER, allowNull: false, defaultValue: 1 },
      voided: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
      needsReview: { type: T.BOOLEAN, allowNull: false, defaultValue: false },
      requestId: { type: T.STRING(100), allowNull: true },
    })) await qi.addColumn(table('Attendances'), name, definition, { transaction });
    // Preserve legacy visits, including duplicates. An operator must reconcile them;
    // migration never invents a departure time or deletes an attendance record.
    await sequelize.query(`UPDATE ${attendance} SET "needsReview" = true WHERE "checkIn" IS NULL OR
      "checkOut" < "checkIn" OR ("checkOut" IS NULL AND "childId" IN
      (SELECT "childId" FROM ${attendance} WHERE "checkOut" IS NULL GROUP BY "childId" HAVING COUNT(*) > 1))`, { transaction });
    await sequelize.query(`CREATE UNIQUE INDEX "attendance_one_open_visit" ON ${attendance} ("childId")
      WHERE "checkOut" IS NULL AND NOT "voided" AND NOT "needsReview"`, { transaction });
    await qi.addIndex(table('Attendances'), ['requestId'], { unique: true, name: 'attendance_request_id', transaction });
    await qi.addIndex(table('Attendances'), ['roomId', 'checkIn'], { name: 'attendance_room_checkin', transaction });
    await qi.addIndex(table('Attendances'), ['childId', 'checkIn'], { name: 'attendance_child_checkin', transaction });
    await sequelize.query(`ALTER TABLE ${attendance} ADD CONSTRAINT "attendance_times_valid"
      CHECK ("voided" OR "needsReview" OR ("checkIn" IS NOT NULL AND ("checkOut" IS NULL OR "checkOut" >= "checkIn"))) NOT VALID`, { transaction });
    await qi.createTable(table('AttendanceCorrections'), {
      id: { type: T.STRING, primaryKey: true, allowNull: false },
      attendanceId: { type: T.STRING, allowNull: false, references: { model: table('Attendances'), key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
      before: { type: T.JSONB, allowNull: false }, after: { type: T.JSONB, allowNull: false },
      reason: { type: T.STRING(1000), allowNull: false },
      actorId: { type: T.STRING, allowNull: false }, actorUsername: { type: T.STRING(64), allowNull: false },
      occurredAt: { type: T.DATE, allowNull: false },
    }, { transaction });
    await qi.addIndex(table('AttendanceCorrections'), ['attendanceId', 'occurredAt'], { name: 'attendance_corrections_history', transaction });
  },
};
