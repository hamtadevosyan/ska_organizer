module.exports = (sequelize, DataTypes) => {
  const ScheduleEntry = sequelize.define('ScheduleEntry', {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    roomId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    timeBlock: {
      type: DataTypes.STRING, // Retained only for schedules saved before timed entries.
      allowNull: true
    },
    startTime: DataTypes.STRING(5),
    endTime: DataTypes.STRING(5),
    activitySnapshot: DataTypes.JSONB,
    activityId: {
      type: DataTypes.STRING,
      allowNull: false
    }
  }, {
    timestamps: true
  });

  return ScheduleEntry;
};
