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
      type: DataTypes.STRING, // morning | midday | afternoon
      allowNull: false
    },
    activityId: {
      type: DataTypes.STRING,
      allowNull: false
    }
  }, {
    timestamps: true
  });

  return ScheduleEntry;
};

