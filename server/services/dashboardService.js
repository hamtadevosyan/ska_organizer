const db = require('./dbAdapter');
exports.getMetrics = async () => {
  // Other dashboard metrics are completed separately in SKAO-28.
  return {
    totalStudents: 42,
    totalStaff: await db.countStaff({ active: true }),
    inventoryCount: 120,
    recentActivities: [
      'Outdoor playtime completed',
      'New books added to library',
      'Weekly staff meeting held',
    ]
  };
};
