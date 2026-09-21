// server/models/activity.js
module.exports = (sequelize, DataTypes) => {
  const Activity = sequelize.define('Activity', {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: DataTypes.TEXT,
    category: DataTypes.STRING,              // foundational | thematic
    repeatWindowWeeks: DataTypes.INTEGER,    // how long before repeating
    type: DataTypes.STRING,                  // math, literacy, art, etc.
    location: DataTypes.STRING,              // indoor | outdoor
    ageMin: DataTypes.INTEGER,
    ageMax: DataTypes.INTEGER,
    ageMinMonths: DataTypes.INTEGER,
    ageMaxMonths: DataTypes.INTEGER,
    durationMinutes: DataTypes.INTEGER,
    materials: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    energyLevel: DataTypes.STRING,           // low | medium | high
    estimatedCost: DataTypes.FLOAT,
    materialsLinks: DataTypes.JSON,          // array of URLs
    materialsNotes: DataTypes.TEXT,
    roomId: DataTypes.STRING,
    startTime: DataTypes.DATE,
    endTime: DataTypes.DATE
  }, {
    timestamps: true
  });

  return Activity;
};
