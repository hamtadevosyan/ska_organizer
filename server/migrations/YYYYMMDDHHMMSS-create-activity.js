'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Activities', {
      id: {
        type: Sequelize.STRING,
        primaryKey: true
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description: Sequelize.TEXT,
      category: Sequelize.STRING,
      repeatWindowWeeks: Sequelize.INTEGER,
      type: Sequelize.STRING,
      location: Sequelize.STRING,
      ageMin: Sequelize.INTEGER,
      ageMax: Sequelize.INTEGER,
      energyLevel: Sequelize.STRING,
      estimatedCost: Sequelize.FLOAT,
      materialsLinks: Sequelize.JSON,
      materialsNotes: Sequelize.TEXT,
      roomId: Sequelize.STRING,
      startTime: Sequelize.DATE,
      endTime: Sequelize.DATE,

      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Activities');
  }
};

